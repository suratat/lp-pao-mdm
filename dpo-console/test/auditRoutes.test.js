const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsDpo } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');

let harness;
let adminPool;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

async function makePerson() {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  return personId;
}

async function insertAccessLog(personId, overrides = {}) {
  const row = {
    accessedAt: new Date(),
    actorType: 'USER',
    actorSub: 'test-actor',
    clientId: 'test-client',
    endpoint: '/api/v1/persons/' + personId,
    httpMethod: 'GET',
    fieldsReturned: ['basic.firstNameTh'],
    purposeCode: 'TEST_PURPOSE',
    justification: null,
    requestId: crypto.randomUUID(),
    responseStatus: 200,
    ...overrides,
  };
  await adminPool.query(
    `INSERT INTO audit.access_log
      (accessed_at, subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
       fields_returned, purpose_code, justification, request_id, response_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.accessedAt,
      personId,
      row.actorType,
      row.actorSub,
      row.clientId,
      row.endpoint,
      row.httpMethod,
      JSON.stringify(row.fieldsReturned),
      row.purposeCode,
      row.justification,
      row.requestId,
      row.responseStatus,
    ]
  );
}

// audit.data_change_log เป็น append-only (มี trigger บล็อก UPDATE/DELETE) - ต้องระบุ changed_at ตอน
// INSERT ตรง ๆ ถ้าอยากทดสอบ entry เก่า ไม่ใช่ INSERT แล้วค่อย UPDATE ทีหลัง
async function insertChangeLog(personId, overrides = {}) {
  const row = {
    tableName: 'person_identity',
    fieldName: 'identity.first_name_th',
    oldValue: JSON.stringify('เก่า'),
    newValue: JSON.stringify('ใหม่'),
    changedBy: 'THAID_SYNC',
    actorSub: null,
    reason: null,
    changedAt: new Date(),
    ...overrides,
  };
  await adminPool.query(
    `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, actor_sub, reason, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [personId, row.tableName, row.fieldName, row.oldValue, row.newValue, row.changedBy, row.actorSub, row.reason, row.changedAt]
  );
}

describe('DPO Console: access log', () => {
  test('หน้ารายการแสดง access log entry ที่มีอยู่จริง', async () => {
    const personId = await makePerson();
    const requestId = crypto.randomUUID();
    await insertAccessLog(personId, { requestId, clientId: 'eoffice' });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs');
    expect(res.status).toBe(200);
    expect(res.text).toContain(personId);
    expect(res.text).toContain('eoffice');
  });

  test('กรองด้วย personId -> เห็นเฉพาะของคนนั้น', async () => {
    const personA = await makePerson();
    const personB = await makePerson();
    await insertAccessLog(personA, { clientId: 'client-a' });
    await insertAccessLog(personB, { clientId: 'client-b' });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs').query({ personId: personA });
    expect(res.status).toBe(200);
    expect(res.text).toContain(personA);
    expect(res.text).not.toContain(personB);
  });

  test('กรองด้วยช่วงวันที่ (from/to) -> ตัดรายการนอกช่วงออก', async () => {
    const personId = await makePerson();
    const oldRequestId = crypto.randomUUID();
    const recentRequestId = crypto.randomUUID();
    await insertAccessLog(personId, { accessedAt: new Date('2020-01-01T00:00:00Z'), requestId: oldRequestId });
    await insertAccessLog(personId, { accessedAt: new Date(), requestId: recentRequestId });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs').query({ personId, from: '2024-01-01T00:00' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(recentRequestId);
    expect(res.text).not.toContain(oldRequestId);
  });

  test('ติ๊ก "เฉพาะการเข้าถึง pid/lookup" -> เห็นเฉพาะ endpoint ที่มี /pid หรือ /lookup', async () => {
    const personId = await makePerson();
    await insertAccessLog(personId, { endpoint: `/api/v1/persons/${personId}` });
    await insertAccessLog(personId, { endpoint: `/api/v1/persons/${personId}/pid` });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs').query({ personId, pidAccessOnly: 'true' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`/persons/${personId}/pid`);
    expect(res.text).not.toContain(`>/api/v1/persons/${personId}<`);
  });

  test('กรองประเภทผู้เรียก (actorType) ฝั่ง DPO Console เอง -> USER เท่านั้นไม่เห็น SERVICE', async () => {
    const personId = await makePerson();
    const userRequestId = crypto.randomUUID();
    const serviceRequestId = crypto.randomUUID();
    await insertAccessLog(personId, { actorType: 'USER', requestId: userRequestId });
    await insertAccessLog(personId, { actorType: 'SERVICE', requestId: serviceRequestId });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs').query({ personId, actorType: 'USER' });
    expect(res.status).toBe(200);
    expect(res.text).toContain(userRequestId);
    expect(res.text).not.toContain(serviceRequestId);
  });

  test('ไม่ได้ล็อกอิน -> redirect ไป login', async () => {
    const res = await request(harness.dpoConsoleApp).get('/dpo/access-logs');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });
});

describe('DPO Console: person change-log', () => {
  test('แสดงประวัติการเปลี่ยนแปลงของบุคคล และ mask ค่าฟิลด์ที่จัดชั้น RESTRICTED (person.pid_hash)', async () => {
    const personId = await makePerson();
    await insertChangeLog(personId, { fieldName: 'identity.first_name_th', oldValue: JSON.stringify('เก่า'), newValue: JSON.stringify('ใหม่') });
    await insertChangeLog(personId, { fieldName: 'person.pid_hash', oldValue: null, newValue: null, changedBy: 'HR' });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get(`/dpo/persons/${personId}/change-log`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('identity.first_name_th');
    expect(res.text).toContain('เก่า');
    expect(res.text).toContain('person.pid_hash');
    expect(res.text).toContain('(ปกปิด)');
  });

  test('กรองด้วย since -> ตัด entry ก่อนวันที่ระบุออก', async () => {
    const personId = await makePerson();
    await insertChangeLog(personId, { fieldName: 'field.old-entry', changedAt: new Date('2020-01-01T00:00:00Z') });
    await insertChangeLog(personId, { fieldName: 'field.recent-entry' });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get(`/dpo/persons/${personId}/change-log`).query({ since: '2024-01-01T00:00' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('field.recent-entry');
    expect(res.text).not.toContain('field.old-entry');
  });

  test('ไม่ได้ล็อกอิน -> redirect ไป login', async () => {
    const personId = await makePerson();
    const res = await request(harness.dpoConsoleApp).get(`/dpo/persons/${personId}/change-log`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });
});

describe('DPO Console: ประวัติการเปลี่ยนแปลงทั้งระบบ (/dpo/change-logs)', () => {
  test('แสดงผู้กระทำ/ client และปกปิดค่าของฟิลด์ CONFIDENTIAL แต่แสดงชื่อฟิลด์', async () => {
    const personId = await makePerson();
    const actorSub = `hr-${crypto.randomUUID()}`;
    await adminPool.query(
      `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, actor_sub, actor_client)
       VALUES ($1, 'person_contact', 'contact.mobile_phone', $2, $3, 'SELF', $4, 'mdm-portal')`,
      [personId, JSON.stringify('0811111111'), JSON.stringify('0822222222'), actorSub]
    );

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/change-logs').query({ actorSub });
    expect(res.status).toBe(200);
    expect(res.text).toContain('contact.mobile_phone');
    expect(res.text).toContain(actorSub);
    expect(res.text).toContain('mdm-portal');
    expect(res.text).toContain('(ปกปิด)');
    expect(res.text).not.toContain('0811111111');
    expect(res.text).not.toContain('0822222222');
    expect(res.text).toContain(`/dpo/persons/${personId}/change-log`);
  });

  test('แถวที่ไม่มี actor แสดง "ไม่ทราบ" ไม่ใช่ว่างเปล่า', async () => {
    const personId = await makePerson();
    await insertChangeLog(personId, { fieldName: 'field.legacy-no-actor', actorSub: null });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/change-logs').query({ personId });
    expect(res.status).toBe(200);
    expect(res.text).toContain('field.legacy-no-actor');
    expect(res.text).toContain('ไม่ทราบ');
  });

  test('เลข 13 หลักในเหตุผล/ค่าไม่ปรากฏในหน้าจอ (ทั้งที่ API ปกปิด และที่ console ปกปิดซ้ำ)', async () => {
    const personId = await makePerson();
    const fakePid = makeFakePid();
    await insertChangeLog(personId, {
      fieldName: 'status',
      oldValue: JSON.stringify(fakePid),
      newValue: JSON.stringify('INACTIVE'),
      reason: `อ้างอิง ${fakePid}`,
    });

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/change-logs').query({ personId });
    expect(res.status).toBe(200);
    expect(res.text).toContain('INACTIVE');
    expect(res.text).not.toContain(fakePid);
    expect(res.text).toContain('ปกปิดเลข 13 หลัก');
  });

  test('source=REFERENCE: เห็นแถวของ reference_change_log พร้อม action และกรองด้วย action ได้', async () => {
    const actorSub = `hr-master-${crypto.randomUUID()}`;
    const recordId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO audit.reference_change_log (table_name, record_id, action, field_name, old_value, new_value, actor_sub, actor_client)
       VALUES ('org_unit', $1, 'CREATE', 'name_th', NULL, $2, $3, 'hr-console'),
              ('org_unit', $1, 'UPDATE', 'name_th', $2, $4, $3, 'hr-console')`,
      [recordId, JSON.stringify('กอง ก'), actorSub, JSON.stringify('กอง ข')]
    );

    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const all = await agent.get('/dpo/change-logs').query({ source: 'REFERENCE', actorSub });
    expect(all.status).toBe(200);
    expect(all.text).toContain(recordId);
    expect(all.text).toContain('CREATE');
    expect(all.text).toContain('UPDATE');

    const created = await agent.get('/dpo/change-logs').query({ source: 'REFERENCE', actorSub, action: 'CREATE' });
    expect(created.text).toContain('CREATE');
    expect(created.text).toContain('<td>CREATE</td>');
    expect(created.text).not.toContain('<td>UPDATE</td>');
  });

  test('สลับเป็น REFERENCE โดยที่ personId ค้างในฟอร์ม -> ไม่ส่งตัวกรอง PERSON ไป API (ไม่ได้ 400)', async () => {
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/change-logs').query({ source: 'REFERENCE', personId: crypto.randomUUID(), changedBy: 'HR' });
    expect(res.status).toBe(200);
  });

  test('หน้าถัดไป: 52 แถว (limit 50) -> หน้าแรกมีลิงก์ cursor หน้าสองได้ 2 แถวที่เหลือโดยไม่ซ้ำ', async () => {
    const personId = await makePerson();
    await adminPool.query(
      `INSERT INTO audit.data_change_log (person_id, table_name, field_name, changed_by, actor_sub)
       SELECT $1, 'person', 'field.bulk-' || lpad(g::text, 2, '0'), 'HR', 'hr-bulk' FROM generate_series(1, 52) AS g`,
      [personId]
    );
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const first = await agent.get('/dpo/change-logs').query({ personId });
    expect(first.status).toBe(200);
    expect(first.text).toContain('field.bulk-52'); // เรียงใหม่ -> เก่า
    expect(first.text).not.toContain('field.bulk-02');
    const link = first.text.match(/href="(\/dpo\/change-logs\?[^"]*cursor=[^"]+)"/);
    expect(link).not.toBeNull();

    const second = await agent.get(link[1].replace(/&amp;/g, '&'));
    expect(second.status).toBe(200);
    expect(second.text).toContain('field.bulk-02');
    expect(second.text).toContain('field.bulk-01');
    expect(second.text).not.toContain('field.bulk-52');
    expect(second.text).not.toContain('หน้าถัดไป');
  });

  test('ไม่ได้ล็อกอิน -> redirect ไป login', async () => {
    const res = await request(harness.dpoConsoleApp).get('/dpo/change-logs');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });
});
