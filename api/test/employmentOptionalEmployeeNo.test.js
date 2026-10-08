const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { rolesFor, withDefaultReason } = require('./hrWrite');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { insertFixtureOrgUnit, insertFixturePosition } = require('./fixtures');

// PR-D3: หน้าจอ HR ไม่รู้เลขบัตร (employeeNo = pid) จึงส่ง employeeNo ไม่ได้ -> PUT employment / reactivate ให้ employeeNo ไม่บังคับ
// (คงเลขเดิมของ employment ล่าสุด) + effectiveFrom ก่อนวันที่มีผลของ employment ปัจจุบันต้อง 422 (เดิมหลุดเป็น 500) + maxLength

let ctx;
let adminPool;
let orgUnitId;
const SCOPE = 'personnel:read:basic personnel:write:employment';

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

const call = async (method, url, body) => {
  const token = await ctx.auth.signToken({ scope: SCOPE, roles: rolesFor(method, url) });
  return request(ctx.app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(withDefaultReason(method, url, body));
};

async function makePerson({ status = 'ACTIVE', employeeNo, effectiveFrom = '2024-01-01' } = {}) {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version, deleted_at)
     VALUES ($1, $2, $3, 'VERIFIED', 1, ${status === 'INACTIVE' ? 'now()' : 'NULL'})`,
    [personId, crypto.randomBytes(32).toString('hex'), status]
  );
  if (employeeNo) {
    await adminPool.query(
      `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
       VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, $5, $6, $7, 'test')`,
      [personId, employeeNo, await insertFixturePosition(adminPool, orgUnitId), orgUnitId, effectiveFrom, status === 'ACTIVE', status === 'ACTIVE' ? 'ACTIVE' : 'RESIGNED']
    );
  }
  return personId;
}

const currentEmployeeNo = async (personId) =>
  (await adminPool.query(`SELECT employee_no FROM mdm.employment WHERE person_id = $1 ORDER BY effective_from DESC, employment_id DESC LIMIT 1`, [personId])).rows[0]?.employee_no;

async function body(extra = {}) {
  return { expectedVersion: 1, personnelType: 'CIVIL_SERVANT', orgUnitId, positionId: await insertFixturePosition(adminPool, orgUnitId), effectiveFrom: '2026-01-01', ...extra };
}

describe('employeeNo ไม่บังคับ: คงเลขเดิม', () => {
  test('PUT employment ไม่ส่ง employeeNo -> 200 และ employee_no ของแถวใหม่เท่าเดิม', async () => {
    const employeeNo = `EMP-KEEP-${crypto.randomUUID()}`;
    const personId = await makePerson({ employeeNo });
    const res = await call('put', `/persons/${personId}/employment`, await body());
    expect(res.status).toBe(200);
    expect(await currentEmployeeNo(personId)).toBe(employeeNo);
  });

  test('reactivate ไม่ส่ง employeeNo -> 200 และคงเลขของ employment ล่าสุด', async () => {
    const employeeNo = `EMP-REACT-${crypto.randomUUID()}`;
    const personId = await makePerson({ status: 'INACTIVE', employeeNo });
    const res = await call('post', `/persons/${personId}/reactivate`, await body());
    expect(res.status).toBe(200);
    expect(await currentEmployeeNo(personId)).toBe(employeeNo);
  });

  test.each([
    ['put', (id) => `/persons/${id}/employment`, 'ACTIVE'],
    ['post', (id) => `/persons/${id}/reactivate`, 'INACTIVE'],
  ])('%s: บุคคลที่ไม่เคยมี employment และไม่ส่ง employeeNo -> 422 employee-no-required', async (method, url, status) => {
    const personId = await makePerson({ status });
    const res = await call(method, url(personId), await body());
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/employee-no-required$/);
  });
});

describe('effectiveFrom ก่อนวันที่มีผลของ employment ปัจจุบัน', () => {
  test('PUT employment -> 422 effective-from-before-current (ไม่ใช่ 500) และไม่เปลี่ยนข้อมูล', async () => {
    const employeeNo = `EMP-EF-${crypto.randomUUID()}`;
    const personId = await makePerson({ employeeNo, effectiveFrom: '2025-06-01' });
    const res = await call('put', `/persons/${personId}/employment`, await body({ effectiveFrom: '2025-01-01' }));
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/effective-from-before-current$/);
    const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM mdm.employment WHERE person_id = $1`, [personId]);
    expect(rows[0].n).toBe(1);
  });
});

describe('maxLength ใน OpenAPI -> 400 (ไม่ใช่ 500 จาก varchar เกิน)', () => {
  test.each([
    ['levelCode', 51],
    ['emailWork', 256],
    ['referenceDocument', 201],
    ['employeeNo', 256],
  ])('%s ยาว %i ตัวอักษร', async (field, length) => {
    const personId = await makePerson({ employeeNo: `EMP-LEN-${crypto.randomUUID()}` });
    const res = await call('put', `/persons/${personId}/employment`, await body({ [field]: 'x'.repeat(length) }));
    expect(res.status).toBe(400);
  });
});
