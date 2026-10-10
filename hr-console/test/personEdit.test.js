const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid, pidHash } = require('../../api/src/security/pid');
const { COOKIE_NAME } = require('../src/session/sessionCookie');

// PR-D3: หน้าเพิ่ม/แก้ข้อมูลการจ้าง/พ้นสภาพ/คืนสภาพ ของ HR Console - รันกับ MDM API จริง (in-process) + Postgres จริง + mock Keycloak
// ข้อมูลทั้งหมดสมมติ เลขบัตรมาจาก makeFakePid() เท่านั้น ตรวจทั้งสำเร็จ/409/422/ไม่มี role และไม่มีเลขบัตรรั่วใน response/redirect/log/session

let harness;
let adminPool;
let pepper;
let orgA;
let orgB;
let posA1;
let posA2;
let posB1;

const tag = crypto.randomUUID().slice(0, 8);
const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const versionFrom = (html) => /name="expectedVersion" value="(\d+)"/.exec(html)?.[1];
const uniq = () => crypto.randomUUID().slice(0, 6);
const dashed = (pid) => `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;

async function makeOrg(label) {
  const code = `ED-${label}-${tag}`;
  const { rows } = await adminPool.query(`INSERT INTO mdm.org_unit (code, name_th, unit_level) VALUES ($1, $2, 'DIVISION') RETURNING org_unit_id`, [code, `หน่วยงานแก้ไข ${label} ${tag}`]);
  return { id: rows[0].org_unit_id, code, name: `หน่วยงานแก้ไข ${label} ${tag}` };
}
async function makePos(org, label) {
  const no = `ED-POS-${label}-${tag}`;
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, $2, 'GENERAL', $3) RETURNING position_id`,
    [no, `ตำแหน่งแก้ไข ${label}`, org.id]
  );
  return { id: rows[0].position_id, no };
}

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  pepper = await harness.apiCtx.vault.getPepper();
  orgA = await makeOrg('A');
  orgB = await makeOrg('B');
  posA1 = await makePos(orgA, 'A1');
  posA2 = await makePos(orgA, 'A2');
  posB1 = await makePos(orgB, 'B1');
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

const adminAgent = (code = 'persons-admin-code') => loginAsHrOfficer(harness.hrConsoleApp, code);

function employmentFields(overrides = {}) {
  return {
    personnelType: 'CIVIL_SERVANT',
    orgUnitId: orgA.id,
    positionId: posA1.id,
    effectiveFrom: '2024-01-01',
    ...overrides,
  };
}

// เปิดฟอร์มเพิ่มบุคคลแล้วส่งจริงผ่าน UI คืน { res, pid, personId }
async function createViaUi(agent, { pid = makeFakePid(), fields = {}, omit = [] } = {}) {
  const form = await agent.get('/hr/persons/new');
  // ตำแหน่งหนึ่งมีผู้ครองได้คนเดียว (EXCLUDE constraint) -> สร้างตำแหน่งใหม่ให้ทุกคนที่สร้าง เว้นแต่เทสต์ระบุ positionId เอง
  const needsPosition = !('positionId' in fields) && (fields.personnelType ?? 'CIVIL_SERVANT') === 'CIVIL_SERVANT';
  const positionId = needsPosition ? (await makePos(orgA, `N${uniq()}`)).id : fields.positionId;
  const body = {
    _csrf: csrfFrom(form.text),
    pid,
    firstNameTh: `สมชาย${tag}`,
    lastNameTh: `ทดสอบ${tag}`,
    reason: 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ',
    ...employmentFields(),
    ...fields,
    ...(positionId !== undefined ? { positionId } : {}),
  };
  for (const key of omit) delete body[key];
  const res = await agent.post('/hr/persons/new').type('form').send(body);
  const personId = /\/hr\/persons\/([0-9a-f-]{36})/.exec(res.headers.location || '')?.[1];
  return { res, pid, personId, positionId };
}

const personRow = async (personId) =>
  (await adminPool.query(`SELECT status, version, expected_first_name_th AS first, expected_last_name_th AS last, expected_birth_date::text AS birth FROM mdm.person WHERE person_id = $1`, [personId])).rows[0];
const employmentRows = async (personId) =>
  (await adminPool.query(`SELECT employee_no, personnel_type, org_unit_id, position_id, job_title_text, level_code, is_current, effective_from::text AS effective_from, effective_to::text AS effective_to, employment_status, separation_reason FROM mdm.employment WHERE person_id = $1 ORDER BY is_current ASC, effective_from ASC`, [personId])).rows;
const logsFor = async (personId) => (await adminPool.query(`SELECT field_name, changed_by, actor_sub, actor_client, reason FROM audit.data_change_log WHERE person_id = $1 ORDER BY log_id`, [personId])).rows;
const personCount = async () => Number((await adminPool.query(`SELECT count(*)::int AS n FROM mdm.person`)).rows[0].n);

// จับทุกอย่างที่ console เขียนลง log ระหว่างเทสต์ (console.*) เพื่อยืนยันว่าไม่มีเลขบัตร
const logged = [];
let spies = [];
beforeEach(() => {
  logged.length = 0;
  spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation((...args) => logged.push(JSON.stringify(args))));
});
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

function expectNoPid(pid, ...texts) {
  for (const text of [...texts, ...logged]) {
    expect(String(text)).not.toContain(pid);
    expect(String(text)).not.toContain(dashed(pid));
  }
}

describe('สิทธิ์: ต้องมี hr_master_data_admin', () => {
  test('hr_officer ธรรมดา: เข้าหน้าเพิ่ม/แก้/พ้นสภาพ/คืนสภาพไม่ได้ (403 ภาษาไทย), POST ไม่เขียนอะไร, ไม่เห็นปุ่มและประวัติในหน้ารายละเอียด', async () => {
    const admin = await adminAgent();
    const { personId } = await createViaUi(admin);
    const before = await personCount();

    const officer = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-a-code');
    for (const path of ['/hr/persons/new', `/hr/persons/${personId}/employment/edit`, `/hr/persons/${personId}/deactivate`, `/hr/persons/${personId}/reactivate`]) {
      // eslint-disable-next-line no-await-in-loop
      const get = await officer.get(path);
      expect(get.status).toBe(403);
      expect(get.text).toContain('ไม่มีสิทธิ์');
      // eslint-disable-next-line no-await-in-loop
      const post = await officer.post(path).type('form').send({ _csrf: 'x', reason: 'ลองทำโดยไม่มีสิทธิ์' });
      expect(post.status).toBe(403);
    }
    expect(await personCount()).toBe(before);
    expect((await personRow(personId)).status).toBe('PENDING_CLAIM');

    const detail = await officer.get(`/hr/persons/${personId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('พ้นสภาพ</a>');
    expect(detail.text).not.toContain('/employment/edit');
    expect(detail.text).not.toContain('ประวัติการเปลี่ยนแปลง');
    expect((await officer.get('/hr/persons')).text).not.toContain('เพิ่มบุคคลใหม่');
  });

  test('ผู้ดูแล HR เห็นปุ่มเพิ่ม/ย้าย/พ้นสภาพ และส่วนประวัติ', async () => {
    const admin = await adminAgent();
    const { personId } = await createViaUi(admin);
    expect((await admin.get('/hr/persons')).text).toContain('+ เพิ่มบุคคลใหม่');
    const detail = await admin.get(`/hr/persons/${personId}`);
    expect(detail.text).toContain(`/hr/persons/${personId}/employment/edit`);
    expect(detail.text).toContain(`/hr/persons/${personId}/deactivate`);
    expect(detail.text).toContain('ประวัติการเปลี่ยนแปลง');
    expect(detail.text).not.toContain('/reactivate"'); // ยังไม่พ้นสภาพ ไม่มีปุ่มคืนสภาพ
  });

  test('console ปล่อยผ่าน (session ถูกยกเป็น admin) แต่ token ไม่มี role -> MDM API ตอบ 403 และ console แสดงข้อความไทย ไม่ใช่ 500; ไม่มีอะไรถูกเขียน', async () => {
    const admin = await adminAgent();
    const { personId } = await createViaUi(admin);
    const officer = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-officer-manage-scope-code');
    const sid = officer.jar.getCookies(require('cookiejar').CookieAccessInfo.All).find((c) => c.name === COOKIE_NAME).value;
    harness.sessionStore.update(sid, { isMasterDataAdmin: true }); // จำลอง gate ของ console พลาด -> API ต้องกันซ้ำ

    const detail = await officer.get(`/hr/persons/${personId}/deactivate`);
    expect(detail.status).toBe(200);
    const post = await officer
      .post(`/hr/persons/${personId}/deactivate`)
      .type('form')
      .send({ _csrf: csrfFrom(detail.text), expectedVersion: versionFrom(detail.text), employmentStatus: 'RESIGNED', separationDate: '2025-01-01', reason: 'ลองพ้นสภาพโดยไม่มีสิทธิ์' });
    expect(post.status).toBe(403);
    expect(post.text).toContain('ไม่มีสิทธิ์ทำรายการนี้');
    expect(post.text).toContain('hr_master_data_admin');
    expect((await personRow(personId)).status).toBe('PENDING_CLAIM');
  });
});

describe('เพิ่มบุคคลใหม่', () => {
  test('GET: ฟอร์มมี CSRF, dropdown ประเภท/หน่วยงาน/ตำแหน่ง, ช่องเลขบัตรว่างและไม่มีค่า, ไม่ cache', async () => {
    const admin = await adminAgent();
    const res = await admin.get('/hr/persons/new');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(csrfFrom(res.text)).toBeTruthy();
    expect(res.text).toContain(`value="${orgA.id}"`);
    expect(res.text).toContain(`${orgA.code} — ${orgA.name}`);
    expect(res.text).toContain(posA1.no);
    expect(res.text).toContain('value="CONTRACT_EMPLOYEE"');
    expect(res.text).toMatch(/<input name="pid"[^>]*required \/>/);
    expect(res.text).not.toMatch(/<input name="pid"[^>]*value=/);
  });

  test('สำเร็จ: 303 ไป /hr/persons/{id}?saved=created, PENDING_CLAIM, เก็บชื่อที่ HR กรอก (ไม่เก็บวันเกิด), employment ตรง, log มีผู้กระทำ+เหตุผล, ข้อความยืนยันชัดเจน, ไม่มีเลขบัตรรั่ว', async () => {
    const admin = await adminAgent();
    const { res, pid, personId, positionId } = await createViaUi(admin);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=created`);
    expectNoPid(pid, res.headers.location, res.text);

    const person = await personRow(personId);
    expect(person).toMatchObject({ status: 'PENDING_CLAIM', first: `สมชาย${tag}`, last: `ทดสอบ${tag}`, birth: null });
    const { rows } = await adminPool.query(`SELECT pid_hash, pid_enc IS NOT NULL AS has_enc FROM mdm.person WHERE person_id = $1`, [personId]);
    expect(rows[0]).toMatchObject({ pid_hash: pidHash(pid, pepper), has_enc: true });
    const emp = await employmentRows(personId);
    expect(emp).toHaveLength(1);
    expect(emp[0]).toMatchObject({ personnel_type: 'CIVIL_SERVANT', org_unit_id: orgA.id, position_id: positionId, is_current: true, employee_no: pid });
    const logs = await logsFor(personId);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.changed_by === 'HR' && l.actor_sub === 'hr.admin' && l.actor_client === 'hr-console-test' && l.reason === 'เพิ่มบุคลากรใหม่ตามคำสั่งบรรจุ')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(pid);

    const detail = await admin.get(res.headers.location);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('เพิ่มบุคคลใหม่เรียบร้อยแล้ว');
    expect(detail.text).toContain(`สมชาย${tag}`);
    expect(detail.text).toContain('ประวัติการเปลี่ยนแปลง');
    expect(detail.text).toContain('ชื่อที่ HR กรอก (รอยืนยัน ThaID)');
    expect(detail.text).toContain('(ปกปิด)'); // เลขประจำตัวถูกปกปิดในประวัติ
    expectNoPid(pid, detail.text);
    // ข้อความ flash มาจากรหัสที่รู้จักเท่านั้น
    // (layout มี <script> ของตัวเองอยู่แล้ว: เทียบจำนวนกับหน้าที่ไม่มี ?saved เพื่อยืนยันว่าค่าจาก query ไม่ถูกสะท้อนลงหน้า)
    const injected = (await admin.get(`/hr/persons/${personId}?saved=<script>`)).text;
    expect(injected.split('<script>').length).toBe(detail.text.split('<script>').length);
  });

  test('เลขบัตรพิมพ์คั่นด้วยขีด/ช่องว่างได้; ประเภทไม่มีตำแหน่ง + ชื่อตำแหน่ง/ลักษณะงานสำเร็จ', async () => {
    const admin = await adminAgent();
    const pid = makeFakePid();
    const { res, personId } = await createViaUi(admin, {
      pid: dashed(pid),
      fields: { personnelType: 'GENERAL_EMPLOYEE', positionId: '', jobTitleText: 'ผู้ช่วยช่างไฟฟ้า' },
    });
    expect(res.status).toBe(303);
    expectNoPid(pid, res.headers.location);
    expect((await personRow(personId)).birth).toBeNull();
    expect((await employmentRows(personId))[0]).toMatchObject({ employee_no: pid, position_id: null, job_title_text: 'ผู้ช่วยช่างไฟฟ้า' });
  });

  test('เลิกเก็บวันเกิดที่ HR กรอก: ฟอร์มไม่มีช่องวันเกิด และค่า birthDate ที่ถูกส่งมาเองไม่ถูกเก็บ/ไม่ถูกส่งไป API', async () => {
    const admin = await adminAgent();
    const form = await admin.get('/hr/persons/new');
    expect(form.text).not.toContain('name="birthDate"');
    expect(form.text).not.toContain('วันเกิด');
    const { res, personId } = await createViaUi(admin, { fields: { birthDate: '1990-05-17' } });
    expect(res.status).toBe(303);
    expect((await personRow(personId)).birth).toBeNull();
    expect((await logsFor(personId)).map((l) => l.field_name)).not.toContain('person.expected_birth_date');
  });

  test.each([
    ['เลขบัตรไม่ผ่าน checksum', () => ({ pid: '1234567890123' }), 'ไม่ถูกต้อง'],
    ['เลขบัตรไม่ครบ 13 หลัก', () => ({ pid: makeFakePid().slice(0, 12) }), '13 หลัก'],
    ['เลขบัตรมีตัวอักษร', () => ({ pid: `${makeFakePid().slice(0, 12)}x` }), '13 หลัก'],
    ['ไม่กรอกชื่อ', () => ({ fields: { firstNameTh: '   ' } }), 'กรุณากรอกชื่อ'],
    ['นามสกุลมีเลขบัตร', () => ({ fields: { lastNameTh: `ทดสอบ ${makeFakePid()}` } }), 'นามสกุลห้ามมีเลขบัตร'],
    ['ชื่อยาวเกิน 200', () => ({ fields: { firstNameTh: 'ก'.repeat(201) } }), 'ยาวเกิน 200'],
    ['เหตุผลสั้นเกินไป', () => ({ fields: { reason: 'สั้น' } }), 'อย่างน้อย 5'],
    ['เหตุผลมีเลขบัตร', () => ({ fields: { reason: `ตามเลข ${makeFakePid()}` } }), 'ห้ามใส่เลขบัตร'],
    ['เหตุผลมีเลขบัตรแบบมีขีด', () => ({ fields: { reason: `ตามเลข ${dashed(makeFakePid())}` } }), 'ห้ามใส่เลขบัตร'],
    ['ประเภทต้องมีตำแหน่งแต่ไม่เลือก', () => ({ fields: { positionId: '' } }), 'ต้องระบุเลขที่ตำแหน่ง'],
    ['ประเภทไม่มีตำแหน่งแต่เลือกตำแหน่ง', () => ({ fields: { personnelType: 'GENERAL_EMPLOYEE' } }), 'ไม่มีเลขที่ตำแหน่ง'],
    ['ตำแหน่งไม่อยู่ในหน่วยงานที่เลือก', () => ({ fields: { positionId: posB1.id } }), 'ไม่อยู่ในหน่วยงานที่เลือก'],
    ['ไม่เลือกหน่วยงาน', () => ({ fields: { orgUnitId: '', positionId: '' } }), 'กรุณาเลือกหน่วยงาน'],
    ['วันที่มีผลไม่ถูกต้อง', () => ({ fields: { effectiveFrom: '2024-02-30' } }), 'วันที่มีผล'],
  ])('422 %s: ไม่สร้างบุคคล, ไม่เติมเลขบัตรกลับฟอร์ม, ไม่สะท้อนเลขในหน้า/log', async (_name, build, expectedText) => {
    const admin = await adminAgent();
    const before = await personCount();
    const given = build();
    const pid = given.pid ?? makeFakePid();
    const { res } = await createViaUi(admin, { pid, fields: given.fields });
    expect(res.status).toBe(422);
    expect(res.text).toContain(expectedText);
    expect(res.text).toContain('ไม่เติมเลขบัตรประชาชนกลับลงฟอร์ม');
    expect(res.text).not.toMatch(/<input name="pid"[^>]*value=/);
    expect(res.headers.location).toBeUndefined();
    expectNoPid(pid, res.text);
    expect(await personCount()).toBe(before);
    if (!given.fields) expect(res.text).toContain(`value="สมชาย${tag}"`); // ค่าอื่นที่กรอกยังอยู่
  });

  test('409 เลขบัตรซ้ำ: ข้อความไทย + ลิงก์ไปบุคคลที่มีอยู่ (ด้วย personId ไม่ใช่เลขบัตร) และไม่สะท้อนเลขบัตร', async () => {
    const admin = await adminAgent();
    const first = await createViaUi(admin);
    const before = await personCount();
    const dup = await createViaUi(admin, { pid: first.pid, fields: { firstNameTh: `ซ้ำ${tag}` } });
    expect(dup.res.status).toBe(409);
    expect(dup.res.text).toContain('มีบุคคลที่ใช้เลขบัตรประชาชนนี้อยู่ในระบบแล้ว');
    expect(dup.res.text).toContain(`/hr/persons/${first.personId}`);
    expect(dup.res.text).not.toMatch(/<input name="pid"[^>]*value=/);
    expectNoPid(first.pid, dup.res.text);
    expect(await personCount()).toBe(before);
  });

  test('CSRF ผิด/ไม่มี -> 403 ไม่สร้าง', async () => {
    const admin = await adminAgent();
    const before = await personCount();
    const pid = makeFakePid();
    const res = await admin.post('/hr/persons/new').type('form').send({ pid, firstNameTh: 'ก', lastNameTh: 'ข', reason: 'ทดสอบ csrf', ...employmentFields() });
    expect(res.status).toBe(403);
    expect(res.text).toContain('CSRF');
    expectNoPid(pid, res.text);
    expect(await personCount()).toBe(before);
  });

  test('เลขบัตรไม่อยู่ใน URL/redirect/session/log ตลอดทั้งขั้นตอน (สำเร็จและล้มเหลว)', async () => {
    const admin = await adminAgent();
    const ok = await createViaUi(admin);
    const bad = await createViaUi(admin, { pid: makeFakePid(), fields: { reason: 'สั้น' } });
    const dup = await createViaUi(admin, { pid: ok.pid });
    for (const r of [ok.res, bad.res, dup.res]) {
      expect(r.req.path).not.toMatch(/\d{13}/);
      expect(String(r.headers.location || '')).not.toMatch(/\d{13}/);
    }
    // session ฝั่ง server ของทุกคนที่ล็อกอินอยู่ ต้องไม่มีเลขบัตร
    expect(JSON.stringify(harness.sessionStore.allDataForTest())).not.toContain(ok.pid);
    expect(JSON.stringify(harness.sessionStore.allDataForTest())).not.toContain(bad.pid);
    expectNoPid(ok.pid, ok.res.text, dup.res.text);
    expectNoPid(bad.pid, bad.res.text);
  });
});

describe('ย้ายหน่วยงาน / ตำแหน่ง / ประเภทบุคลากร', () => {
  async function prepared() {
    const admin = await adminAgent();
    const created = await createViaUi(admin, { fields: { levelCode: 'ชำนาญการ', emailWork: 'work@example.com', appointedDate: '2020-03-01' } });
    return { admin, ...created };
  }
  const editPath = (personId) => `/hr/persons/${personId}/employment/edit`;

  test('GET: เติมค่าเดิมทั้งหมด (ประเภท/หน่วยงาน/ตำแหน่ง/ระดับ/อีเมล/วันบรรจุ) + expectedVersion + CSRF และไม่มีช่องเลขบัตร', async () => {
    const { admin, personId, pid, positionId } = await prepared();
    const res = await admin.get(editPath(personId));
    expect(res.status).toBe(200);
    expect(res.text).toContain('value="CIVIL_SERVANT" selected');
    expect(res.text).toContain(`value="${orgA.id}" selected`);
    expect(res.text).toContain(`value="${positionId}" selected`);
    expect(res.text).toContain('value="ชำนาญการ"');
    expect(res.text).toContain('value="work@example.com"');
    expect(res.text).toContain('value="2020-03-01"');
    expect(versionFrom(res.text)).toBe('1');
    expect(csrfFrom(res.text)).toBeTruthy();
    expect(res.text).not.toContain('name="employeeNo"');
    expect(res.text).not.toContain('name="pid"');
    expectNoPid(pid, res.text);
  });

  test('POST ย้ายหน่วยงาน+ตำแหน่ง: 303 ?saved=employment, ปิดของเดิม/เปิดของใหม่ (เก็บประวัติเป็นช่วงเวลา), เลขบัตรเดิมคงอยู่โดยไม่ต้องกรอก, ระดับ/อีเมล/วันบรรจุไม่หาย, version+1, log มีเหตุผลและผู้กระทำ, ประวัติแสดงชื่อหน่วยงาน', async () => {
    const { admin, personId, pid, positionId } = await prepared();
    const form = await admin.get(editPath(personId));
    const newPosB = await makePos(orgB, `M${uniq()}`);
    const res = await admin.post(editPath(personId)).type('form').send({
      _csrf: csrfFrom(form.text),
      expectedVersion: versionFrom(form.text),
      ...employmentFields({ positionId, orgUnitId: orgB.id, positionId: newPosB.id, effectiveFrom: '2024-07-01', levelCode: 'ชำนาญการ', emailWork: 'work@example.com', appointedDate: '2020-03-01' }),
      reason: 'ย้ายตามคำสั่งที่ 5/2567',
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=employment`);

    const emp = await employmentRows(personId);
    expect(emp).toHaveLength(2);
    expect(emp[0]).toMatchObject({ is_current: false, effective_to: '2024-07-01', org_unit_id: orgA.id, position_id: positionId });
    expect(emp[1]).toMatchObject({ is_current: true, effective_from: '2024-07-01', org_unit_id: orgB.id, position_id: newPosB.id, employee_no: pid, level_code: 'ชำนาญการ' });
    expect((await personRow(personId)).version).toBe(2);
    const moveLogs = (await logsFor(personId)).filter((l) => l.reason === 'ย้ายตามคำสั่งที่ 5/2567');
    expect(moveLogs.map((l) => l.field_name).sort()).toEqual(['employment.org_unit_id', 'employment.position_id']);
    expect(moveLogs.every((l) => l.actor_sub === 'hr.admin' && l.changed_by === 'HR')).toBe(true);

    const detail = await admin.get(res.headers.location);
    expect(detail.text).toContain('บันทึกการเปลี่ยนแปลงข้อมูลการจ้างเรียบร้อยแล้ว');
    expect(detail.text).toContain(orgB.name);
    expect(detail.text).toContain(`${orgA.code} — ${orgA.name}`); // ประวัติแปลง id หน่วยงานเดิมเป็นชื่อ
    expect(detail.text).toContain('ย้ายตามคำสั่งที่ 5/2567');
    expectNoPid(pid, detail.text, res.text);
  });

  test('POST เปลี่ยนประเภทเป็นพนักงานจ้าง (ไม่มีตำแหน่ง + ชื่อตำแหน่ง/ลักษณะงาน) สำเร็จ', async () => {
    const { admin, personId, positionId } = await prepared();
    const form = await admin.get(editPath(personId));
    const res = await admin.post(editPath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text),
      ...employmentFields({ positionId, personnelType: 'CONTRACT_EMPLOYEE', positionId: '', jobTitleText: 'พนักงานขับรถยนต์', effectiveFrom: '2024-08-01' }),
      reason: 'เปลี่ยนประเภทการจ้าง',
    });
    expect(res.status).toBe(303);
    expect((await employmentRows(personId)).at(-1)).toMatchObject({ personnel_type: 'CONTRACT_EMPLOYEE', position_id: null, job_title_text: 'พนักงานขับรถยนต์' });
  });

  test('ไม่มีอะไรเปลี่ยน: ?saved=nochange บอกชัดว่าไม่ได้บันทึก, version ไม่เพิ่ม', async () => {
    const { admin, personId, positionId } = await prepared();
    const form = await admin.get(editPath(personId));
    const res = await admin.post(editPath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text),
      ...employmentFields({ positionId, levelCode: 'ชำนาญการ', emailWork: 'work@example.com', appointedDate: '2020-03-01' }),
      reason: 'ตรวจสอบโดยไม่แก้ไข',
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=nochange`);
    expect((await admin.get(res.headers.location)).text).toContain('ไม่มีการเปลี่ยนแปลงข้อมูล จึงไม่ได้บันทึกอะไร');
    expect((await personRow(personId)).version).toBe(1);
    expect(await employmentRows(personId)).toHaveLength(1);
  });

  test('409 version-conflict: มีคนอื่นแก้ระหว่างที่เปิดฟอร์ม -> บอกผู้ใช้ มีปุ่ม "โหลดข้อมูลล่าสุด" ไปฟอร์มเดิม ไม่เขียนทับ; โหลดใหม่แล้วบันทึกได้', async () => {
    const { admin, personId, positionId } = await prepared();
    const stale = await admin.get(editPath(personId));
    const altA = await makePos(orgA, `ALT${uniq()}`);
    // ผู้ดูแลอีกคนแก้ก่อน
    const other = await adminAgent('persons-admin-two-code');
    const otherForm = await other.get(editPath(personId));
    expect(
      (await other.post(editPath(personId)).type('form').send({
        _csrf: csrfFrom(otherForm.text), expectedVersion: versionFrom(otherForm.text),
        ...employmentFields({ positionId: altA.id, effectiveFrom: '2024-05-01', levelCode: 'ชำนาญการ', emailWork: 'work@example.com', appointedDate: '2020-03-01' }),
        reason: 'อีกคนแก้ตำแหน่งก่อน',
      })).status
    ).toBe(303);

    const res = await admin.post(editPath(personId)).type('form').send({
      _csrf: csrfFrom(stale.text), expectedVersion: versionFrom(stale.text),
      ...employmentFields({ positionId, orgUnitId: orgB.id, positionId: (await makePos(orgB, `Z${uniq()}`)).id, effectiveFrom: '2024-07-01' }),
      reason: 'ย้ายโดยข้อมูลที่ล้าสมัย',
    });
    expect(res.status).toBe(409);
    expect(res.text).toContain('ถูกแก้ไขโดยผู้อื่น');
    expect(res.text).toContain('ไม่ได้บันทึกอะไร');
    expect(res.text).toContain('โหลดข้อมูลล่าสุด');
    expect(res.text).toContain(`href="${editPath(personId)}"`);
    expect((await employmentRows(personId)).at(-1)).toMatchObject({ position_id: altA.id, org_unit_id: orgA.id }); // ของอีกคนยังอยู่

    const reloaded = await admin.get(editPath(personId));
    expect(versionFrom(reloaded.text)).toBe('2');
    expect(reloaded.text).toContain(`value="${altA.id}" selected`);
  });

  test.each([
    ['เหตุผลสั้น', { reason: 'สั้น' }, 'อย่างน้อย 5'],
    ['เหตุผลมีเลขบัตร', { reason: `ตาม ${makeFakePid()}` }, 'ห้ามใส่เลขบัตร'],
    ['ประเภทต้องมีตำแหน่งแต่ไม่เลือก', { positionId: '' }, 'ต้องระบุเลขที่ตำแหน่ง'],
    ['ตำแหน่งไม่อยู่ในหน่วยงาน', () => ({ orgUnitId: orgB.id }), 'ไม่อยู่ในหน่วยงานที่เลือก'],
    ['วันที่มีผลก่อนวันที่มีผลปัจจุบัน', { effectiveFrom: '2023-12-31' }, 'ต้องไม่ก่อน 1 ม.ค. 2567'],
    ['ระดับยาวเกิน 50', { levelCode: 'ก'.repeat(51) }, 'ยาวเกิน 50'],
  ])('422 %s: ฟอร์มเดิมพร้อมข้อความไทย คงค่าที่กรอก ไม่เขียนอะไร', async (_n, override, text) => {
    const { admin, personId, positionId } = await prepared();
    const form = await admin.get(editPath(personId));
    const res = await admin.post(editPath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), ...employmentFields({ positionId, effectiveFrom: '2024-07-01' }), reason: 'ย้ายตามคำสั่ง', ...(typeof override === 'function' ? override() : override),
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain(text);
    expect(res.text).toContain('<form method="post"');
    expect(versionFrom(res.text)).toBe('1');
    expect(await employmentRows(personId)).toHaveLength(1);
  });

  test('ตำแหน่งมีผู้ครองอยู่แล้ว: API 409 position-occupied -> ข้อความไทย คงฟอร์ม (409) ไม่เขียน', async () => {
    const admin = await adminAgent();
    const occupied = await makePos(orgA, `OCC${crypto.randomUUID().slice(0, 4)}`);
    await createViaUi(admin, { fields: { positionId: occupied.id } });
    const { personId, positionId } = await createViaUi(admin);
    const form = await admin.get(editPath(personId));
    const res = await admin.post(editPath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), ...employmentFields({ positionId, positionId: occupied.id, effectiveFrom: '2024-07-01' }), reason: 'ย้ายไปตำแหน่งที่มีคนครอง',
    });
    expect(res.status).toBe(409);
    expect(res.text).toContain('ตำแหน่งนี้มีผู้ครองอยู่แล้ว');
    expect(res.text).toContain('<form method="post"');
    expect(await employmentRows(personId)).toHaveLength(1);
  });

  test('บุคคลที่พ้นสภาพแล้วย้ายไม่ได้ (409 ไทย แนะนำให้ใช้คืนสภาพ); CSRF ผิด 403; UUID ไม่ถูกต้อง 404', async () => {
    const { admin, personId, positionId } = await prepared();
    await adminPool.query(`UPDATE mdm.person SET status = 'INACTIVE' WHERE person_id = $1`, [personId]);
    const res = await admin.get(editPath(personId));
    expect(res.status).toBe(409);
    expect(res.text).toContain('คืนสภาพ');
    const csrf = await admin.post(editPath(personId)).type('form').send({ expectedVersion: '1', reason: 'ไม่มี csrf' });
    expect(csrf.status).toBe(403);
    expect((await admin.get('/hr/persons/not-a-uuid/employment/edit')).status).toBe(404);
  });

  test('MDM API ล่ม/ตอบไม่ใช่ JSON: หน้าไทย 502 ไม่ใช่หน้า 500 และไม่เขียนอะไร', async () => {
    const { admin, personId, positionId } = await prepared();
    const form = await admin.get(editPath(personId));
    const altA = await makePos(orgA, `API${uniq()}`);
    const body = { _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), ...employmentFields({ positionId: altA.id, effectiveFrom: '2024-07-01' }), reason: 'ย้ายตอน API ล่ม' };

    const realFetch = global.fetch;
    try {
      global.fetch = jest.fn(async (url, init) => {
        if (init?.method === 'PUT') throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
        return realFetch(url, init);
      });
      const down = await admin.post(editPath(personId)).type('form').send(body);
      expect(down.status).toBe(502);
      expect(down.text).toContain('เชื่อมต่อระบบ MDM ไม่ได้');

      global.fetch = jest.fn(async (url, init) => {
        if (init?.method === 'PUT') return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
        return realFetch(url, init);
      });
      const html = await admin.post(editPath(personId)).type('form').send(body);
      expect(html.status).toBe(502);
      expect(html.text).toContain('ระบบ MDM ขัดข้อง');
    } finally {
      global.fetch = realFetch;
    }
    expect(await employmentRows(personId)).toHaveLength(1);
  });
});

describe('พ้นสภาพ และ คืนสภาพ', () => {
  const deactivatePath = (id) => `/hr/persons/${id}/deactivate`;
  const reactivatePath = (id) => `/hr/persons/${id}/reactivate`;

  async function prepared(fields) {
    const admin = await adminAgent();
    return { admin, ...(await createViaUi(admin, { fields })) };
  }

  test('พ้นสภาพ: GET มีคำเตือน+CSRF+version; POST สำเร็จ 303 ?saved=deactivated, INACTIVE, ปิด employment พร้อมเหตุผล, event PERSON_DEACTIVATED, log มีผู้กระทำ; หน้ารายละเอียดมีข้อความยืนยันและปุ่มคืนสภาพ', async () => {
    const { admin, personId, pid } = await prepared();
    const form = await admin.get(deactivatePath(personId));
    expect(form.status).toBe(200);
    expect(form.text).toContain('คำเตือน');
    expect(versionFrom(form.text)).toBe('1');

    const res = await admin.post(deactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), employmentStatus: 'RESIGNED', separationDate: '2025-01-15', referenceDocument: 'คำสั่งที่ 9/2568', reason: 'ลาออกเพื่อไปประกอบอาชีพอื่น',
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=deactivated`);
    expect((await personRow(personId)).status).toBe('INACTIVE');
    expect((await employmentRows(personId))[0]).toMatchObject({ is_current: false, employment_status: 'RESIGNED', separation_reason: 'ลาออกเพื่อไปประกอบอาชีพอื่น' });
    const events = (await adminPool.query(`SELECT event_type FROM integration.outbox_event WHERE person_id = $1`, [personId])).rows;
    expect(events.map((e) => e.event_type)).toContain('PERSON_DEACTIVATED');
    const statusLog = (await logsFor(personId)).find((l) => l.field_name === 'status' && l.reason.startsWith('ลาออก'));
    expect(statusLog).toMatchObject({ actor_sub: 'hr.admin', changed_by: 'HR', reason: 'ลาออกเพื่อไปประกอบอาชีพอื่น (อ้างอิง: คำสั่งที่ 9/2568)' });

    const detail = await admin.get(res.headers.location);
    expect(detail.text).toContain('บันทึกการพ้นสภาพเรียบร้อยแล้ว');
    expect(detail.text).toContain(`/hr/persons/${personId}/reactivate`);
    expect(detail.text).not.toContain('/employment/edit');
    expect(detail.text).toContain('สถานะบุคคล');
    expectNoPid(pid, detail.text, res.text);
  });

  test.each([
    ['เหตุผลสั้น', { reason: 'สั้น' }, 'อย่างน้อย 5'],
    ['เหตุผลมีเลขบัตร', { reason: `ลาออก ${makeFakePid()}` }, 'ห้ามใส่เลขบัตร'],
    ['ไม่เลือกสาเหตุ', { employmentStatus: '' }, 'กรุณาเลือกสาเหตุ'],
    ['วันที่ไม่ถูกต้อง', { separationDate: '2025-13-40' }, 'วันที่พ้นสภาพ'],
    ['เลขที่คำสั่งมีเลขบัตร', { referenceDocument: `คำสั่ง ${makeFakePid()}` }, 'เลขที่คำสั่งห้ามมีเลขบัตร'],
  ])('422 %s: แสดงฟอร์มพร้อมข้อความไทย ไม่พ้นสภาพ', async (_n, override, text) => {
    const { admin, personId } = await prepared();
    const form = await admin.get(deactivatePath(personId));
    const res = await admin.post(deactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), employmentStatus: 'RESIGNED', separationDate: '2025-01-15', reason: 'ลาออกตามความประสงค์', ...override,
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain(text);
    expect((await personRow(personId)).status).toBe('PENDING_CLAIM');
  });

  test('409 version-conflict ตอนพ้นสภาพ: ข้อความ + ปุ่มโหลดล่าสุด ไม่พ้นสภาพ', async () => {
    const { admin, personId } = await prepared();
    const stale = await admin.get(deactivatePath(personId));
    await adminPool.query(`UPDATE mdm.person SET version = version + 1 WHERE person_id = $1`, [personId]); // มีการแก้จากที่อื่น
    const res = await admin.post(deactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(stale.text), expectedVersion: versionFrom(stale.text), employmentStatus: 'RESIGNED', separationDate: '2025-01-15', reason: 'ลาออกตามความประสงค์',
    });
    expect(res.status).toBe(409);
    expect(res.text).toContain('ถูกแก้ไขโดยผู้อื่น');
    expect(res.text).toContain('โหลดข้อมูลล่าสุด');
    expect(res.text).toContain(`href="${deactivatePath(personId)}"`);
    expect((await personRow(personId)).status).toBe('PENDING_CLAIM');
  });

  test('พ้นสภาพซ้ำ: GET ของคนที่พ้นสภาพแล้ว 409 ไทย; CSRF ผิด 403', async () => {
    const { admin, personId } = await prepared();
    await adminPool.query(`UPDATE mdm.person SET status = 'INACTIVE' WHERE person_id = $1`, [personId]);
    const res = await admin.get(deactivatePath(personId));
    expect(res.status).toBe(409);
    expect(res.text).toContain('พ้นสภาพไปแล้ว');
    expect((await admin.post(deactivatePath(personId)).type('form').send({ expectedVersion: '1', reason: 'ไม่มี csrf' })).status).toBe(403);
  });

  test('คืนสภาพ: ฟอร์มเติมค่าจากข้อมูลการจ้างล่าสุด; POST สำเร็จ 303 ?saved=reactivated, ACTIVE + ต้องยืนยัน ThaID ใหม่ (STALE), เลขบัตรเดิมคงอยู่โดยไม่ต้องกรอก, ข้อความยืนยันชัดเจน', async () => {
    const { admin, personId, pid, positionId } = await prepared({ levelCode: 'ชำนาญการ' });
    const dform = await admin.get(deactivatePath(personId));
    await admin.post(deactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(dform.text), expectedVersion: versionFrom(dform.text), employmentStatus: 'TRANSFERRED_OUT', separationDate: '2024-12-31', reason: 'โอนย้ายไปสังกัดอื่น',
    });

    const form = await admin.get(reactivatePath(personId));
    expect(form.status).toBe(200);
    expect(form.text).toContain('value="CIVIL_SERVANT" selected');
    expect(form.text).toContain(`value="${positionId}" selected`);
    expect(form.text).toContain('พ้นสภาพเมื่อ 31 ธ.ค. 2567');
    expect(form.text).not.toContain('name="employeeNo"');
    expect(versionFrom(form.text)).toBe('2');

    const res = await admin.post(reactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), ...employmentFields({ positionId, effectiveFrom: '2025-03-01', levelCode: 'ชำนาญการ' }), reason: 'โอนกลับมาปฏิบัติงานที่เดิม',
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/hr/persons/${personId}?saved=reactivated`);
    expect(await personRow(personId)).toMatchObject({ status: 'ACTIVE' });
    expect((await adminPool.query(`SELECT verification_status FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].verification_status).toBe('STALE');
    expect((await employmentRows(personId)).at(-1)).toMatchObject({ is_current: true, employee_no: pid, effective_from: '2025-03-01' });

    const detail = await admin.get(res.headers.location);
    expect(detail.text).toContain('คืนสภาพเรียบร้อยแล้ว');
    expect(detail.text).toContain('ยืนยันตัวตนผ่าน ThaID ใหม่');
    expectNoPid(pid, detail.text, res.text);
  });

  test('คืนสภาพ: คนที่ยังไม่พ้นสภาพ 409; version-conflict มีปุ่มโหลดล่าสุด; เหตุผลมีเลขบัตร 422', async () => {
    const { admin, personId, positionId } = await prepared();
    expect((await admin.get(reactivatePath(personId))).status).toBe(409);

    await adminPool.query(`UPDATE mdm.person SET status = 'INACTIVE' WHERE person_id = $1`, [personId]);
    const form = await admin.get(reactivatePath(personId));
    const bad = await admin.post(reactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), ...employmentFields({ positionId, effectiveFrom: '2025-03-01' }), reason: `เลข ${makeFakePid()}`,
    });
    expect(bad.status).toBe(422);
    await adminPool.query(`UPDATE mdm.person SET version = version + 1 WHERE person_id = $1`, [personId]);
    const stale = await admin.post(reactivatePath(personId)).type('form').send({
      _csrf: csrfFrom(form.text), expectedVersion: versionFrom(form.text), ...employmentFields({ positionId, effectiveFrom: '2025-03-01' }), reason: 'คืนสภาพด้วยข้อมูลเก่า',
    });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain('โหลดข้อมูลล่าสุด');
    expect((await personRow(personId)).status).toBe('INACTIVE');
  });
});

describe('ส่วนประวัติการเปลี่ยนแปลงในหน้ารายละเอียด', () => {
  test('แสดงหัวคอลัมน์/ป้ายภาษาไทย, ผู้กระทำ, เหตุผล, ค่าที่ปกปิด และแบ่งหน้า (20 รายการ/หน้า); ไม่มีเลขบัตร', async () => {
    const admin = await adminAgent();
    const { personId, pid } = await createViaUi(admin);
    // เติมประวัติเก่าอีก 25 แถวโดยตรง (รวมแถวเก่าที่ไม่มีผู้กระทำ และ reason ที่เลขบัตรหลุดมา)
    await adminPool.query(
      `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, reason)
       SELECT $1, 'person', 'status', to_jsonb('PENDING_CLAIM'::text), to_jsonb('ACTIVE'::text), 'HR', 'ประวัติทดสอบ ' || g FROM generate_series(1, 25) g`,
      [personId]
    );
    await adminPool.query(`INSERT INTO audit.data_change_log (person_id, table_name, field_name, changed_by, reason) VALUES ($1, 'person', 'status', 'HR', $2)`, [personId, `เก่า ${pid}`]);

    const page1 = await admin.get(`/hr/persons/${personId}`);
    expect(page1.text).toContain('<th>เมื่อ</th><th>ฟิลด์</th><th>ค่าเดิม</th><th>ค่าใหม่</th><th>โดย</th><th>เหตุผล</th>');
    expect(page1.text).toContain('สถานะบุคคล');
    expect(page1.text).toContain('รอยืนยันตัวตน'); // ค่า status แปลเป็นไทย
    expect(page1.text).toContain('เจ้าหน้าที่ HR');
    expect(page1.text).toContain('ไม่ทราบผู้กระทำ');
    expect(page1.text).toContain('ปกปิดเลข 13 หลัก'); // reason ของแถวเก่าที่เลขบัตรหลุดมา: API ปกปิดมาให้แล้ว
    expectNoPid(pid, page1.text);
    const more = /href="(\/hr\/persons\/[^"]+historyCursor=[^"]+)"/.exec(page1.text);
    expect(more).not.toBeNull();
    const page2 = await admin.get(more[1].replace(/&amp;/g, '&'));
    expect(page2.status).toBe(200);
    expect(page2.text).toContain('ประวัติทดสอบ 1<');
    expect(page2.text).toContain('ชื่อที่ HR กรอก (รอยืนยัน ThaID)'); // แถวตอนสร้างบุคคล (เก่าสุด) อยู่หน้าสอง
    expect(page2.text).toContain('<em>(ปกปิด)</em>'); // วันเกิด/เลขประจำตัวปกปิดค่า
    expectNoPid(pid, page2.text);
    // historyCursor ที่ไม่ใช่ตัวเลขถูกเมิน (ไม่ส่งต่อไป API)
    expect((await admin.get(`/hr/persons/${personId}?historyCursor=abc'--`)).status).toBe(200);
  });

  test('ประวัติล้มเหลว (API ขัดข้อง) ไม่ทำให้ทั้งหน้ารายละเอียดล้ม', async () => {
    const admin = await adminAgent();
    const { personId } = await createViaUi(admin);
    const realFetch = global.fetch;
    try {
      global.fetch = jest.fn(async (url, init) => {
        if (String(url).includes('/history')) return new Response(JSON.stringify({ title: 'x' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        return realFetch(url, init);
      });
      const res = await admin.get(`/hr/persons/${personId}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('แสดงประวัติการเปลี่ยนแปลงไม่ได้ในขณะนี้');
      expect(res.text).toContain(`สมชาย${tag}`);
    } finally {
      global.fetch = realFetch;
    }
  });
});
