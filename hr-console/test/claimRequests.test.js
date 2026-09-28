const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { insertFixtureOrgUnit, insertFixturePosition } = require('../../api/test/fixtures');

let harness;
let adminPool;
let orgUnitId;
let positionId;
let positionNo; // เลขที่ตำแหน่งของ fixture - ฟอร์ม approve รับ "เลขที่ตำแหน่ง" (ข้อความ) ไม่ใช่ UUID แล้ว

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  orgUnitId = await insertFixtureOrgUnit(adminPool);
  positionId = await insertFixturePosition(adminPool, orgUnitId);
  ({ rows: [{ position_no: positionNo }] } = await adminPool.query('SELECT position_no FROM mdm.position WHERE position_id = $1', [positionId]));
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

async function makePendingClaim(displayName) {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
    [crypto.randomBytes(32).toString('hex'), displayName]
  );
  return rows[0].claim_request_id;
}

describe('HR Console: claim requests', () => {
  test('หน้ารายการแสดง claim request ที่รอ HR ดำเนินการ (status=PENDING_HR)', async () => {
    const claimRequestId = await makePendingClaim('สมชาย ทดสอบ HR Console');
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent.get('/hr/claim-requests');
    expect(res.status).toBe(200);
    expect(res.text).toContain('สมชาย ทดสอบ HR Console');
    expect(res.text).toContain(claimRequestId);
    expect(res.text).toContain('PENDING_HR');
  });

  test('อนุมัติ (action=PROVISION) สร้างบุคลากรใหม่จริงใน MDM แล้ว redirect กลับพร้อมข้อความสำเร็จ', async () => {
    const claimRequestId = await makePendingClaim('อนุมัติทดสอบ HR Console');
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent
      .post(`/hr/claim-requests/${claimRequestId}/approve`)
      .type('form')
      .send({
        employeeNo: makeFakePid(),
        personnelType: 'CIVIL_SERVANT',
        orgUnitId,
        positionNo,
        effectiveFrom: '2024-01-01',
        note: 'สร้างโดยเทส HR Console',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/hr/claim-requests?resolved=approved');

    const { rows } = await adminPool.query(
      'SELECT status, resolved_person_id FROM mdm.claim_request WHERE claim_request_id = $1',
      [claimRequestId]
    );
    expect(rows[0].status).toBe('LINKED');
    expect(rows[0].resolved_person_id).toBeTruthy();

    const { rows: personRows } = await adminPool.query('SELECT status FROM mdm.person WHERE person_id = $1', [
      rows[0].resolved_person_id,
    ]);
    expect(personRows[0].status).toBe('PENDING_CLAIM');
  });

  test('ฟอร์มอนุมัติที่ orgUnitId ไม่มีจริง -> แสดง error จาก MDM API ไม่ crash และไม่เปลี่ยนสถานะ claim', async () => {
    const claimRequestId = await makePendingClaim('อนุมัติผิดพลาดทดสอบ');
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent
      .post(`/hr/claim-requests/${claimRequestId}/approve`)
      .type('form')
      .send({
        employeeNo: makeFakePid(),
        personnelType: 'CIVIL_SERVANT',
        orgUnitId: crypto.randomUUID(),
        positionNo, // ต้องมีเพราะ CIVIL_SERVANT บังคับมีตำแหน่ง - ให้ผ่านกฎนี้แล้วไปชน orgUnitId ที่ไม่มีจริงที่ MDM API
        effectiveFrom: '2024-01-01',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain('undefined');

    const { rows } = await adminPool.query('SELECT status FROM mdm.claim_request WHERE claim_request_id = $1', [claimRequestId]);
    expect(rows[0].status).toBe('PENDING_HR');
  });

  test('ปฏิเสธ (action=REJECT) เปลี่ยนสถานะเป็น REJECTED', async () => {
    const claimRequestId = await makePendingClaim('ปฏิเสธทดสอบ HR Console');
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent.post(`/hr/claim-requests/${claimRequestId}/reject`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/hr/claim-requests?resolved=rejected');

    const { rows } = await adminPool.query('SELECT status FROM mdm.claim_request WHERE claim_request_id = $1', [claimRequestId]);
    expect(rows[0].status).toBe('REJECTED');
  });

  test('claim request ที่ resolve ไปแล้ว -> resolve ซ้ำได้ 409 ไม่ crash', async () => {
    const claimRequestId = await makePendingClaim('resolve ซ้ำทดสอบ');
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const first = await agent.post(`/hr/claim-requests/${claimRequestId}/reject`);
    expect(first.status).toBe(302);

    const second = await agent.post(`/hr/claim-requests/${claimRequestId}/reject`);
    expect(second.status).toBe(409);
  });

  test('ไม่ได้ล็อกอิน -> ทุก route ของ claim-requests redirect ไป login', async () => {
    const claimRequestId = await makePendingClaim('ไม่ล็อกอินทดสอบ');
    const app = harness.hrConsoleApp;

    expect((await request(app).get('/hr/claim-requests')).headers.location).toBe('/auth/login');
    expect((await request(app).get(`/hr/claim-requests/${claimRequestId}/approve`)).headers.location).toBe('/auth/login');
    expect((await request(app).post(`/hr/claim-requests/${claimRequestId}/reject`)).headers.location).toBe('/auth/login');
  });
});
