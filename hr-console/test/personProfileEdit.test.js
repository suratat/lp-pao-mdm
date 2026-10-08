const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { COOKIE_NAME } = require('../src/session/sessionCookie');

// PR-D4: หน้าแก้ข้อมูลติดต่อ / ผู้ติดต่อฉุกเฉิน / ชื่อ-วันเกิดที่ HR กรอก - รันกับ MDM API จริง (in-process) + Postgres จริง + mock Keycloak
// ข้อมูลทั้งหมดสมมติ ตรวจ: สำเร็จ, 409 ทั้งสองแบบ (version-conflict / identity-locked), 422, ไม่มี role, ค่ายาวเกิน และไม่มีเลขบัตร/ข้อมูลติดต่อรั่วใน redirect/log

let harness;
let adminPool;
let orgA;

const tag = crypto.randomUUID().slice(0, 8);
const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const versionFrom = (html) => /name="expectedVersion" value="(\d+)"/.exec(html)?.[1];
const uniq = () => crypto.randomUUID().slice(0, 6);
const dashed = (pid) => `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;

// ข้อมูลติดต่อสมมติที่ต้องไม่รั่วออกนอกหน้าฟอร์ม (redirect/log/หน้ารายละเอียด)
const PHONE = '0812345678';
const PHONE_NEW = '0898765432';
const EMAIL = `somchai.${tag}@example.test`;
const LINE = `line-${tag}`;
const EMERGENCY_NAME = `ญาติสมมติ${tag}`;
const EMERGENCY_PHONE = '0861112222';

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  const code = `PF-${tag}`;
  const { rows } = await adminPool.query(`INSERT INTO mdm.org_unit (code, name_th, unit_level) VALUES ($1, $2, 'DIVISION') RETURNING org_unit_id`, [code, `หน่วยงานโปรไฟล์ ${tag}`]);
  orgA = { id: rows[0].org_unit_id };
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

const adminAgent = (code = 'persons-admin-code') => loginAsHrOfficer(harness.hrConsoleApp, code);

async function makePos() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, $2, 'GENERAL', $3) RETURNING position_id`,
    [`PF-POS-${uniq()}-${tag}`, 'ตำแหน่งทดสอบโปรไฟล์', orgA.id]
  );
  return rows[0].position_id;
}

// สร้างบุคคล PENDING_CLAIM ผ่านหน้าเพิ่มบุคคลจริง
async function createPerson(agent) {
  const form = await agent.get('/hr/persons/new');
  const pid = makeFakePid();
  const res = await agent
    .post('/hr/persons/new')
    .type('form')
    .send({
      _csrf: csrfFrom(form.text),
      pid,
      firstNameTh: `สมชาย${tag}`,
      lastNameTh: `ทดสอบ${tag}`,
      birthDate: '1990-05-17',
      reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
      personnelType: 'CIVIL_SERVANT',
      orgUnitId: orgA.id,
      positionId: await makePos(),
      effectiveFrom: '2024-01-01',
    });
  const personId = /\/hr\/persons\/([0-9a-f-]{36})/.exec(res.headers.location || '')?.[1];
  expect(personId).toBeTruthy();
  return { personId, pid };
}

const personRow = async (personId) =>
  (await adminPool.query(`SELECT status, version, expected_first_name_th AS first, expected_last_name_th AS last, expected_birth_date::text AS birth FROM mdm.person WHERE person_id = $1`, [personId])).rows[0];
const contactRow = async (personId) => (await adminPool.query(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [personId])).rows[0];
const emergencyRows = async (personId) => (await adminPool.query(`SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact WHERE person_id = $1 ORDER BY priority`, [personId])).rows;
const logsFor = async (personId, table) =>
  (await adminPool.query(`SELECT field_name, old_value, new_value, changed_by, actor_sub, actor_client, reason FROM audit.data_change_log WHERE person_id = $1 AND table_name = $2 ORDER BY log_id`, [personId, table])).rows;
// ทำเหมือนที่ /sync/thaid ทำตอน claim: ตั้ง thaid_verified_at/claimed_at + version+1 (trigger ของ DB ห้ามแก้ expected_* หลังจากนี้)
async function markVerified(personId) {
  await adminPool.query(`UPDATE mdm.person SET thaid_verified_at = now(), claimed_at = now(), status = 'ACTIVE', verification_status = 'VERIFIED', version = version + 1 WHERE person_id = $1`, [personId]);
}
async function bumpVersion(personId) {
  await adminPool.query(`UPDATE mdm.person SET version = version + 1 WHERE person_id = $1`, [personId]);
}

const logged = [];
let spies = [];
beforeEach(() => {
  logged.length = 0;
  spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation((...args) => logged.push(JSON.stringify(args))));
});
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

function expectNotIn(secrets, ...texts) {
  for (const text of [...texts, ...logged]) for (const secret of secrets) expect(String(text)).not.toContain(secret);
}

async function postContact(agent, personId, fields, { version, csrf, reason = 'ปรับปรุงข้อมูลตามคำขอของเจ้าตัว' } = {}) {
  const form = await agent.get(`/hr/persons/${personId}/contact/edit`);
  return agent
    .post(`/hr/persons/${personId}/contact/edit`)
    .type('form')
    .send({ _csrf: csrf ?? csrfFrom(form.text), expectedVersion: version ?? versionFrom(form.text), reason, ...fields });
}

describe('สิทธิ์และหน้ารายละเอียด', () => {
  test('hr_officer ธรรมดา: ทุกหน้าแก้ 403 ภาษาไทย (GET/POST), ไม่เห็นปุ่มแก้ และไม่เห็นข้อมูลติดต่อเลย; ผู้ดูแลเห็นปุ่มแต่หน้ารายละเอียดไม่แสดงค่าติดต่อ', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const ok = await postContact(admin, personId, { mobilePhone: PHONE, emailPersonal: EMAIL, lineId: LINE });
    expect(ok.status).toBe(303);

    const officer = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-officer-manage-scope-code');
    const before = await personRow(personId);
    for (const sub of ['contact/edit', 'emergency-contacts/edit', 'expected-identity/edit']) {
      // eslint-disable-next-line no-await-in-loop
      const get = await officer.get(`/hr/persons/${personId}/${sub}`);
      expect(get.status).toBe(403);
      expect(get.text).toContain('hr_master_data_admin');
      expectNotIn([PHONE, EMAIL, LINE], get.text);
      // eslint-disable-next-line no-await-in-loop
      const post = await officer.post(`/hr/persons/${personId}/${sub}`).type('form').send({ _csrf: 'x', expectedVersion: '1', reason: 'ลองแก้โดยไม่มีสิทธิ์', mobilePhone: PHONE_NEW });
      expect(post.status).toBe(403);
    }
    expect(await personRow(personId)).toEqual(before);

    const detailOfficer = await officer.get(`/hr/persons/${personId}`);
    expect(detailOfficer.status).toBe(200);
    for (const part of ['contact/edit', 'emergency-contacts/edit', 'expected-identity/edit']) expect(detailOfficer.text).not.toContain(part);
    expectNotIn([PHONE, EMAIL, LINE], detailOfficer.text);

    const detailAdmin = await admin.get(`/hr/persons/${personId}`);
    for (const part of ['contact/edit', 'emergency-contacts/edit', 'expected-identity/edit']) expect(detailAdmin.text).toContain(`/hr/persons/${personId}/${part}`);
    expectNotIn([PHONE, EMAIL, LINE], detailAdmin.text);
  });

  test('console ปล่อยผ่าน (session ถูกยกเป็น admin) แต่ token ไม่มี role -> MDM API ตอบ 403 และ console แสดงข้อความไทย ไม่ใช่ 500; ไม่มีอะไรถูกเขียน', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const officer = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-officer-manage-scope-code');
    const sid = officer.jar.getCookies(require('cookiejar').CookieAccessInfo.All).find((c) => c.name === COOKIE_NAME).value;
    harness.sessionStore.update(sid, { isMasterDataAdmin: true });

    for (const sub of ['contact/edit', 'emergency-contacts/edit', 'expected-identity/edit']) {
      // eslint-disable-next-line no-await-in-loop
      const get = await officer.get(`/hr/persons/${personId}/${sub}`);
      expect(get.status).toBe(403);
      expect(get.text).toContain('ไม่มีสิทธิ์ทำรายการนี้');
    }
    // เปิดหน้าใดหน้าหนึ่งก่อนเพื่อให้ session มี csrfToken แล้วดึงจาก store ฝั่งเซิร์ฟเวอร์ (หน้าฟอร์มของ officer ถูก API ปฏิเสธเลยไม่มีให้ดึงจาก HTML)
    await officer.get('/hr/persons');
    const csrfToken = harness.sessionStore.get(sid).csrfToken;
    const post = await officer
      .post(`/hr/persons/${personId}/contact/edit`)
      .type('form')
      .send({ _csrf: csrfToken, expectedVersion: '1', reason: 'ลองแก้โดยไม่มีสิทธิ์', mobilePhone: PHONE });
    expect(post.status).toBe(403);
    expect(post.text).toContain('hr_master_data_admin');
    expect(await contactRow(personId)).toBeUndefined();
  });

  test('CSRF ไม่ถูกต้อง -> 403 ไม่เขียนอะไร; personId ไม่ใช่ UUID -> 404', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    for (const sub of ['contact/edit', 'emergency-contacts/edit', 'expected-identity/edit']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await admin.post(`/hr/persons/${personId}/${sub}`).type('form').send({ _csrf: 'wrong', expectedVersion: '1', reason: 'ลองแก้ด้วย token ผิด', mobilePhone: PHONE });
      expect(res.status).toBe(403);
      expect(res.text).toContain('CSRF');
    }
    expect((await admin.get('/hr/persons/not-a-uuid/contact/edit')).status).toBe(404);
    expect(await contactRow(personId)).toBeUndefined();
  });
});

describe('แก้ข้อมูลติดต่อ', () => {
  test('GET: ฟอร์มมี CSRF + expectedVersion, ไม่ cache, ช่องเหตุผลบังคับ; สำเร็จ: ส่งเฉพาะฟิลด์ที่เปลี่ยน, log มีผู้กระทำ+เหตุผล, redirect ไม่มีข้อมูลติดต่อ', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const form = await admin.get(`/hr/persons/${personId}/contact/edit`);
    expect(form.status).toBe(200);
    expect(form.headers['cache-control']).toBe('no-store');
    expect(csrfFrom(form.text)).toBeTruthy();
    expect(versionFrom(form.text)).toBe('1');
    expect(form.text).toMatch(/<textarea name="reason"[^>]*required>/);

    const first = await postContact(admin, personId, { mobilePhone: PHONE, phoneAlt: '', emailPersonal: EMAIL, lineId: LINE, houseNo: '12', moo: '3', soi: '', road: 'ถนนสมมติ', postcode: '52000', fullText: '' });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe(`/hr/persons/${personId}?saved=contact`);
    expectNotIn([PHONE, EMAIL, LINE], first.headers.location, first.text);
    expect(await contactRow(personId)).toMatchObject({ mobile_phone: PHONE, email_personal: EMAIL, line_id: LINE, cur_house_no: '12', cur_moo: '3', cur_road: 'ถนนสมมติ', cur_postcode: '52000', phone_alt: null, updated_by: 'HR' });
    expect((await personRow(personId)).version).toBe(2);

    const detail = await admin.get(first.headers.location);
    expect(detail.text).toContain('บันทึกข้อมูลติดต่อเรียบร้อยแล้ว');
    expectNotIn([PHONE, EMAIL, LINE], detail.text);

    // รอบสอง: เปลี่ยนมือถือ + ล้าง LINE (ช่องว่าง = ล้าง) ช่องอื่นคงเดิม -> log เฉพาะสองฟิลด์
    const logsBefore = (await logsFor(personId, 'person_contact')).length;
    const second = await postContact(admin, personId, { mobilePhone: PHONE_NEW, phoneAlt: '', emailPersonal: EMAIL, lineId: '', houseNo: '12', moo: '3', soi: '', road: 'ถนนสมมติ', postcode: '52000', fullText: '' }, { reason: 'เจ้าตัวแจ้งเปลี่ยนเบอร์และเลิกใช้ LINE' });
    expect(second.status).toBe(303);
    expect(second.headers.location).toBe(`/hr/persons/${personId}?saved=contact`);
    const row = await contactRow(personId);
    expect(row).toMatchObject({ mobile_phone: PHONE_NEW, line_id: null, email_personal: EMAIL, cur_road: 'ถนนสมมติ' });
    const newLogs = (await logsFor(personId, 'person_contact')).slice(logsBefore);
    expect(newLogs).toHaveLength(2);
    for (const log of newLogs) {
      expect(log.changed_by).toBe('HR');
      expect(log.actor_sub).toBeTruthy();
      expect(log.reason).toBe('เจ้าตัวแจ้งเปลี่ยนเบอร์และเลิกใช้ LINE');
    }
    expectNotIn([PHONE, PHONE_NEW, EMAIL, LINE], second.headers.location, second.text);
  });

  test('ไม่มีอะไรเปลี่ยน: ไม่เรียกเขียน, version คงเดิม, redirect ?saved=nochange', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    await postContact(admin, personId, { mobilePhone: PHONE });
    const version = (await personRow(personId)).version;
    const logs = (await logsFor(personId, 'person_contact')).length;
    const res = await postContact(admin, personId, { mobilePhone: PHONE });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=nochange`);
    expect((await personRow(personId)).version).toBe(version);
    expect(await logsFor(personId, 'person_contact')).toHaveLength(logs);
  });

  test('409 version-conflict: คนอื่นแก้ระหว่างเปิดฟอร์ม -> ข้อความไทย + ปุ่มโหลดข้อมูลล่าสุด, ไม่เขียนอะไร; โหลดใหม่แล้วบันทึกได้', async () => {
    const admin = await adminAgent();
    const other = await adminAgent('persons-admin-two-code');
    const { personId } = await createPerson(admin);
    const form = await admin.get(`/hr/persons/${personId}/contact/edit`);
    const stale = { csrf: csrfFrom(form.text), version: versionFrom(form.text) };

    expect((await postContact(other, personId, { mobilePhone: PHONE })).status).toBe(303);
    const res = await postContact(admin, personId, { mobilePhone: PHONE_NEW }, stale);
    expect(res.status).toBe(409);
    expect(res.text).toContain('ถูกแก้ไขโดยผู้อื่น');
    expect(res.text).toContain('โหลดข้อมูลล่าสุด');
    expect(res.text).toContain(`href="/hr/persons/${personId}/contact/edit"`);
    expect((await contactRow(personId)).mobile_phone).toBe(PHONE);
    expectNotIn([PHONE_NEW], res.text);

    expect((await postContact(admin, personId, { mobilePhone: PHONE_NEW })).status).toBe(303);
    expect((await contactRow(personId)).mobile_phone).toBe(PHONE_NEW);
  });

  test('422: ไม่มีเหตุผล / เหตุผลมีเลขบัตร / เบอร์ผิด / อีเมลผิด / ค่ามีเลข 13 หลัก -> 422 ภาษาไทย คงค่าที่พิมพ์ ไม่เขียน ไม่รั่วเลขบัตร', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const pid = makeFakePid();

    const noReason = await postContact(admin, personId, { mobilePhone: PHONE }, { reason: '   ' });
    expect(noReason.status).toBe(422);
    expect(noReason.text).toContain('กรุณาระบุเหตุผล');
    expect(noReason.text).toContain(`value="${PHONE}"`);

    const pidReason = await postContact(admin, personId, { mobilePhone: PHONE }, { reason: `ตามบัตร ${dashed(pid)} ของเจ้าตัว` });
    expect(pidReason.status).toBe(422);
    expect(pidReason.text).toContain('ห้ามใส่เลขบัตรประชาชนในเหตุผล');
    expectNotIn([pid, dashed(pid)], pidReason.text);

    const bad = await postContact(admin, personId, { mobilePhone: '12345', emailPersonal: 'not-an-email', lineId: `id ${pid}` });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain('เบอร์โทรศัพท์มือถือต้องเป็นตัวเลข');
    expect(bad.text).toContain('รูปแบบอีเมลไม่ถูกต้อง');
    expect(bad.text).toContain('LINE ID');
    expectNotIn([pid], bad.text);

    expect(await contactRow(personId)).toBeUndefined();
    expect((await personRow(personId)).version).toBe(1);
  });

  test('ค่ายาวเกิน: ทุกช่องที่มีเพดานถูกปฏิเสธด้วย 422 ภาษาไทย (ไม่ใช่ 500) และไม่เขียนอะไร', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const res = await postContact(admin, personId, {
      phoneAlt: '1'.repeat(21),
      lineId: 'ก'.repeat(101),
      houseNo: '1'.repeat(51),
      moo: '1'.repeat(21),
      soi: 'ก'.repeat(101),
      road: 'ก'.repeat(101),
      postcode: '1'.repeat(11),
      fullText: 'ก'.repeat(2001),
      emailPersonal: `${'a'.repeat(250)}@example.test`,
    });
    expect(res.status).toBe(422);
    for (const label of ['เบอร์โทรสำรอง', 'LINE ID', 'บ้านเลขที่', 'หมู่ที่', 'ซอย', 'ถนน', 'รหัสไปรษณีย์', 'ที่อยู่ปัจจุบัน (ข้อความเต็ม)', 'อีเมลส่วนตัว']) {
      expect(res.text).toContain(`${label}ยาวเกิน`);
    }
    expect(await contactRow(personId)).toBeUndefined();

    const reasonTooLong = await postContact(admin, personId, { mobilePhone: PHONE }, { reason: 'ก'.repeat(501) });
    expect(reasonTooLong.status).toBe(422);
    expect(reasonTooLong.text).toContain('เหตุผลยาวเกิน');
  });

  test('ไม่มีข้อมูลติดต่อ/เลขบัตรใน log ของ console ตลอดการทำงานของกลุ่มนี้', async () => {
    const admin = await adminAgent();
    const { personId, pid } = await createPerson(admin);
    const res = await postContact(admin, personId, { mobilePhone: PHONE, emailPersonal: EMAIL, lineId: LINE });
    await admin.get(`/hr/persons/${personId}/contact/edit`);
    expect(res.status).toBe(303);
    expectNotIn([PHONE, EMAIL, LINE, pid, dashed(pid)], res.headers.location);
  });
});

describe('แก้ผู้ติดต่อฉุกเฉิน', () => {
  async function postEmergency(agent, personId, fields, { version, csrf, reason = 'เจ้าตัวแจ้งผู้ติดต่อฉุกเฉินใหม่' } = {}) {
    const form = await agent.get(`/hr/persons/${personId}/emergency-contacts/edit`);
    return agent
      .post(`/hr/persons/${personId}/emergency-contacts/edit`)
      .type('form')
      .send({ _csrf: csrf ?? csrfFrom(form.text), expectedVersion: version ?? versionFrom(form.text), reason, ...fields });
  }
  const slot = (n, name = '', relationship = '', phone = '') => ({ [`c${n}_fullName`]: name, [`c${n}_relationship`]: relationship, [`c${n}_phone`]: phone });

  test('GET แสดง 3 ช่องตามลำดับ; สำเร็จ: เก็บตามช่อง (priority), log ไม่เก็บค่า, redirect ไม่มีค่า, ข้อความยืนยัน', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const form = await admin.get(`/hr/persons/${personId}/emergency-contacts/edit`);
    expect(form.status).toBe(200);
    for (const n of [1, 2, 3]) expect(form.text).toContain(`ผู้ติดต่อฉุกเฉินลำดับที่ ${n}`);
    expect(form.text).not.toContain('ลำดับที่ 4');

    const res = await postEmergency(admin, personId, { ...slot(1, EMERGENCY_NAME, 'คู่สมรส', EMERGENCY_PHONE), ...slot(2), ...slot(3, 'ญาติสาม', 'พี่ชาย', '0870001111') });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=emergency`);
    expectNotIn([EMERGENCY_NAME, EMERGENCY_PHONE], res.headers.location, res.text);
    expect(await emergencyRows(personId)).toEqual([
      { full_name: EMERGENCY_NAME, relationship: 'คู่สมรส', phone: EMERGENCY_PHONE, priority: 1 },
      { full_name: 'ญาติสาม', relationship: 'พี่ชาย', phone: '0870001111', priority: 3 },
    ]);
    const logs = await logsFor(personId, 'emergency_contact');
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      expect(log.old_value).toBeNull();
      expect(log.new_value).toBeNull();
      expect(log.changed_by).toBe('HR');
      expect(log.actor_sub).toBeTruthy();
      expect(JSON.stringify(log)).not.toContain(EMERGENCY_NAME);
    }

    // หน้าแก้ไขแสดงตามช่อง และไม่แสดงช่องที่ว่างเป็นค่าอื่น
    const again = await admin.get(`/hr/persons/${personId}/emergency-contacts/edit`);
    expect(again.text).toContain(`value="${EMERGENCY_NAME}"`);
    expect(again.text).toContain('value="พี่ชาย"');
    expect((await admin.get(res.headers.location)).text).toContain('บันทึกผู้ติดต่อฉุกเฉินเรียบร้อยแล้ว');
  });

  test('แถวที่กรอกไม่ครบถูกปฏิเสธทั้งฟอร์ม พร้อมบอกช่องที่ขาด คงค่าที่พิมพ์ และไม่ลบ/ไม่แก้ของเดิม (ไม่ทิ้งเงียบ)', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    expect((await postEmergency(admin, personId, { ...slot(1, EMERGENCY_NAME, 'คู่สมรส', EMERGENCY_PHONE) })).status).toBe(303);
    const version = (await personRow(personId)).version;

    const res = await postEmergency(admin, personId, { ...slot(1), ...slot(2, 'ชื่อไม่มีเบอร์', 'น้องสาว', ''), ...slot(3, '', '', '0870001111') });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ผู้ติดต่อฉุกเฉินลำดับที่ 2: กรอกไม่ครบ ขาดเบอร์โทร');
    expect(res.text).toContain('ผู้ติดต่อฉุกเฉินลำดับที่ 3: กรอกไม่ครบ ขาดชื่อ-นามสกุล, ความสัมพันธ์');
    expect(res.text).toContain('value="ชื่อไม่มีเบอร์"');
    expect(res.text).toContain('value="0870001111"');
    expect(await emergencyRows(personId)).toEqual([{ full_name: EMERGENCY_NAME, relationship: 'คู่สมรส', phone: EMERGENCY_PHONE, priority: 1 }]);
    expect((await personRow(personId)).version).toBe(version);
  });

  test('ล้างทุกช่อง = ลบทั้งหมด; ไม่เปลี่ยนอะไร = nochange (version คงเดิม)', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const rows = { ...slot(1, EMERGENCY_NAME, 'คู่สมรส', EMERGENCY_PHONE), ...slot(2), ...slot(3) };
    expect((await postEmergency(admin, personId, rows)).status).toBe(303);
    const version = (await personRow(personId)).version;

    const same = await postEmergency(admin, personId, rows);
    expect(same.headers.location).toBe(`/hr/persons/${personId}?saved=nochange`);
    expect((await personRow(personId)).version).toBe(version);

    const cleared = await postEmergency(admin, personId, { ...slot(1), ...slot(2), ...slot(3) });
    expect(cleared.headers.location).toBe(`/hr/persons/${personId}?saved=emergency`);
    expect(await emergencyRows(personId)).toEqual([]);
  });

  test('409 version-conflict + ปุ่มโหลดข้อมูลล่าสุด; ค่ายาวเกิน/มีเลข 13 หลัก/ไม่มีเหตุผล -> 422 ไม่เขียน', async () => {
    const admin = await adminAgent();
    const other = await adminAgent('persons-admin-two-code');
    const { personId } = await createPerson(admin);
    const form = await admin.get(`/hr/persons/${personId}/emergency-contacts/edit`);
    const stale = { csrf: csrfFrom(form.text), version: versionFrom(form.text) };
    expect((await postEmergency(other, personId, { ...slot(1, 'คนแรก', 'แม่', '0861234567') })).status).toBe(303);

    const conflict = await postEmergency(admin, personId, { ...slot(1, EMERGENCY_NAME, 'คู่สมรส', EMERGENCY_PHONE) }, stale);
    expect(conflict.status).toBe(409);
    expect(conflict.text).toContain('โหลดข้อมูลล่าสุด');
    expect(conflict.text).toContain(`href="/hr/persons/${personId}/emergency-contacts/edit"`);
    expect((await emergencyRows(personId)).map((r) => r.full_name)).toEqual(['คนแรก']);

    const pid = makeFakePid();
    const long = await postEmergency(admin, personId, { ...slot(1, 'ก'.repeat(201), 'ย'.repeat(51), '1'.repeat(21)), ...slot(2, `ชื่อ ${pid}`, 'พ่อ', '0861234567') });
    expect(long.status).toBe(422);
    expect(long.text).toContain('ชื่อ-นามสกุลยาวเกิน 200');
    expect(long.text).toContain('ความสัมพันธ์ยาวเกิน 50');
    expect(long.text).toContain('เบอร์โทรยาวเกิน 20');
    expect(long.text).toContain('ห้ามมีตัวเลข 13 หลักติดกัน');
    expectNotIn([pid], long.text);

    const noReason = await postEmergency(admin, personId, { ...slot(1, 'คนแรก', 'แม่', '0861234567') }, { reason: '' });
    expect(noReason.status).toBe(422);
    expect((await emergencyRows(personId)).map((r) => r.full_name)).toEqual(['คนแรก']);
  });
});

describe('แก้ชื่อ-นามสกุลไทยและวันเกิด (ที่ HR กรอก)', () => {
  async function postIdentity(agent, personId, fields, { version, csrf, reason = 'แก้ตามเอกสารสำเนาทะเบียนบ้าน' } = {}) {
    const form = await agent.get(`/hr/persons/${personId}/expected-identity/edit`);
    return agent
      .post(`/hr/persons/${personId}/expected-identity/edit`)
      .type('form')
      .send({ _csrf: csrf ?? csrfFrom(form.text), expectedVersion: version ?? versionFrom(form.text), reason, ...fields });
  }

  test('ยังไม่ยืนยัน: แสดงฟอร์มพร้อมคำอธิบาย "ข้อมูลที่ HR กรอก รอยืนยัน ThaID"; สำเร็จ: แก้ชื่อ + ล้างวันเกิด, log ผู้กระทำ+เหตุผล', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const form = await admin.get(`/hr/persons/${personId}/expected-identity/edit`);
    expect(form.status).toBe(200);
    expect(form.text).toContain('ข้อมูลที่ HR กรอก รอยืนยัน ThaID');
    expect(form.text).toContain(`value="สมชาย${tag}"`);
    expect(form.text).toContain('value="1990-05-17"');
    expect(form.text).toMatch(/<form method="post"/);

    const res = await postIdentity(admin, personId, { firstNameTh: `สมหญิง${tag}`, lastNameTh: `ทดสอบ${tag}`, birthDate: '' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=identity`);
    expect(await personRow(personId)).toMatchObject({ first: `สมหญิง${tag}`, last: `ทดสอบ${tag}`, birth: null, version: 2 });
    const logs = (await logsFor(personId, 'person')).filter((l) => l.reason === 'แก้ตามเอกสารสำเนาทะเบียนบ้าน');
    expect(logs.map((l) => l.field_name).sort()).toEqual(['person.expected_birth_date', 'person.expected_first_name_th']);
    for (const log of logs) expect(log).toMatchObject({ changed_by: 'HR' });
    expect((await admin.get(res.headers.location)).text).toContain('รอยืนยันด้วย ThaID');
  });

  test('ยืนยันแล้ว: GET แสดงเหตุผลที่แก้ไม่ได้แทนฟอร์ม; POST ปลอมแปลง -> 409 identity-locked ภาษาไทย ไม่เขียน ไม่ใช่ 500', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const openForm = await admin.get(`/hr/persons/${personId}/expected-identity/edit`);
    await markVerified(personId);

    const locked = await admin.get(`/hr/persons/${personId}/expected-identity/edit`);
    expect(locked.status).toBe(200);
    expect(locked.text).toContain('แก้ไม่ได้');
    expect(locked.text).toContain('ยืนยันตัวตนผ่าน ThaID แล้ว');
    expect(locked.text).not.toMatch(/<form method="post"/);
    expect(locked.text).not.toContain('name="firstNameTh"');

    // ฟอร์มที่เปิดค้างไว้ก่อนถูกยืนยัน (version เก่า) -> ต้องได้ identity-locked ไม่ใช่ version-conflict
    const res = await admin
      .post(`/hr/persons/${personId}/expected-identity/edit`)
      .type('form')
      .send({ _csrf: csrfFrom(openForm.text), expectedVersion: versionFrom(openForm.text), reason: 'แก้ชื่อหลังยืนยันแล้ว', firstNameTh: 'ชื่อใหม่', lastNameTh: `ทดสอบ${tag}`, birthDate: '1990-05-17' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('ยืนยันตัวตนผ่าน ThaID แล้ว');
    expect(res.text).not.toContain('โหลดข้อมูลล่าสุด');
    expect((await personRow(personId)).first).toBe(`สมชาย${tag}`);
  });

  test('ไม่ใช่ PENDING_CLAIM (เช่น พ้นสภาพ) ก็แก้ไม่ได้และแสดงเหตุผลต่างออกไป', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    await adminPool.query(`UPDATE mdm.person SET status = 'INACTIVE', version = version + 1 WHERE person_id = $1`, [personId]);
    const res = await admin.get(`/hr/persons/${personId}/expected-identity/edit`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('ไม่ได้อยู่ในสถานะรอยืนยันตัวตน');
    expect(res.text).not.toMatch(/<form method="post"/);
  });

  test('409 version-conflict + ปุ่มโหลดข้อมูลล่าสุด; ไม่เขียน', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const form = await admin.get(`/hr/persons/${personId}/expected-identity/edit`);
    await bumpVersion(personId);
    const res = await postIdentity(admin, personId, { firstNameTh: 'ชื่อใหม่', lastNameTh: `ทดสอบ${tag}`, birthDate: '1990-05-17' }, { csrf: csrfFrom(form.text), version: versionFrom(form.text) });
    expect(res.status).toBe(409);
    expect(res.text).toContain('โหลดข้อมูลล่าสุด');
    expect(res.text).toContain(`href="/hr/persons/${personId}/expected-identity/edit"`);
    expect((await personRow(personId)).first).toBe(`สมชาย${tag}`);
  });

  test('422: ชื่อว่าง / ชื่อมีเลข 13 หลัก / ยาวเกิน / วันเกิดในอนาคต / ไม่มีเหตุผล -> ไม่เขียน ไม่รั่วเลขบัตร; ไม่มีอะไรเปลี่ยน -> nochange', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const pid = makeFakePid();

    const bad = await postIdentity(admin, personId, { firstNameTh: '', lastNameTh: `ก${pid}`, birthDate: '2999-01-01' }, { reason: '' });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain('กรุณากรอกชื่อ');
    expect(bad.text).toContain('นามสกุลห้ามมีเลขบัตรประชาชน');
    expect(bad.text).toContain('วันเกิดต้องอยู่ระหว่าง');
    expect(bad.text).toContain('กรุณาระบุเหตุผล');
    expectNotIn([pid], bad.text);

    const long = await postIdentity(admin, personId, { firstNameTh: 'ก'.repeat(201), lastNameTh: `ทดสอบ${tag}`, birthDate: '1990-05-17' });
    expect(long.status).toBe(422);
    expect(long.text).toContain('ชื่อยาวเกิน 200');
    expect((await personRow(personId)).first).toBe(`สมชาย${tag}`);

    const same = await postIdentity(admin, personId, { firstNameTh: `สมชาย${tag}`, lastNameTh: `ทดสอบ${tag}`, birthDate: '1990-05-17' });
    expect(same.headers.location).toBe(`/hr/persons/${personId}?saved=nochange`);
    expect((await personRow(personId)).version).toBe(1);
  });

  test('session ฝั่งเซิร์ฟเวอร์และ cookie ไม่ถือข้อมูลติดต่อที่กรอก', async () => {
    const admin = await adminAgent();
    const { personId } = await createPerson(admin);
    const res = await postContact(admin, personId, { mobilePhone: PHONE, emailPersonal: EMAIL });
    expect(res.status).toBe(303);
    const sid = admin.jar.getCookies(require('cookiejar').CookieAccessInfo.All).find((c) => c.name === COOKIE_NAME).value;
    expectNotIn([PHONE, EMAIL], (res.headers['set-cookie'] || []).join(';'), JSON.stringify(harness.sessionStore.get(sid)));
  });
});
