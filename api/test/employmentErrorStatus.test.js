const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit, insertFixturePosition } = require('./fixtures');
const { HttpProblem } = require('../src/security/httpProblem');
const { mapEmploymentConstraintError } = require('../src/services/employmentShared');

// ทุกเส้นทางที่เขียน employment ผ่าน closeAndOpenEmployment ตัวเดียวกัน (employmentShared.js) ต้องตอบ 4xx ที่ถูกต้อง
// เมื่อ orgUnitId/positionId ไม่มีจริง, personnelType ไม่มีจริง, หรือชนกับข้อมูลที่มีอยู่ (ตำแหน่งถูกครอง/เลขประจำตัวซ้ำ)
// - ก่อนแก้ 3 endpoint นี้ (provision, reactivate, resolve claim PROVISION) หลุดเป็น 500 เพราะไม่มี catch ครอบเรียก
// closeAndOpenEmployment (ต่างจาก PUT employment ที่มี catch อยู่แล้วแต่เหมารวมเป็น 409 ทุกกรณี)
//
// PERSONNEL_TYPE_INVALID (23503 บน employment_personnel_type_fkey) ตรวจแล้วว่า "ยิงไม่ถึง" ผ่าน HTTP endpoint ใดเลยในสภาพ
// ปัจจุบัน: PersonnelType schema ใน OpenAPI มี enum ครบ 10 ค่าตรงกับ mdm.personnel_type ทุกแถวพอดี (ดู
// personnelPositionRules.test.js: "ทุกโค้ดใน mdm.personnel_type จริงต้องมีกฎกำกับ") ค่าที่ไม่อยู่ใน enum จึงถูก
// express-openapi-validator ปฏิเสธด้วย 400 (enum.openapi.validation) ก่อนถึงโค้ดของเราเสมอ (ยืนยันด้วย debug จริง) -
// โค้ดที่แก้จึงเป็น defensive กันไว้เผื่อ enum กับตาราง mdm.personnel_type หลุดไม่ตรงกันในอนาคต (เช่น ลบโค้ดออกจากตาราง
// อ้างอิงแต่ยังไม่ได้ลบออกจาก OpenAPI) ทดสอบ 2 ชั้น: unit test เรียก mapEmploymentConstraintError ตรงๆ (ครอบโค้ดที่แก้จริง)
// + เทสต์ HTTP ยืนยันพฤติกรรมปัจจุบัน (400 จาก OpenAPI) กันไว้ไม่ให้ regress เงียบๆ ถ้าใครเผลอลบ enum ออก

let ctx;
let adminPool;
let pepper;
let orgUnitId;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await ctx.vault.getPepper();
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

const api = async (method, url, scope) => {
  const token = await ctx.auth.signToken({ scope });
  return { send: (body) => request(ctx.app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body) };
};

async function makePosition() {
  return insertFixturePosition(adminPool, orgUnitId);
}

async function makePerson(status = 'ACTIVE') {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version, deleted_at)
     VALUES ($1, $2, $3, 'VERIFIED', 1, ${status === 'INACTIVE' ? 'now()' : 'NULL'})`,
    [personId, crypto.randomBytes(32).toString('hex'), status]
  );
  return personId;
}

// สร้างบุคคล ACTIVE ที่ครองตำแหน่งอยู่จริง (is_current, ACTIVE, effective_to = NULL = ไม่มีวันสิ้นสุด) เพื่อทดสอบ
// DUPLICATE_POSITION (EXCLUDE constraint) และ DUPLICATE_EMPLOYEE_NO (partial unique บน employee_no WHERE is_current)
async function makeOccupant({ positionId, employeeNo }) {
  const personId = await makePerson();
  await adminPool.query(
    `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, employeeNo, positionId, orgUnitId]
  );
  return personId;
}

function baseEmployment(overrides = {}) {
  return {
    employeeNo: `EMP-ERR-${crypto.randomUUID()}`,
    personnelType: 'CIVIL_SERVANT',
    orgUnitId,
    effectiveFrom: '2024-01-01',
    ...overrides,
  };
}

// เตรียม employment body ที่จะชน error code แต่ละแบบ (เฉพาะ 4 แบบที่ยิงถึงจริงผ่าน HTTP - ดูหมายเหตุเรื่อง
// PERSONNEL_TYPE_INVALID ด้านบน) ทุกแบบต้องผ่าน assertPositionMatchesPersonnelType/assertJobTitleMatchesPersonnelType
// ก่อน (ไม่งั้นจะได้ 422 position-required/position-not-allowed/job-title-* แทน ซึ่งเป็นคนละบั๊กกับที่ทดสอบตรงนี้)
async function bodiesForEachCode() {
  const validPositionId = await makePosition();
  const occupiedPositionId = await makePosition();
  const dupEmployeeNo = `EMP-ERR-DUP-${crypto.randomUUID()}`;
  await makeOccupant({ positionId: occupiedPositionId, employeeNo: `EMP-ERR-OCC-${crypto.randomUUID()}` });
  await makeOccupant({ positionId: await makePosition(), employeeNo: dupEmployeeNo });

  return {
    ORG_UNIT_NOT_FOUND: {
      status: 422,
      type: 'org-unit-invalid',
      body: baseEmployment({ positionId: validPositionId, orgUnitId: crypto.randomUUID() }),
    },
    POSITION_NOT_FOUND: {
      status: 422,
      type: 'position-invalid',
      body: baseEmployment({ positionId: crypto.randomUUID() }),
    },
    DUPLICATE_POSITION: {
      status: 409,
      type: 'position-occupied',
      body: baseEmployment({ positionId: occupiedPositionId }),
    },
    DUPLICATE_EMPLOYEE_NO: {
      status: 409,
      type: 'employee-no-conflict',
      body: baseEmployment({ positionId: validPositionId, employeeNo: dupEmployeeNo }),
    },
  };
}

// codes ที่ยิงถึงจริงผ่าน HTTP (PERSONNEL_TYPE_INVALID ถูก OpenAPI enum กันไว้ก่อน - ทดสอบแยกด้านล่าง)
const HTTP_REACHABLE_CODES = ['ORG_UNIT_NOT_FOUND', 'POSITION_NOT_FOUND', 'DUPLICATE_POSITION', 'DUPLICATE_EMPLOYEE_NO'];
// ครบทั้ง 5 code ที่ mapEmploymentConstraintError ต้องรู้จัก (ใช้กับ unit test)
const ALL_CODES = [...HTTP_REACHABLE_CODES, 'PERSONNEL_TYPE_INVALID'];

describe('unit: mapEmploymentConstraintError คืน HttpProblem ที่มี .status/.type ถูกต้อง + คง .code ไว้ (5 code)', () => {
  test.each([
    ['23503', 'employment_position_id_fkey', 422, 'position-invalid', 'POSITION_NOT_FOUND'],
    ['23503', 'employment_org_unit_id_fkey', 422, 'org-unit-invalid', 'ORG_UNIT_NOT_FOUND'],
    ['23503', 'employment_personnel_type_fkey', 422, 'personnel-type-invalid', 'PERSONNEL_TYPE_INVALID'],
    ['23P01', 'employment_position_no_overlap_excl', 409, 'position-occupied', 'DUPLICATE_POSITION'],
    ['23505', 'employment_employee_no_current_uk', 409, 'employee-no-conflict', 'DUPLICATE_EMPLOYEE_NO'],
  ])('pg code=%s constraint=%s -> HttpProblem(%s, %s) พร้อม .code=%s', (pgCode, constraint, status, type, code) => {
    const pgError = Object.assign(new Error('pg error จำลอง'), { code: pgCode, constraint });
    const result = mapEmploymentConstraintError(pgError);
    expect(result).toBeInstanceOf(HttpProblem);
    expect(result.status).toBe(status);
    expect(result.type).toBe(type);
    expect(result.code).toBe(code);
  });

  test('error ที่ไม่ตรงกับ constraint ที่รู้จัก (เช่น 23503 บน constraint อื่น) ถูกส่งคืนตามเดิม (ไม่ห่อเป็น HttpProblem มั่ว)', () => {
    const pgError = Object.assign(new Error('อื่นๆ'), { code: '23503', constraint: 'some_other_fkey' });
    expect(mapEmploymentConstraintError(pgError)).toBe(pgError);
  });

  test('ทุก code ในตารางตรงกับ ALL_CODES ที่ทดสอบ end-to-end ด้านล่าง (กันลืมเพิ่มเคสเมื่อมี code ใหม่)', () => {
    expect(ALL_CODES.sort()).toEqual(
      ['ORG_UNIT_NOT_FOUND', 'POSITION_NOT_FOUND', 'PERSONNEL_TYPE_INVALID', 'DUPLICATE_POSITION', 'DUPLICATE_EMPLOYEE_NO'].sort()
    );
  });
});

describe('POST /persons (provision) - 4 error code ที่ยิงถึงจริงต้องตอบ 4xx ตามตาราง ไม่ใช่ 500', () => {
  test.each(HTTP_REACHABLE_CODES)('%s', async (code) => {
    const { status, type, body } = (await bodiesForEachCode())[code];
    const pid = makeFakePid();
    const res = await (await api('post', '/persons', 'personnel:read:basic personnel:provision')).send({
      pid,
      expectedFirstNameTh: 'ทดสอบ',
      expectedLastNameTh: 'สถานะ error',
      employment: body,
    });
    expect(res.status).toBe(status);
    expect(res.body.type).toMatch(new RegExp(`${type}$`));
    expect(res.body.status).toBe(status);
    // ผิดพลาดแล้วต้อง rollback ทั้งก้อน - ไม่มี person ค้างจาก pid นี้
    const { rows } = await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [pidHash(pid, pepper)]);
    expect(rows).toHaveLength(0);
  });

  test('PERSONNEL_TYPE_INVALID ยิงไม่ถึงโค้ดของเรา - OpenAPI enum ปฏิเสธด้วย 400 ก่อนเสมอ (ไม่ใช่ 500 เช่นกัน แต่คนละสาเหตุ)', async () => {
    const res = await (await api('post', '/persons', 'personnel:read:basic personnel:provision')).send({
      pid: makeFakePid(),
      expectedFirstNameTh: 'ทดสอบ',
      expectedLastNameTh: 'สถานะ error',
      employment: baseEmployment({ personnelType: 'NOT_A_REAL_PERSONNEL_TYPE' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /persons/{id}/reactivate - 4 error code ที่ยิงถึงจริงต้องตอบ 4xx ตามตาราง ไม่ใช่ 500', () => {
  test.each(HTTP_REACHABLE_CODES)('%s', async (code) => {
    const { status, type, body } = (await bodiesForEachCode())[code];
    const personId = await makePerson('INACTIVE');
    const res = await (await api('post', `/persons/${personId}/reactivate`, 'personnel:read:basic personnel:write:employment')).send(body);
    expect(res.status).toBe(status);
    expect(res.body.type).toMatch(new RegExp(`${type}$`));
    // ผิดพลาดแล้วบุคคลต้องยัง INACTIVE (ไม่ commit บางส่วน)
    const { rows } = await adminPool.query(`SELECT status FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(rows[0].status).toBe('INACTIVE');
  });
});

describe('POST /claim-requests/{id}/resolve (action=PROVISION) - 4 error code ที่ยิงถึงจริงต้องตอบ 4xx ตามตาราง ไม่ใช่ 500', () => {
  async function makeClaim() {
    const { rows } = await adminPool.query(
      `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
       VALUES ($1, 'นายทดสอบ สถานะ error', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
      [crypto.randomBytes(32).toString('hex')]
    );
    return rows[0].claim_request_id;
  }

  test.each(HTTP_REACHABLE_CODES)('%s', async (code) => {
    const { status, type, body } = (await bodiesForEachCode())[code];
    const claimId = await makeClaim();
    const res = await (await api('post', `/claim-requests/${claimId}/resolve`, 'personnel:provision')).send({
      action: 'PROVISION',
      employment: body,
    });
    expect(res.status).toBe(status);
    expect(res.body.type).toMatch(new RegExp(`${type}$`));
    // ผิดพลาดแล้ว claim ต้องยัง PENDING_HR (ไม่ถูกเปลี่ยนเป็น LINKED บางส่วน)
    const { rows } = await adminPool.query(`SELECT status, resolved_person_id FROM mdm.claim_request WHERE claim_request_id = $1`, [claimId]);
    expect(rows[0]).toEqual({ status: 'PENDING_HR', resolved_person_id: null });
  });
});

describe('PUT /persons/{id}/employment - แยกสถานะตามประเภท error (ไม่ใช่ 409 เหมารวมทุกกรณีเหมือนเดิม)', () => {
  async function makeActivePerson() {
    const positionId = await makePosition();
    const personId = await makePerson();
    await adminPool.query(
      `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
       VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, '2020-01-01', true, 'ACTIVE', 'test')`,
      [personId, `EMP-ERR-PUT-${crypto.randomUUID()}`, positionId, orgUnitId]
    );
    return personId;
  }

  test.each([
    ['ORG_UNIT_NOT_FOUND', 422, 'org-unit-invalid'],
    ['POSITION_NOT_FOUND', 422, 'position-invalid'],
    ['DUPLICATE_POSITION', 409, 'position-occupied'],
    ['DUPLICATE_EMPLOYEE_NO', 409, 'employee-no-conflict'],
  ])('%s -> %s %s (ก่อนแก้: ทุก code เหมารวมเป็น 409 หมด)', async (code, status, type) => {
    const { body } = (await bodiesForEachCode())[code];
    const personId = await makeActivePerson();
    const before = (await adminPool.query(`SELECT employee_no, is_current FROM mdm.employment WHERE person_id = $1`, [personId])).rows;

    const res = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send({
      ...body,
      effectiveFrom: '2025-01-01', // หลังแถวเดิม (2020-01-01) - ถ้าไม่ error จะปิดแถวเดิมแล้วเปิดแถวใหม่
    });

    expect(res.status).toBe(status);
    expect(res.body.type).toMatch(new RegExp(`${type}$`));

    // ผิดพลาดแล้ว employment เดิมต้องไม่ถูกแตะ (ปิด/แก้) เลย - ยกเลิกทั้ง transaction
    const after = (await adminPool.query(`SELECT employee_no, is_current FROM mdm.employment WHERE person_id = $1`, [personId])).rows;
    expect(after).toEqual(before);
  });

  test('PERSONNEL_TYPE_INVALID ยิงไม่ถึงโค้ดของเรา - OpenAPI enum ปฏิเสธด้วย 400 ก่อนเสมอ (เหมือนกับ endpoint อื่น)', async () => {
    const personId = await makeActivePerson();
    const res = await (await api('put', `/persons/${personId}/employment`, 'personnel:write:employment')).send(
      baseEmployment({ personnelType: 'NOT_A_REAL_PERSONNEL_TYPE', effectiveFrom: '2025-01-01' })
    );
    expect(res.status).toBe(400);
  });
});

describe('batch import (ยืนยันว่าเส้นทางนี้ไม่พังจากการแก้ครั้งนี้ - รายงานเป็น error รายแถว ไม่ใช่ HTTP error)', () => {
  test('ORG_UNIT_NOT_FOUND ยังคง 200 พร้อม error รายแถว code=ORG_UNIT_NOT_FOUND เหมือนเดิม (api/test/employmentImport.test.js:178-204 ครอบเคสนี้อยู่แล้ว)', async () => {
    const res = await (await api('post', '/sync/hr/employment-batch', 'personnel:import')).send({
      mode: 'DRY_RUN',
      createIfMissing: true,
      rows: [
        {
          rowRef: 'bad-org-unit',
          pid: makeFakePid(),
          expectedFirstNameTh: 'ทดสอบ',
          expectedLastNameTh: 'batch',
          employment: baseEmployment({ positionId: await makePosition(), orgUnitId: crypto.randomUUID() }),
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([{ rowRef: 'bad-org-unit', code: 'ORG_UNIT_NOT_FOUND', message: expect.any(String) }]);
  });

  test.each(HTTP_REACHABLE_CODES)('%s ยังคงรายงานเป็น error รายแถวโดยไม่ใช่ HTTP 4xx/5xx', async (code) => {
    const { body } = (await bodiesForEachCode())[code];
    const res = await (await api('post', '/sync/hr/employment-batch', 'personnel:import')).send({
      mode: 'DRY_RUN',
      createIfMissing: true,
      rows: [{ rowRef: code, pid: makeFakePid(), expectedFirstNameTh: 'ทดสอบ', expectedLastNameTh: 'batch', employment: body }],
    });
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([{ rowRef: code, code, message: expect.any(String) }]);
  });
});
