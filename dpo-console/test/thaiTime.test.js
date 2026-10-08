const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsDpo } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { formatThaiDateTime, toThaiInputValue, thaiInputToIso } = require('../src/thaiTime');

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


// ทดสอบต้องผ่านไม่ว่า TZ ของเครื่องเป็นอะไร (รันด้วย TZ=UTC และ TZ=Asia/Bangkok) - helper ระบุ Asia/Bangkok เอง
describe('thaiTime helper', () => {
  test.each([
    ['2026-10-08T14:18:42Z', '8 ต.ค. 2569 21:18:42'],
    ['2026-10-08T18:30:00Z', '9 ต.ค. 2569 01:30:00'], // ข้ามวัน
    ['2026-12-31T17:00:00Z', '1 ม.ค. 2570 00:00:00'], // ข้ามปี และเที่ยงคืนต้องเป็น 00 ไม่ใช่ 24
    ['2026-10-07T16:59:59.999Z', '7 ต.ค. 2569 23:59:59'],
    [new Date('2026-03-01T00:00:00Z'), '1 มี.ค. 2569 07:00:00'],
  ])('%s -> %s', (input, expected) => {
    expect(formatThaiDateTime(input)).toBe(expected);
  });

  test.each([[null], [undefined], [''], ['not-a-date']])('ค่า %p แสดงเป็น "-"', (input) => {
    expect(formatThaiDateTime(input)).toBe('-');
  });

  test('ช่องกรอก: ไม่มี timezone = เวลาไทย -> UTC (8 ต.ค. = 2026-10-07T17:00:00Z ถึง 2026-10-08T17:00:00Z)', () => {
    expect(thaiInputToIso('2026-10-08T00:00')).toBe('2026-10-07T17:00:00.000Z');
    expect(thaiInputToIso('2026-10-09T00:00')).toBe('2026-10-08T17:00:00.000Z');
    expect(thaiInputToIso('2026-10-08T21:18:42')).toBe('2026-10-08T14:18:42.000Z');
  });

  test('ช่องกรอก: ค่าที่มี Z/offset คงความละเอียดมิลลิวินาที; ว่าง/ผิดรูปแบบ -> undefined', () => {
    expect(thaiInputToIso('2026-10-08T14:18:42.123456Z')).toBe('2026-10-08T14:18:42.123Z');
    expect(thaiInputToIso('2026-10-08T21:18:42+07:00')).toBe('2026-10-08T14:18:42.000Z');
    for (const bad of [undefined, '', '   ', 'abc', '2026-13-45T00:00', '2026-10-08']) expect(thaiInputToIso(bad)).toBeUndefined();
  });

  test('ค่าในช่อง datetime-local: เวลาไทยคงเดิม, ค่า UTC แปลงเป็นเวลาไทย', () => {
    expect(toThaiInputValue('2026-10-08T00:00')).toBe('2026-10-08T00:00');
    expect(toThaiInputValue('2026-10-07T17:00:00.000Z')).toBe('2026-10-08T00:00:00');
    expect(toThaiInputValue(undefined)).toBe('');
    expect(toThaiInputValue('garbage')).toBe('');
  });
});

describe('DPO Console: หน้าจริงแสดงเวลาไทย', () => {
  // วันที่ 5 ของเดือนปัจจุบัน 18:30 UTC = วันที่ 6 01:30 เวลาไทย (ข้ามวัน, ไม่ข้ามเดือน และอยู่ใน partition ของ access_log)
  const now = new Date();
  const y = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const at = (day, time) => new Date(`${y}-${mm}-${String(day).padStart(2, '0')}T${time}Z`);
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const thai = (day, time) => `${day} ${MONTHS[now.getUTCMonth()]} ${y + 543} ${time}`;

  test('access log: เวลาไทย พ.ศ. 24 ชม. (ไม่ใช่ ISO/UTC เดิม)', async () => {
    const personId = await makePerson();
    await insertAccessLog(personId, { accessedAt: at(5, '18:30:00') });
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs').query({ personId });
    expect(res.status).toBe(200);
    expect(res.text).toContain(thai(6, '01:30:00'));
    expect(res.text).not.toContain(`${y}-${mm}-05 18:30:00`);
  });

  test('change-logs (ทั้งระบบ และของบุคคล): เวลาไทย พ.ศ.', async () => {
    const personId = await makePerson();
    await insertChangeLog(personId, { fieldName: 'field.thai-time', changedAt: at(5, '18:30:00') });
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const all = await agent.get('/dpo/change-logs').query({ source: 'PERSON', personId });
    expect(all.status).toBe(200);
    expect(all.text).toContain('field.thai-time');
    expect(all.text).toContain(thai(6, '01:30:00'));
    const one = await agent.get(`/dpo/persons/${personId}/change-log`);
    expect(one.text).toContain(thai(6, '01:30:00'));
  });

  test('ตัวกรอง from/to ตีความเป็นเวลาไทย: วันที่ 6 (เวลาไทย) = 5th 17:00Z ถึง 6th 16:59Z', async () => {
    const personId = await makePerson();
    const before = crypto.randomUUID();
    const inside = crypto.randomUUID();
    const after = crypto.randomUUID();
    await insertAccessLog(personId, { accessedAt: at(5, '16:59:00'), requestId: before }); // ไทย 5th 23:59 -> นอกช่วง
    await insertAccessLog(personId, { accessedAt: at(5, '17:30:00'), requestId: inside }); // ไทย 6th 00:30 -> ในช่วง
    await insertAccessLog(personId, { accessedAt: at(6, '17:00:30'), requestId: after }); // ไทย 7th 00:00:30 -> นอกช่วง
    const agent = await loginAsDpo(harness.dpoConsoleApp);
    const res = await agent.get('/dpo/access-logs').query({ personId, from: `${y}-${mm}-06T00:00`, to: `${y}-${mm}-06T23:59` });
    expect(res.status).toBe(200);
    expect(res.text).toContain(thai(6, '00:30:00'));
    expect(res.text).not.toContain(thai(5, '23:59:00'));
    expect(res.text).not.toContain(thai(7, '00:00:30'));
    // ค่าในช่องกรอกยังเป็นเวลาที่ผู้ใช้พิมพ์ (ไม่ถูกเลื่อนด้วย TZ ของเครื่อง)
    expect(res.text).toContain(`name="from" value="${y}-${mm}-06T00:00"`);
  });
});
