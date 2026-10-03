const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// endpoint ที่คืน schema Person ต้องใช้ personnel:read:basic ด้วย (Person.required มี `basic` ซึ่ง fieldMask ตัดทิ้งเมื่อไม่มี scope นี้
// ทำให้ response validator ตอบ 500 หลัง commit ไปแล้ว) - ต้องตอบ 403 insufficient-scope ก่อนเข้า service และไม่เขียน DB เลย
// ข้อมูลทดสอบเป็นข้อมูลสังเคราะห์ทั้งหมด

let ctx;
let adminPool;
let pepper;
let fixtureOrgUnitId;

const WRITE_ONLY = {
  provision: 'personnel:provision',
  writeEmployment: 'personnel:write:employment',
};

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await ctx.vault.getPepper();
  fixtureOrgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ scope', 'GENERAL', $2) RETURNING position_id`,
    [`POS-SCOPE-${crypto.randomUUID()}`, fixtureOrgUnitId]
  );
  return rows[0].position_id;
}

async function makeActivePerson() {
  const positionId = await makePosition();
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), now(), 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  await adminPool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาย', 'ทดสอบ', 'สโคป', '1990-01-01', 'M', now())`,
    [personId]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, `EMP-SCOPE-${crypto.randomUUID()}`, positionId, fixtureOrgUnitId]
  );
  return personId;
}

async function snapshotPerson(personId) {
  const [person, employment, outbox, changeLog] = await Promise.all([
    adminPool.query('SELECT status, version FROM mdm.person WHERE person_id = $1', [personId]),
    adminPool.query(
      'SELECT employment_id, is_current, employment_status FROM mdm.employment WHERE person_id = $1 ORDER BY employment_id',
      [personId]
    ),
    adminPool.query('SELECT count(*)::int AS n FROM integration.outbox_event WHERE person_id = $1', [personId]),
    adminPool.query('SELECT count(*)::int AS n FROM audit.data_change_log WHERE person_id = $1', [personId]),
  ]);
  return { person: person.rows, employment: employment.rows, outbox: outbox.rows[0].n, changeLog: changeLog.rows[0].n };
}

function expectInsufficientScope(res, missingScope) {
  expect(res.status).toBe(403);
  expect(res.body.type).toMatch(/insufficient-scope$/);
  expect(res.body.detail).toContain(missingScope);
}

describe('POST /persons - ไม่มี personnel:read:basic', () => {
  test('403 และไม่มีแถวค้างใน person/employment/outbox', async () => {
    const positionId = await makePosition();
    const pid = makeFakePid();
    const employeeNo = `EMP-SCOPE-NEW-${crypto.randomUUID()}`;
    const token = await ctx.auth.signToken({ scope: WRITE_ONLY.provision });

    const res = await request(ctx.app)
      .post('/api/v1/persons')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pid,
        expectedFirstNameTh: 'ก',
        expectedLastNameTh: 'ข',
        employment: {
          employeeNo,
          personnelType: 'CIVIL_SERVANT',
          positionId,
          orgUnitId: fixtureOrgUnitId,
          effectiveFrom: '2024-01-01',
        },
      });

    expectInsufficientScope(res, 'personnel:read:basic');

    const persons = await adminPool.query('SELECT person_id FROM mdm.person WHERE pid_hash = $1', [pidHash(pid, pepper)]);
    expect(persons.rowCount).toBe(0);
    const employments = await adminPool.query('SELECT 1 FROM mdm.employment WHERE employee_no = $1', [employeeNo]);
    expect(employments.rowCount).toBe(0);
    // ไม่มี person -> ไม่มี outbox PERSON_CREATED ผูกกับ person ใหม่ (นับเฉพาะแถวที่ผูกกับ person ของ pid นี้ซึ่งไม่มี)
    const outbox = await adminPool.query(
      `SELECT 1 FROM integration.outbox_event o JOIN mdm.person p USING (person_id) WHERE p.pid_hash = $1`,
      [pidHash(pid, pepper)]
    );
    expect(outbox.rowCount).toBe(0);
  });

  test('มี provision + read:basic -> 201 ตามเดิม', async () => {
    const positionId = await makePosition();
    const token = await ctx.auth.signToken({ scope: `${WRITE_ONLY.provision} personnel:read:basic` });

    const res = await request(ctx.app)
      .post('/api/v1/persons')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pid: makeFakePid(),
        expectedFirstNameTh: 'ก',
        expectedLastNameTh: 'ข',
        employment: {
          employeeNo: `EMP-SCOPE-OK-${crypto.randomUUID()}`,
          personnelType: 'CIVIL_SERVANT',
          positionId,
          orgUnitId: fixtureOrgUnitId,
          effectiveFrom: '2024-01-01',
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_CLAIM');
    expect(res.body.basic).toBeDefined();
  });
});

describe('POST /persons/{id}/deactivate - ไม่มี personnel:read:basic', () => {
  const body = () => ({ employmentStatus: 'RESIGNED', separationDate: '2026-01-01', reason: 'ทดสอบ' });

  test('403 และสถานะ/employment/outbox/change_log ไม่เปลี่ยน', async () => {
    const personId = await makeActivePerson();
    const before = await snapshotPerson(personId);
    const token = await ctx.auth.signToken({ scope: WRITE_ONLY.writeEmployment });

    const res = await request(ctx.app)
      .post(`/api/v1/persons/${personId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send(body());

    expectInsufficientScope(res, 'personnel:read:basic');
    expect(await snapshotPerson(personId)).toEqual(before);
  });

  test('มี write:employment + read:basic -> 200 ตามเดิม', async () => {
    const personId = await makeActivePerson();
    const token = await ctx.auth.signToken({ scope: `${WRITE_ONLY.writeEmployment} personnel:read:basic` });

    const res = await request(ctx.app)
      .post(`/api/v1/persons/${personId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send(body());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('INACTIVE');
  });
});

describe('POST /persons/{id}/reactivate - ไม่มี personnel:read:basic', () => {
  async function makeInactivePerson() {
    const personId = await makeActivePerson();
    await adminPool.query(`UPDATE mdm.person SET status = 'INACTIVE', deleted_at = now() WHERE person_id = $1`, [personId]);
    await adminPool.query(
      `UPDATE mdm.employment SET is_current = false, employment_status = 'RESIGNED', effective_to = CURRENT_DATE
       WHERE person_id = $1`,
      [personId]
    );
    return personId;
  }

  const body = async () => ({
    employeeNo: `EMP-SCOPE-RE-${crypto.randomUUID()}`,
    personnelType: 'CIVIL_SERVANT',
    positionId: await makePosition(),
    orgUnitId: fixtureOrgUnitId,
    effectiveFrom: '2099-01-01',
  });

  test('403 และสถานะ/employment/outbox/change_log ไม่เปลี่ยน', async () => {
    const personId = await makeInactivePerson();
    const before = await snapshotPerson(personId);
    const token = await ctx.auth.signToken({ scope: WRITE_ONLY.writeEmployment });

    const res = await request(ctx.app)
      .post(`/api/v1/persons/${personId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send(await body());

    expectInsufficientScope(res, 'personnel:read:basic');
    expect(await snapshotPerson(personId)).toEqual(before);
  });

  test('มี write:employment + read:basic -> 200 ตามเดิม', async () => {
    const personId = await makeInactivePerson();
    const token = await ctx.auth.signToken({ scope: `${WRITE_ONLY.writeEmployment} personnel:read:basic` });

    const res = await request(ctx.app)
      .post(`/api/v1/persons/${personId}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .send(await body());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
  });
});

describe('GET /reverify/stale - ไม่มี personnel:read:basic', () => {
  test('403 (อ่านอย่างเดียว ไม่ใช่ 500)', async () => {
    const token = await ctx.auth.signToken({ scope: WRITE_ONLY.provision });
    const res = await request(ctx.app).get('/api/v1/reverify/stale').set('Authorization', `Bearer ${token}`);
    expectInsufficientScope(res, 'personnel:read:basic');
  });

  test('มี provision + read:basic -> 200 ตามเดิม', async () => {
    const token = await ctx.auth.signToken({ scope: `${WRITE_ONLY.provision} personnel:read:basic` });
    const res = await request(ctx.app).get('/api/v1/reverify/stale').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
