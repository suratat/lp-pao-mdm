const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');

// ซ่อนหน้า "ผู้ติดต่อฉุกเฉิน" ของ HR Console (HR_EMERGENCY_CONTACTS_ENABLED): ระบุ flag ตรง ๆ ทั้งสองโหมดเสมอ ไม่พึ่ง env ของเครื่องที่รันเทสต์
// ปิด = GET/POST 404, ไม่มีปุ่ม, ข้อมูลที่บันทึกไว้และ log ไม่ถูกแตะ; เปิด = ทำงานเหมือนเดิม

const tag = crypto.randomUUID().slice(0, 8);
const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const versionFrom = (html) => /name="expectedVersion" value="(\d+)"/.exec(html)?.[1];
const NAME = `ญาติสมมติ${tag}`;

let adminPool;
let orgId;

beforeAll(async () => {
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  const org = await adminPool.query(`INSERT INTO mdm.org_unit (code, name_th, unit_level) VALUES ($1, $2, 'DIVISION') RETURNING org_unit_id`, [`EH-${tag}`, `หน่วยงานทดสอบซ่อน ${tag}`]);
  orgId = org.rows[0].org_unit_id;
});

afterAll(async () => {
  await adminPool.end();
});

// ตำแหน่งหนึ่งมีผู้ครองได้คนเดียว -> สร้างตำแหน่งใหม่ต่อบุคคล
async function createPerson(agent) {
  const pos = await adminPool.query(`INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, 'ตำแหน่งทดสอบซ่อน', 'GENERAL', $2) RETURNING position_id`, [`EH-POS-${tag}-${crypto.randomUUID().slice(0, 6)}`, orgId]);
  const positionId = pos.rows[0].position_id;
  const form = await agent.get('/hr/persons/new');
  const res = await agent.post('/hr/persons/new').type('form').send({
    _csrf: csrfFrom(form.text),
    pid: makeFakePid(),
    firstNameTh: `สมชาย${tag}`,
    lastNameTh: `ทดสอบ${tag}`,
    reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
    personnelType: 'CIVIL_SERVANT',
    orgUnitId: orgId,
    positionId,
    effectiveFrom: '2024-01-01',
  });
  const personId = /\/hr\/persons\/([0-9a-f-]{36})/.exec(res.headers.location || '')?.[1];
  expect(personId).toBeTruthy();
  return personId;
}

const emergencyRows = async (personId) => (await adminPool.query(`SELECT full_name FROM mdm.emergency_contact WHERE person_id = $1`, [personId])).rows;
const logCount = async (personId) => Number((await adminPool.query(`SELECT count(*) FROM audit.data_change_log WHERE person_id = $1`, [personId])).rows[0].count);
const slot1 = { c1_fullName: NAME, c1_relationship: 'คู่สมรส', c1_phone: '0861112222' };

describe('HR Console: หน้าผู้ติดต่อฉุกเฉินปิด (ค่าเริ่มต้น)', () => {
  let harness;
  beforeAll(async () => {
    harness = await buildIntegrationHarness({ emergencyContactsEnabled: false });
  });
  afterAll(() => harness.close());

  test('GET/POST 404, ไม่มีปุ่มในหน้ารายละเอียด, ไม่เขียนข้อมูล/log; หน้าอื่นยังเปิดได้', async () => {
    const admin = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-admin-code');
    const personId = await createPerson(admin);
    const logsBefore = await logCount(personId);

    const detail = await admin.get(`/hr/persons/${personId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('emergency-contacts');
    expect(detail.text).not.toContain('แก้ผู้ติดต่อฉุกเฉิน');
    expect(detail.text).toContain(`/hr/persons/${personId}/contact/edit`);
    expect(detail.text).toContain(`/hr/persons/${personId}/expected-identity/edit`);

    expect((await admin.get(`/hr/persons/${personId}/emergency-contacts/edit`)).status).toBe(404);
    const contactForm = await admin.get(`/hr/persons/${personId}/contact/edit`);
    const post = await admin
      .post(`/hr/persons/${personId}/emergency-contacts/edit`)
      .type('form')
      .send({ _csrf: csrfFrom(contactForm.text), expectedVersion: versionFrom(contactForm.text), reason: 'ลองบันทึกตอนหน้าถูกซ่อน', ...slot1 });
    expect(post.status).toBe(404);

    expect(await emergencyRows(personId)).toEqual([]);
    expect(await logCount(personId)).toBe(logsBefore);
    expect((await admin.get(`/hr/persons/${personId}/contact/edit`)).status).toBe(200);
  });

  test('ผู้ใช้ที่ยังไม่ล็อกอินยังถูกส่งไปหน้า login ก่อน (ไม่รั่วว่ามี path)', async () => {
    const res = await require('supertest')(harness.hrConsoleApp).get(`/hr/persons/${crypto.randomUUID()}/emergency-contacts/edit`);
    expect([302, 303, 401]).toContain(res.status);
  });
});

describe('HR Console: หน้าผู้ติดต่อฉุกเฉินเปิด (emergencyContactsEnabled=true)', () => {
  let harness;
  beforeAll(async () => {
    harness = await buildIntegrationHarness({ emergencyContactsEnabled: true });
  });
  afterAll(() => harness.close());

  test('มีปุ่ม, GET แสดงฟอร์ม, POST บันทึกได้ตามเดิม', async () => {
    const admin = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-admin-code');
    const personId = await createPerson(admin);

    const detail = await admin.get(`/hr/persons/${personId}`);
    expect(detail.text).toContain(`/hr/persons/${personId}/emergency-contacts/edit`);
    expect(detail.text).toContain('แก้ผู้ติดต่อฉุกเฉิน');

    const form = await admin.get(`/hr/persons/${personId}/emergency-contacts/edit`);
    expect(form.status).toBe(200);
    const post = await admin
      .post(`/hr/persons/${personId}/emergency-contacts/edit`)
      .type('form')
      .send({ _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), reason: 'เจ้าตัวแจ้งผู้ติดต่อฉุกเฉินใหม่', ...slot1 });
    expect(post.status).toBe(303);
    expect(post.headers.location).toBe(`/hr/persons/${personId}?saved=emergency`);
    expect((await emergencyRows(personId)).map((r) => r.full_name)).toEqual([NAME]);
  });
});
