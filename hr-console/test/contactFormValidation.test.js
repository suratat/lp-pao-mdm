const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');

// หน้าแก้ข้อมูลติดต่อของ HR Console: ไม่มีบ้านเลขที่/ที่อยู่ข้อความเต็ม, ป้าย "อีเมล", ตรวจรูปแบบเบอร์/อีเมล, ปุ่มตรวจสอบอีเมล (mock DNS)
// รันกับ MDM API จริง + Postgres จริง ข้อมูลทั้งหมดสมมติ

let harness;
let adminPool;
let orgId;
let dnsStatus = 'ok';
let dnsCalls = [];

const tag = crypto.randomUUID().slice(0, 8);
const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const versionFrom = (html) => /name="expectedVersion" value="(\d+)"/.exec(html)?.[1];

beforeAll(async () => {
  harness = await buildIntegrationHarness({
    emailCheck: {
      checkDomain: async (email) => {
        dnsCalls.push(email);
        return dnsStatus;
      },
    },
  });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  const { rows } = await adminPool.query(`INSERT INTO mdm.org_unit (code, name_th, unit_level) VALUES ($1, $2, 'DIVISION') RETURNING org_unit_id`, [`CV-${tag}`, `หน่วยงานตรวจรูปแบบ ${tag}`]);
  orgId = rows[0].org_unit_id;
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

beforeEach(() => {
  dnsStatus = 'ok';
  dnsCalls = [];
});

const adminAgent = () => loginAsHrOfficer(harness.hrConsoleApp, 'persons-admin-code');

async function createPerson(agent) {
  const form = await agent.get('/hr/persons/new');
  const { rows: pos } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, 'ตำแหน่งทดสอบ', 'GENERAL', $2) RETURNING position_id`,
    [`CV-POS-${crypto.randomUUID()}`, orgId]
  );
  const res = await agent.post('/hr/persons/new').type('form').send({
    _csrf: csrfFrom(form.text),
    pid: makeFakePid(),
    firstNameTh: `สมชาย${tag}`,
    lastNameTh: `ทดสอบ${tag}`,
    birthDate: '1990-05-17',
    reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
    personnelType: 'CIVIL_SERVANT',
    orgUnitId: orgId,
    positionId: pos[0].position_id,
    effectiveFrom: '2024-01-01',
  });
  const personId = /\/hr\/persons\/([0-9a-f-]{36})/.exec(res.headers.location || '')?.[1];
  expect(personId).toBeTruthy();
  return personId;
}

const contactRow = async (personId) => (await adminPool.query(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [personId])).rows[0];

async function postContact(agent, personId, fields, reason = 'ปรับปรุงข้อมูลตามคำขอของเจ้าตัว') {
  const form = await agent.get(`/hr/persons/${personId}/contact/edit`);
  return agent
    .post(`/hr/persons/${personId}/contact/edit`)
    .type('form')
    .send({ _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), reason, ...fields });
}

describe('หน้าแก้ข้อมูลติดต่อ (HR)', () => {
  test('ไม่มีช่องที่อยู่ปัจจุบันเลย, ป้ายเป็น "อีเมล", มีปุ่มตรวจสอบอีเมล (ซ่อนจนกว่า JS ทำงาน) และฟอร์มบันทึกได้เมื่อ JS ปิด', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const res = await admin.get(`/hr/persons/${personId}/contact/edit`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('บ้านเลขที่');
    expect(res.text).not.toContain('ข้อความเต็ม');
    expect(res.text).not.toContain('name="houseNo"');
    expect(res.text).not.toContain('name="fullText"');
    expect(res.text).not.toContain('อีเมลส่วนตัว');
    expect(res.text).toMatch(/<label for="emailPersonal">อีเมล/);
    expect(res.text).toContain('data-contact-form');
    expect(res.text).toMatch(/data-email-check-box hidden/);
    for (const name of ['moo', 'soi', 'road', 'postcode', 'sameAsRegistered']) expect(res.text).not.toContain(`name="${name}"`);
    expect(res.text).not.toContain('ที่อยู่ปัจจุบัน');
    expect(res.text).toContain(`/hr/persons/${personId}/contact/check-email`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('เบอร์/อีเมลไม่ผ่าน -> 422 ข้อความไทย คงค่าที่พิมพ์ไว้ ไม่เขียน DB', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const res = await postContact(admin, personId, { mobilePhone: '0712345678', phoneAlt: '02-12', emailPersonal: 'bad@@example', lineId: 'keepline' });

    expect(res.status).toBe(422);
    expect(res.text).toContain('เบอร์มือถือไม่ถูกต้อง');
    expect(res.text).toContain('โทรศัพท์สำรองไม่ถูกต้อง');
    expect(res.text).toContain('รูปแบบอีเมลไม่ถูกต้อง');
    expect(res.text).toContain('value="0712345678"');
    expect(res.text).toContain('value="keepline"');
    expect(await contactRow(personId)).toBeUndefined();
  });

  test('ผ่าน: เบอร์เก็บเป็นตัวเลขล้วน (+66 -> 0), อีเมล trim', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const res = await postContact(admin, personId, { mobilePhone: '+66 81-234-5678', phoneAlt: '(02) 123-4567', emailPersonal: ' a@example.com ' });

    expect(res.status).toBe(303);
    const row = await contactRow(personId);
    expect([row.mobile_phone, row.phone_alt, row.email_personal]).toEqual(['0812345678', '021234567', 'a@example.com']);
  });

  test('ค่าว่างล้างค่าเดิมได้ (ไม่บังคับ)', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    expect((await postContact(admin, personId, { mobilePhone: '0812345678', emailPersonal: 'a@example.com' })).status).toBe(303);
    expect((await postContact(admin, personId, { mobilePhone: '', emailPersonal: '' })).status).toBe(303);
    const row = await contactRow(personId);
    expect([row.mobile_phone, row.email_personal]).toEqual([null, null]);
  });

  test('ค่าเดิมที่ไม่ผ่านกติกาใหม่ แต่ไม่ได้แก้ -> บันทึกฟิลด์อื่นได้ ค่าเดิมคงอยู่; แก้เป็นค่าที่ไม่ผ่าน -> 422', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    await adminPool.query(`INSERT INTO mdm.person_contact (person_id, mobile_phone, email_personal, updated_by, updated_at) VALUES ($1, '081-234-567', 'old@localhost', 'HR', now())`, [personId]);

    const page = await admin.get(`/hr/persons/${personId}/contact/edit`);
    expect(page.text).toContain('data-original="081-234-567"');

    const ok = await postContact(admin, personId, { mobilePhone: '081-234-567', emailPersonal: 'old@localhost', lineId: 'newline' });
    expect(ok.status).toBe(303);
    const row = await contactRow(personId);
    expect([row.mobile_phone, row.email_personal, row.line_id]).toEqual(['081-234-567', 'old@localhost', 'newline']);

    const bad = await postContact(admin, personId, { mobilePhone: '081-234-566', emailPersonal: 'old@localhost', lineId: 'newline' });
    expect(bad.status).toBe(422);
    // ฟอร์มที่วาดซ้ำยังรู้ว่าค่าเดิมคืออะไร (ช่องอีเมลที่ไม่ได้แก้ไม่ถูกบังคับ)
    expect(bad.text).toContain('data-original="old@localhost"');
  });

  test('ไม่ล้าง/ไม่แก้บ้านเลขที่และที่อยู่ข้อความเต็มที่เก็บไว้เดิม แม้ผู้ใช้ส่งฟิลด์เหล่านั้นมา', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    await adminPool.query(`INSERT INTO mdm.person_contact (person_id, cur_house_no, cur_address_text, updated_by, updated_at) VALUES ($1, '99/1', 'ที่อยู่เดิม', 'HR', now())`, [personId]);

    const res = await postContact(admin, personId, { mobilePhone: '0812345678', houseNo: 'ใหม่', fullText: 'ไม่ควรถูกเก็บ' });
    expect(res.status).toBe(303);
    const row = await contactRow(personId);
    expect([row.cur_house_no, row.cur_address_text, row.mobile_phone]).toEqual(['99/1', 'ที่อยู่เดิม', '0812345678']);
  });

  test('หน้าประวัติแสดงป้ายภาษาไทย "อีเมล" แทนชื่อฟิลด์ดิบ', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    await postContact(admin, personId, { emailPersonal: 'a@example.com', mobilePhone: '0812345678' });
    const history = await admin.get(`/hr/persons/${personId}`);
    expect(history.status).toBe(200);
    expect(history.text).toContain('<td>อีเมล</td>');
    expect(history.text).not.toContain('อีเมลส่วนตัว');
    expect(history.text).not.toContain('contact.email_personal');
  });
});

describe('POST /hr/persons/:id/contact/check-email', () => {
  const urlOf = (personId) => `/hr/persons/${personId}/contact/check-email`;
  const csrfOf = async (agent, personId) => csrfFrom((await agent.get(`/hr/persons/${personId}/contact/edit`)).text);
  const post = (agent, personId, csrf, body) => agent.post(urlOf(personId)).set('X-CSRF-Token', csrf).send(body);

  test('ไม่ล็อกอิน -> 401 JSON ไม่ redirect และไม่ค้น DNS', async () => {
    const res = await request(harness.hrConsoleApp).post(urlOf(crypto.randomUUID())).send({ email: 'a@example.com' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 'unauthorized' });
    expect(dnsCalls).toHaveLength(0);
  });

  test('hr_officer ที่ไม่มี hr_master_data_admin -> 403 JSON และไม่ค้น DNS', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const officer = await loginAsHrOfficer(harness.hrConsoleApp, 'good-code');
    const res = await officer.post(urlOf(personId)).set('X-CSRF-Token', 'x').send({ email: 'a@example.com' });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe('forbidden');
    expect(dnsCalls).toHaveLength(0);
  });

  test('CSRF header ผิด/ไม่มี -> 403 JSON', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const wrong = await post(admin, personId, 'wrong-token', { email: 'a@example.com' });
    expect(wrong.status).toBe(403);
    const missing = await admin.post(urlOf(personId)).send({ email: 'a@example.com' });
    expect(missing.status).toBe(403);
    expect(dnsCalls).toHaveLength(0);
  });

  test.each([
    ['ok', 'รูปแบบถูกต้องและโดเมนรับอีเมลได้'],
    ['no_mx', 'โดเมนนี้ไม่มีเซิร์ฟเวอร์รับอีเมล'],
    ['unavailable', 'ตรวจสอบไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง'],
  ])('ผลตรวจ %s -> ข้อความไทยตามสเปก', async (status, message) => {
    dnsStatus = status;
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const res = await post(admin, personId, await csrfOf(admin, personId), { email: 'somchai@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status, message });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(dnsCalls).toEqual(['somchai@example.com']);
  });

  test('รูปแบบไม่ถูกต้อง -> invalid พร้อมข้อความไทยโดยไม่ค้น DNS; ไม่ใส่อีเมลใน log', async () => {
    const logs = [];
    const spies = ['log', 'info', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logs.push(JSON.stringify(a))));
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const res = await post(admin, personId, await csrfOf(admin, personId), { email: 'zz-sentinel@@bad' });
    spies.forEach((s) => s.mockRestore());

    expect(res.body.status).toBe('invalid');
    expect(res.body.message).toContain('รูปแบบอีเมลไม่ถูกต้อง');
    expect(JSON.stringify(res.body)).not.toContain('sentinel');
    expect(logs.join('')).not.toContain('sentinel');
    expect(dnsCalls).toHaveLength(0);
  });

  test('rate limit 10 ครั้ง/นาทีต่อ session: ครั้งที่ 11 -> 429', async () => {
    const admin = await adminAgent();
    const personId = await createPerson(admin);
    const csrf = await csrfOf(admin, personId);
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await post(admin, personId, csrf, { email: 'a@example.com' })).status).toBe(200);
    }
    const eleventh = await post(admin, personId, csrf, { email: 'a@example.com' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toMatchObject({ status: 'rate_limited' });
    expect(dnsCalls).toHaveLength(10);
  });
});
