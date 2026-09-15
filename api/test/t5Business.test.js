const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { makeFakePid } = require('../src/security/pid');
const { FIXTURE_ORG_UNIT_ID } = require('../src/constants');

// T5: ทดสอบกฎธุรกิจที่ contract.test.js (happy-path ล้วนๆ) ไม่ครอบคลุม - optimistic lock, duplicate pid,
// SSRF allow-list, field masking ตาม scope, และ resolveClaimRequest ทั้ง 3 action

process.env.WEBHOOK_ALLOWED_HOSTS = process.env.WEBHOOK_ALLOWED_HOSTS || 'example.lp-pao.go.th';

let ctx;
let adminPool;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

async function makePosition() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ T5', 'GENERAL', $2) RETURNING position_id`,
    [`POS-T5-${crypto.randomUUID()}`, FIXTURE_ORG_UNIT_ID]
  );
  return rows[0].position_id;
}

async function makeActivePerson(positionId) {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), now(), 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  await adminPool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาย', 'ทดสอบ', 'T5', '1990-01-01', 'M', now())`,
    [personId]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, `EMP-T5-${crypto.randomUUID()}`, positionId, FIXTURE_ORG_UNIT_ID]
  );
  return personId;
}

describe('PUT /persons/{id}/employment - optimistic locking (§1.6)', () => {
  test('409 เมื่อ expectedVersion ไม่ตรงกับ person.version ปัจจุบัน', async () => {
    const positionId = await makePosition();
    const personId = await makeActivePerson(positionId);
    const newPositionId = await makePosition();
    const token = await ctx.auth.signToken({ scope: 'personnel:write:employment' });

    const res = await request(ctx.app)
      .put(`/api/v1/persons/${personId}/employment`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeNo: `EMP-CONFLICT-${crypto.randomUUID()}`,
        personnelType: 'CIVIL_SERVANT',
        positionId: newPositionId,
        orgUnitId: FIXTURE_ORG_UNIT_ID,
        effectiveFrom: '2099-01-01',
        expectedVersion: 999,
      });

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('https://mdm.lp-pao.go.th/problems/version-conflict');
  });

  test('ผ่านเมื่อ expectedVersion ตรงกับปัจจุบัน และ version เพิ่มขึ้นจริง', async () => {
    const positionId = await makePosition();
    const personId = await makeActivePerson(positionId);
    const newPositionId = await makePosition();
    const token = await ctx.auth.signToken({ scope: 'personnel:write:employment personnel:read:basic' });

    const res = await request(ctx.app)
      .put(`/api/v1/persons/${personId}/employment`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeNo: `EMP-OK-${crypto.randomUUID()}`,
        personnelType: 'CIVIL_SERVANT',
        positionId: newPositionId,
        orgUnitId: FIXTURE_ORG_UNIT_ID,
        effectiveFrom: '2099-01-01',
        expectedVersion: 1,
      });

    expect(res.status).toBe(200);

    const { rows } = await adminPool.query('SELECT version FROM mdm.person WHERE person_id = $1', [personId]);
    expect(rows[0].version).toBe(2);
  });
});

describe('PUT /persons/{id}/employment - positionId เป็น optional (พนักงานจ้าง/จ้างเหมาบริการรายบุคคล)', () => {
  test('200 เมื่อไม่ส่ง positionId มา - DB บันทึก position_id เป็น NULL และ response ไม่มี employment.position', async () => {
    const positionId = await makePosition();
    const personId = await makeActivePerson(positionId);
    const token = await ctx.auth.signToken({ scope: 'personnel:write:employment personnel:read:basic' });

    const res = await request(ctx.app)
      .put(`/api/v1/persons/${personId}/employment`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        employeeNo: `EMP-NOPOS-${crypto.randomUUID()}`,
        personnelType: 'OUTSOURCE_INDIVIDUAL',
        orgUnitId: FIXTURE_ORG_UNIT_ID,
        effectiveFrom: '2099-01-01',
        expectedVersion: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.position).toBeUndefined();

    const { rows } = await adminPool.query(
      `SELECT position_id FROM mdm.employment WHERE person_id = $1 AND is_current = true`,
      [personId]
    );
    expect(rows[0].position_id).toBeNull();
  });

  test('สองคนไม่มีตำแหน่ง (position_id NULL) ช่วงเวลาซ้อนทับกันได้ ไม่ชน EXCLUDE constraint', async () => {
    const positionId = await makePosition();
    const personA = await makeActivePerson(positionId);
    const personB = await makeActivePerson(await makePosition());
    const token = await ctx.auth.signToken({ scope: 'personnel:write:employment' });

    const bodyFor = (employeeNo) => ({
      employeeNo,
      personnelType: 'GENERAL_EMPLOYEE',
      orgUnitId: FIXTURE_ORG_UNIT_ID,
      effectiveFrom: '2099-01-01',
      expectedVersion: 1,
    });

    const resA = await request(ctx.app)
      .put(`/api/v1/persons/${personA}/employment`)
      .set('Authorization', `Bearer ${token}`)
      .send(bodyFor(`EMP-NOPOS-A-${crypto.randomUUID()}`));
    expect(resA.status).toBe(200);

    const resB = await request(ctx.app)
      .put(`/api/v1/persons/${personB}/employment`)
      .set('Authorization', `Bearer ${token}`)
      .send(bodyFor(`EMP-NOPOS-B-${crypto.randomUUID()}`));
    expect(resB.status).toBe(200);
  });
});

describe('POST /persons - duplicate pid (§3.4)', () => {
  test('409 พร้อม existingPersonId เมื่อ pid ซ้ำกับ record เดิม', async () => {
    const positionId = await makePosition();
    const pid = makeFakePid();
    const token = await ctx.auth.signToken({ scope: 'personnel:provision personnel:read:basic' });

    const employment = () => ({
      employeeNo: `EMP-DUP-${crypto.randomUUID()}`,
      personnelType: 'CIVIL_SERVANT',
      positionId,
      orgUnitId: FIXTURE_ORG_UNIT_ID,
      effectiveFrom: '2024-01-01',
    });

    const first = await request(ctx.app)
      .post('/api/v1/persons')
      .set('Authorization', `Bearer ${token}`)
      .send({ pid, expectedFirstNameTh: 'ก', expectedLastNameTh: 'ข', employment: employment() });
    expect(first.status).toBe(201);

    const secondPositionId = await makePosition();
    const second = await request(ctx.app)
      .post('/api/v1/persons')
      .set('Authorization', `Bearer ${token}`)
      .send({
        pid,
        expectedFirstNameTh: 'ค',
        expectedLastNameTh: 'ง',
        employment: { ...employment(), positionId: secondPositionId, employeeNo: `EMP-DUP2-${crypto.randomUUID()}` },
      });

    expect(second.status).toBe(409);
    expect(second.body.existingPersonId).toBe(first.body.personId);
  });
});

describe('Webhooks SSRF allow-list (§2.3)', () => {
  // webhookService.resolveConsumerSystemId ต้องมี mdm.consumer_system ผูกกับ azp ของ token ก่อน จึงจะไปถึง
  // validateWebhookUrl() (มิฉะนั้นได้ 403 not-registered-consumer ก่อนเสมอ)
  const clientId = `t5-ssrf-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO mdm.consumer_system (consumer_system_id, keycloak_client_id, name, purpose_code, status)
       VALUES (gen_random_uuid(), $1, 'ระบบทดสอบ SSRF', 'HR_ADMIN', 'ACTIVE')`,
      [clientId]
    );
  });

  test('400 เมื่อ host ไม่อยู่ใน WEBHOOK_ALLOWED_HOSTS', async () => {
    const token = await ctx.auth.signToken({ scope: 'webhook:manage', sub: clientId, azp: clientId });
    const res = await request(ctx.app)
      .post('/api/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'https://attacker.example.com/hooks', eventTypes: ['PERSON_DEACTIVATED'] });

    expect(res.status).toBe(400);
    expect(res.body.type).toBe('https://mdm.lp-pao.go.th/problems/host-not-allowed');
  });

  test('400 เมื่อ URL ไม่ใช่ https', async () => {
    const token = await ctx.auth.signToken({ scope: 'webhook:manage', sub: clientId, azp: clientId });
    const res = await request(ctx.app)
      .post('/api/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'http://example.lp-pao.go.th/hooks', eventTypes: ['PERSON_DEACTIVATED'] });

    expect(res.status).toBe(400);
    expect(res.body.type).toBe('https://mdm.lp-pao.go.th/problems/https-required');
  });
});

describe('Field masking ตาม scope (§2.2, hard rule ข้อ 5)', () => {
  test('getPerson ด้วย scope personnel:read:basic เท่านั้น ไม่คืน identity/contact/employment', async () => {
    const positionId = await makePosition();
    const personId = await makeActivePerson(positionId);
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic' });

    const res = await request(ctx.app).get(`/api/v1/persons/${personId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.basic).toBeDefined();
    expect(res.body.identity).toBeUndefined();
    expect(res.body.contact).toBeUndefined();
    expect(res.body.employment).toBeUndefined();
  });

  test('getPerson ด้วย scope ครบ คืน employment ด้วย', async () => {
    const positionId = await makePosition();
    const personId = await makeActivePerson(positionId);
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic personnel:read:employment' });

    const res = await request(ctx.app).get(`/api/v1/persons/${personId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.employment).toBeDefined();
    expect(res.body.identity).toBeUndefined();
  });
});

describe('POST /claim-requests/{id}/resolve - PROVISION/LINK (§2.1)', () => {
  async function makePendingClaim() {
    const { rows } = await adminPool.query(
      `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
       VALUES ($1, 'ผู้ทดสอบ resolve', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
      [crypto.randomBytes(32).toString('hex')]
    );
    return rows[0].claim_request_id;
  }

  test('action=PROVISION สร้าง person ใหม่สถานะ PENDING_CLAIM และ LINKED claim_request', async () => {
    const claimRequestId = await makePendingClaim();
    const positionId = await makePosition();
    const token = await ctx.auth.signToken({ scope: 'personnel:provision' });

    const res = await request(ctx.app)
      .post(`/api/v1/claim-requests/${claimRequestId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        action: 'PROVISION',
        employment: {
          employeeNo: `EMP-CLAIM-${crypto.randomUUID()}`,
          personnelType: 'CIVIL_SERVANT',
          positionId,
          orgUnitId: FIXTURE_ORG_UNIT_ID,
          effectiveFrom: '2024-01-01',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('LINKED');
    expect(res.body.resolvedPersonId).toBeTruthy();

    const { rows } = await adminPool.query('SELECT status FROM mdm.person WHERE person_id = $1', [
      res.body.resolvedPersonId,
    ]);
    expect(rows[0].status).toBe('PENDING_CLAIM');
  });

  test('action=LINK ผูกกับ person ที่ไม่มี pid_hash อยู่ก่อนได้ และ 409 ถ้ามี pid_hash แล้ว', async () => {
    const claimRequestId = await makePendingClaim();
    const unlinkedPersonId = await makeActivePerson(await makePosition());
    // ลบ pid_hash ออกก่อนเพื่อจำลอง record ที่ migrate มาโดยไม่มีเลขบัตร
    await adminPool.query('UPDATE mdm.person SET pid_hash = NULL WHERE person_id = $1', [unlinkedPersonId]);
    const token = await ctx.auth.signToken({ scope: 'personnel:provision' });

    const res = await request(ctx.app)
      .post(`/api/v1/claim-requests/${claimRequestId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'LINK', personId: unlinkedPersonId });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('LINKED');

    const secondClaim = await makePendingClaim();
    const res2 = await request(ctx.app)
      .post(`/api/v1/claim-requests/${secondClaim}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'LINK', personId: unlinkedPersonId });

    expect(res2.status).toBe(409);
    expect(res2.body.type).toBe('https://mdm.lp-pao.go.th/problems/already-linked');
  });
});
