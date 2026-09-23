const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { insertFixtureOrgUnit, insertFixturePosition } = require('../../api/test/fixtures');

let harness;
let adminPool;
let orgUnitId;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

// ตำแหน่งใหม่ต่อ candidate เสมอ (ไม่ใช้ positionId เดียวกันซ้ำ) - mdm.employment มี EXCLUDE constraint
// กันตำแหน่งเดียวกันถูกครองพร้อมกันสองคน (current employment ที่ effective_from ทับซ้อนกัน)
async function makeReverifyCandidate(verificationStatus, { firstNameTh = 'ค้างยืนยัน', lastNameTh = 'ทดสอบ' } = {}) {
  const positionId = await insertFixturePosition(adminPool, orgUnitId);
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
     VALUES ($1, $2, 'ACTIVE', $3, now() - interval '400 days', now() - interval '400 days', 1)`,
    [personId, crypto.randomBytes(32).toString('hex'), verificationStatus]
  );
  await adminPool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาง', $2, $3, '1980-01-01', 'F', now() - interval '400 days')`,
    [personId, firstNameTh, lastNameTh]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, `EMP-REVERIFY-${crypto.randomUUID()}`, positionId, orgUnitId]
  );
  return personId;
}

describe('HR Console: reverify list', () => {
  test('แสดงชื่อ/สังกัด/สถานะยืนยันของคนที่ STALE จริง (ต้องมี personnel:read:basic ไม่งั้นเห็นแต่ personId เปล่า)', async () => {
    const personId = await makeReverifyCandidate('STALE', { firstNameTh: 'สายเกิน', lastNameTh: 'กำหนด' });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent.get('/hr/reverify');
    expect(res.status).toBe(200);
    expect(res.text).toContain('สายเกิน');
    expect(res.text).toContain('STALE');
    expect(res.text).toContain(personId);
  });

  test('กรอง verificationStatus=EXPIRED เท่านั้น -> ไม่แสดงคนที่เป็น STALE', async () => {
    const staleId = await makeReverifyCandidate('STALE', { firstNameTh: 'สเตล', lastNameTh: 'ไม่ควรเห็น' });
    const expiredId = await makeReverifyCandidate('EXPIRED', { firstNameTh: 'หมดอายุ', lastNameTh: 'ควรเห็น' });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent.get('/hr/reverify').query({ verificationStatus: 'EXPIRED' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(expiredId);
    expect(res.text).not.toContain(staleId);
    void staleId;
  });

  test('กดขอ reverify ทันที เรียก MDM API สำเร็จและตั้ง reverify_requested_at', async () => {
    const personId = await makeReverifyCandidate('STALE');
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent.post(`/hr/reverify/${personId}/request`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/hr/reverify?requested=1');

    const { rows } = await adminPool.query('SELECT reverify_requested_at FROM mdm.person WHERE person_id = $1', [personId]);
    expect(rows[0].reverify_requested_at).toBeTruthy();
  });

  test('ขอ reverify ให้ personId ที่ไม่มีอยู่จริง -> แสดง error 404 ไม่ crash', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const res = await agent.post(`/hr/reverify/${crypto.randomUUID()}/request`);
    expect(res.status).toBe(404);
  });

  test('ไม่ได้ล็อกอิน -> redirect ไป login', async () => {
    const res = await request(harness.hrConsoleApp).get('/hr/reverify');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });
});
