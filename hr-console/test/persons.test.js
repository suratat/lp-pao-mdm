const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { insertFixtureOrgUnit } = require('../../api/test/fixtures');
const { makeFakePid, maskPid } = require('../../api/src/security/pid');
const { createMdmClient, stripEmployeeNo } = require('../src/mdmClient');
const { validateReason } = require('../src/routes/personRoutes');
const { newCsrfToken, csrfTokenMatches } = require('../src/session/csrf');

// หน้า HR Console "ข้อมูลบุคคล" (อ่านอย่างเดียว) - รันกับ MDM API จริง (in-process) + mock Keycloak
// ข้อมูลทั้งหมดสมมติ เลขบัตรมาจาก makeFakePid() เท่านั้น

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

const uniqueName = () => {
  const tag = crypto.randomBytes(4).toString('hex');
  return { first: `Hf${tag}`, last: `Hl${tag}` };
};

async function makePerson({ status = 'ACTIVE', first, last, pid = makeFakePid(), jobTitleText = null, personnelType = 'GENERAL_EMPLOYEE' } = {}) {
  const personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, $3, $4, 1)`,
    [personId, crypto.randomBytes(32).toString('hex'), status, status === 'PENDING_CLAIM' ? 'UNVERIFIED' : 'VERIFIED']
  );
  await adminPool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาย', $2, $3, '1990-01-01', 'M', now())`,
    [personId, first, last]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by, job_title_text)
     VALUES ($1, $2, $3, NULL, $4, CURRENT_DATE, true, 'ACTIVE', 'test', $5)`,
    [personId, pid, personnelType, orgUnitId, jobTitleText]
  );
  const { ciphertext, keyId } = await harness.apiCtx.vault.encrypt('mdm-pid', Buffer.from(pid, 'utf8'), personId);
  await adminPool.query('UPDATE mdm.person SET pid_enc = $2, key_id = $3 WHERE person_id = $1', [personId, Buffer.from(ciphertext, 'utf8'), keyId]);
  return { personId, pid };
}

const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

describe('mdmClient: ชั้นป้องกันเลขบัตรเต็ม', () => {
  const realFetch = global.fetch;
  let calls;
  let responder;

  beforeEach(() => {
    calls = [];
    responder = () => ({});
    global.fetch = jest.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify(responder(String(url))) };
    });
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const client = () => createMdmClient({ baseUrl: 'http://mdm.test' });

  test('searchPersons / getPerson / getEmployment ส่ง pidFormat=masked เสมอ (caller เลือกเองไม่ได้)', async () => {
    const c = client();
    await c.searchPersons('t', { q: 'สม', status: ['ACTIVE'], pidFormat: 'full' });
    await c.getPerson('t', 'p1');
    await c.getEmployment('t', 'p1');
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(new URL(call.url).searchParams.get('pidFormat')).toBe('masked');
  });

  test('q ที่มีช่องว่าง ("ชื่อ นามสกุล") เข้ารหัสเป็น %20 ไม่ใช่ + (validator ของ API ปฏิเสธ +)', async () => {
    await client().searchPersons('t', { q: 'สมชาย ใจดี' });
    expect(calls[0].url).toContain('%20');
    expect(calls[0].url).not.toContain('+');
  });

  test('ถ้า API เผลอคืน employeeNo มา ผลลัพธ์ของ mdmClient ต้องไม่มี key นี้ (ทุกชั้น)', async () => {
    const leaked = '1234567890123';
    responder = () => ({
      data: [{ personId: 'a', basic: { firstNameTh: 'ก', employeeNo: leaked }, employment: { employeeNo: leaked } }],
      page: { nextCursor: null },
    });
    const search = await client().searchPersons('t', {});
    expect(JSON.stringify(search)).not.toContain(leaked);
    expect(search.data[0].basic).not.toHaveProperty('employeeNo');
    expect(search.data[0].employment).not.toHaveProperty('employeeNo');

    responder = () => ({ personId: 'a', basic: { employeeNo: leaked }, employment: { employeeNo: leaked } });
    expect(JSON.stringify(await client().getPerson('t', 'a'))).not.toContain(leaked);

    responder = () => [{ employeeNo: leaked, personnelType: 'OTHER' }];
    const history = await client().getEmployment('t', 'a');
    expect(history[0]).not.toHaveProperty('employeeNo');
    expect(history[0].personnelType).toBe('OTHER');
  });

  test('stripEmployeeNo ไม่แตะ key อื่น และไม่แก้ object ต้นทาง', () => {
    const input = { a: [{ employeeNo: 'x', keep: 1 }], employeeNoMasked: 'X-XXXX-XXXX5-67-8' };
    const out = stripEmployeeNo(input);
    expect(out).toEqual({ a: [{ keep: 1 }], employeeNoMasked: 'X-XXXX-XXXX5-67-8' });
    expect(input.a[0].employeeNo).toBe('x');
  });

  test('revealPid ส่งเหตุผลใน JSON body ของ POST /pid (ไม่อยู่ใน URL) และคืนเฉพาะเลข (ไม่ถูก strip)', async () => {
    responder = () => ({ personId: 'p1', pid: '3100000005678' });
    const pid = await client().revealPid('t', 'p1', 'ตรวจเอกสารบรรจุ');
    expect(pid).toBe('3100000005678');
    expect(calls[0].url).toMatch(/\/api\/v1\/persons\/p1\/pid$/);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ justification: 'ตรวจเอกสารบรรจุ' });
  });
});

describe('csrfTokenMatches', () => {
  test('ตรงกันเท่านั้นถึงผ่าน', () => {
    const token = newCsrfToken();
    expect(csrfTokenMatches(token, token)).toBe(true);
    expect(csrfTokenMatches(token, newCsrfToken())).toBe(false);
  });
  test('ความยาวต่างกัน/ว่าง/ไม่ใช่สตริง -> false และไม่ throw (timingSafeEqual throw ถ้าความยาวต่าง)', () => {
    const token = newCsrfToken();
    for (const bad of ['', 'x', 'x'.repeat(200), token.slice(1), `${token}x`, undefined, null, 123, ['a'], {}]) {
      expect(() => csrfTokenMatches(token, bad)).not.toThrow();
      expect(csrfTokenMatches(token, bad)).toBe(false);
    }
    expect(csrfTokenMatches(undefined, undefined)).toBe(false);
    expect(csrfTokenMatches('', '')).toBe(false);
  });
});

describe('validateReason', () => {
  test('ต้องไม่สั้นกว่า 10 ตัวอักษร (หลัง trim)', () => {
    expect(validateReason('   สั้นไป   ').errors).not.toHaveLength(0);
    expect(validateReason('เหตุผลที่ยาวพอ').errors).toHaveLength(0);
    expect(validateReason(undefined).errors).not.toHaveLength(0);
  });
  test('ปฏิเสธเหตุผลที่มีเลข 13 หลักปนอยู่ (รวมแบบมีขีดคั่น)', () => {
    expect(validateReason('ตรวจเลข 3100000005678 ในเอกสาร').errors).not.toHaveLength(0);
    expect(validateReason('ตรวจเลข 3-1000-00005-67-8 ในเอกสาร').errors).not.toHaveLength(0);
  });
});

describe('GET /hr/persons: ค้นหา', () => {
  test('ต้อง login ก่อน (ไม่มี session -> redirect ไป login)', async () => {
    const request = require('supertest');
    const res = await request(harness.hrConsoleApp).get('/hr/persons');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('เห็นรายการ + เลขปิด + ไม่มีเลขเต็ม + no-store + มีเมนูใน layout', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-masked-code');

    const res = await agent.get('/hr/persons').query({ q: `${first} ${last}` });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(first);
    expect(res.text).toContain(`/hr/persons/${personId}`);
    expect(res.text).toContain(maskPid(pid));
    expect(res.text).not.toContain(pid);
    expect(res.text).toContain('<a href="/hr/persons">ข้อมูลบุคคล</a>');
    expect(res.text).toContain('เลขบัตร (ปิด)');
  });

  test('ไม่มี scope pid_masked -> ซ่อนคอลัมน์ ไม่มี error', async () => {
    const { first, last } = uniqueName();
    const { pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-a-code');
    const res = await agent.get('/hr/persons').query({ q: first });
    expect(res.status).toBe(200);
    expect(res.text).toContain(first);
    expect(res.text).not.toContain('เลขบัตร (ปิด)');
    expect(res.text).not.toContain(maskPid(pid));
    expect(res.text).not.toContain('class="error"');
  });

  test('ตัวกรองสถานะ: PENDING_CLAIM / INACTIVE / ทั้งหมด', async () => {
    const { first, last } = uniqueName();
    const active = await makePerson({ first, last, status: 'ACTIVE' });
    const pending = await makePerson({ first, last: `${last}p`, status: 'PENDING_CLAIM' });
    const inactive = await makePerson({ first, last: `${last}i`, status: 'INACTIVE' });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-a-code');

    const only = async (status) => (await agent.get('/hr/persons').query({ q: first, status })).text;
    const pendingHtml = await only('PENDING_CLAIM');
    expect(pendingHtml).toContain(pending.personId);
    expect(pendingHtml).not.toContain(active.personId);

    const inactiveHtml = await only('INACTIVE');
    expect(inactiveHtml).toContain(inactive.personId);
    expect(inactiveHtml).not.toContain(active.personId);

    const allHtml = await only('ALL');
    for (const p of [active, pending, inactive]) expect(allHtml).toContain(p.personId);
  });

  test('ไม่มี read:inactive -> ไม่มีตัวเลือก INACTIVE และ "ทั้งหมด" ไม่รวมผู้พ้นสภาพ (ไม่เกิด 403)', async () => {
    const { first, last } = uniqueName();
    const inactive = await makePerson({ first, last, status: 'INACTIVE' });
    const active = await makePerson({ first, last: `${last}a` });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'good-code'); // ไม่มี read:inactive

    const form = await agent.get('/hr/persons');
    expect(form.text).not.toContain('value="INACTIVE"');

    const res = await agent.get('/hr/persons').query({ q: first, status: 'INACTIVE' }); // ขอตรงๆ -> ถูกปรับเป็น ALL
    expect(res.status).toBe(200);
    expect(res.text).toContain(active.personId);
    expect(res.text).not.toContain(inactive.personId);
  });

  test('กรองประเภทบุคลากร และแสดง job_title_text/ตำแหน่ง', async () => {
    const { first, last } = uniqueName();
    const a = await makePerson({ first, last, personnelType: 'GENERAL_EMPLOYEE', jobTitleText: 'พนักงานขับรถ' });
    const b = await makePerson({ first, last: `${last}b`, personnelType: 'OUTSOURCE_INDIVIDUAL' });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-a-code');
    const res = await agent.get('/hr/persons').query({ q: first, personnelType: 'GENERAL_EMPLOYEE', orgUnitId });
    expect(res.text).toContain(a.personId);
    expect(res.text).not.toContain(b.personId);
    expect(res.text).toContain('พนักงานขับรถ');
  });

  test('หน้าถัดไปแบบ cursor เก็บเฉพาะ q/status/orgUnitId/personnelType/cursor ใน URL', async () => {
    const { first } = uniqueName();
    for (let i = 0; i < 51; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makePerson({ first, last: `Pg${i}` });
    }
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-masked-code');
    const page1 = await agent.get('/hr/persons').query({ q: first, status: 'ACTIVE' });
    const next = /href="(\/hr\/persons\?[^"]*cursor=[^"]+)"/.exec(page1.text)?.[1];
    expect(next).toBeDefined();
    const keys = [...new URLSearchParams(next.split('?')[1].replace(/&amp;/g, '&')).keys()].sort();
    expect(keys).toEqual(['cursor', 'q', 'status']);
    expect((await agent.get(next.replace(/&amp;/g, '&'))).status).toBe(200);
  });

  test('คำค้นสั้นกว่า 2 ตัวอักษร -> แจ้งในหน้า ไม่เรียก API', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-a-code');
    const res = await agent.get('/hr/persons').query({ q: 'ก' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('อย่างน้อย 2 ตัวอักษร');
  });
});

describe('GET /hr/persons/:id: รายละเอียด', () => {
  test('แสดง basic/สถานะ/verification/ตำแหน่ง+job_title_text/ประวัติ employment และเลขปิด ไม่มีเลขเต็ม', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last, jobTitleText: 'ผู้ช่วยช่างไฟฟ้า' });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-masked-code');

    const res = await agent.get(`/hr/persons/${personId}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(first);
    expect(res.text).toContain('ACTIVE');
    expect(res.text).toContain('VERIFIED');
    expect(res.text).toContain('ผู้ช่วยช่างไฟฟ้า');
    expect(res.text).toContain('ประวัติการปฏิบัติงาน');
    expect(res.text).toContain(maskPid(pid));
    expect(res.text).not.toContain(pid);
    expect(res.text).not.toContain('แสดงเลขบัตร'); // ไม่มี read:pid -> ซ่อนปุ่ม
  });

  test('ไม่มี pid_masked -> ซ่อนช่องเลขบัตร; ไม่มี read:employment -> ไม่เรียกประวัติและไม่แสดง error', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'good-code');
    const res = await agent.get(`/hr/persons/${personId}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('เลขบัตรประชาชน');
    expect(res.text).not.toContain(maskPid(pid));
    expect(res.text).toContain('ไม่มีสิทธิ์ดูประวัติการปฏิบัติงาน');
  });

  test('มี read:pid -> มีปุ่ม "แสดงเลขบัตร" แต่ยังไม่แสดงเลขเต็มในหน้ารายละเอียด', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const res = await agent.get(`/hr/persons/${personId}`);
    expect(res.text).toContain('แสดงเลขบัตร');
    expect(res.text).not.toContain(pid);
  });

  test('ไม่พบ / id ไม่ถูกต้อง -> 404', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-a-code');
    expect((await agent.get(`/hr/persons/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await agent.get('/hr/persons/not-a-uuid')).status).toBe(404);
  });
});

describe('แสดงเลขบัตร (POST + CSRF + เหตุผล)', () => {
  const REASON = 'ตรวจสอบเอกสารประกอบการบรรจุ';

  async function openForm(agent, personId) {
    const form = await agent.get(`/hr/persons/${personId}/reveal-pid`);
    expect(form.status).toBe(200);
    expect(form.headers['cache-control']).toBe('no-store');
    return csrfFrom(form.text);
  }

  async function accessLogRows(personId) {
    const { rows } = await adminPool.query(
      `SELECT actor_sub, justification, fields_returned, endpoint FROM audit.access_log WHERE subject_person_id = $1 AND fields_returned = '["pid"]'::jsonb`,
      [personId]
    );
    return rows;
  }

  test('สำเร็จ: ได้เลขเต็มใน response ของ POST (no-store, ไม่ redirect) และบันทึกเหตุผล+ผู้กดลง access_log', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const csrf = await openForm(agent, personId);

    const res = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send({ _csrf: csrf, justification: REASON });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain(pid);

    const rows = await accessLogRows(personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_sub).toBe('hr.persons.pid');
    expect(rows[0].justification).toBe(REASON);
    expect(JSON.stringify(rows[0])).not.toContain(pid);

    // กลับไปหน้ารายละเอียด -> แสดงแบบปิดเหมือนเดิม และเลขไม่ถูกเก็บใน session
    const detail = await agent.get(`/hr/persons/${personId}`);
    expect(detail.text).not.toContain(pid);
    // เลขเต็มต้องไม่ถูกเก็บในข้อมูลของ session ใด ๆ
    const sessions = harness.sessionStore.allDataForTest();
    expect(sessions.length).toBeGreaterThan(0);
    for (const data of sessions) expect(JSON.stringify(data)).not.toContain(pid);
  });

  test('ไม่มี/ผิด CSRF (ความยาวเท่า/สั้น/ยาว/ซ้ำ) -> 403 ไม่ใช่ 500 และไม่เรียก API (ไม่มี access_log)', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');

    const attempts = [
      { justification: REASON }, // ไม่ส่ง _csrf
      { _csrf: '', justification: REASON },
      { _csrf: 'x'.repeat(43), justification: REASON }, // ยาวเท่า token จริง
      { _csrf: 'x', justification: REASON }, // สั้น
      { _csrf: 'x'.repeat(200), justification: REASON }, // ยาว
    ];
    for (const body of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const res = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send(body);
      expect(res.status).toBe(403);
      expect(res.text).not.toContain(pid);
    }
    // _csrf ซ้ำสองค่า (array) ก็ต้องไม่ทำให้พัง
    const dup = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send('_csrf=a&_csrf=b&justification=' + encodeURIComponent(REASON));
    expect(dup.status).toBe(403);
    expect(await accessLogRows(personId)).toHaveLength(0);
  });

  test('CSRF ของ session อื่นใช้ไม่ได้', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    const a = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const b = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const csrfA = await openForm(a, personId);
    const res = await b.post(`/hr/persons/${personId}/reveal-pid`).type('form').send({ _csrf: csrfA, justification: REASON });
    expect(res.status).toBe(403);
  });

  test('เหตุผลสั้น/ว่าง -> 422 แสดงฟอร์มเดิม ไม่เรียก API', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const csrf = await openForm(agent, personId);
    for (const justification of ['', '   ', 'สั้นไป']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send({ _csrf: csrf, justification });
      expect(res.status).toBe(422);
      expect(res.text).toContain('อย่างน้อย 10 ตัวอักษร');
      expect(res.text).not.toContain(pid);
    }
    expect(await accessLogRows(personId)).toHaveLength(0);
  });

  test('เหตุผลที่มีเลขบัตร 13 หลัก -> 422 และไม่ถูกส่งไป API', async () => {
    const { first, last } = uniqueName();
    const { personId } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const csrf = await openForm(agent, personId);
    const res = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send({ _csrf: csrf, justification: 'ตรวจเลข 3100000005678 กับเอกสาร' });
    expect(res.status).toBe(422);
    expect(await accessLogRows(personId)).toHaveLength(0);
  });

  test('token ไม่มี read:pid -> ฟอร์ม/POST ตอบ 403 เพราะไม่มี scope (ไม่ใช่เพราะ CSRF ผิด) และไม่เรียก API', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-masked-code');
    expect((await agent.get(`/hr/persons/${personId}/reveal-pid`)).status).toBe(403);

    // ฟอร์มไม่ render จึงไม่มี CSRF ให้อ่านจากหน้าเว็บ - ใช้ CSRF ที่ถูกต้องของ session นี้จาก sessionStore (session ที่ใช้ล่าสุดอยู่ท้ายสุด)
    const own = harness.sessionStore.allDataForTest().filter((d) => d.displayName === 'HR เห็นเลขปิด').pop();
    expect(own.csrfToken).toBeTruthy();

    const res = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send({ _csrf: own.csrfToken, justification: REASON });
    expect(res.status).toBe(403);
    expect(res.text).toContain('ยังไม่ได้รับสิทธิ์แสดงเลขบัตรประชาชน');
    expect(res.text).not.toContain('CSRF');
    expect(res.text).not.toContain(pid);
    expect(await accessLogRows(personId)).toHaveLength(0);
  });

  test('ไม่มีเลขบัตรใน URL ของ response ใด ๆ (ฟอร์ม action และลิงก์กลับ)', async () => {
    const { first, last } = uniqueName();
    const { personId, pid } = await makePerson({ first, last });
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'persons-pid-code');
    const csrf = await openForm(agent, personId);
    const res = await agent.post(`/hr/persons/${personId}/reveal-pid`).type('form').send({ _csrf: csrf, justification: REASON });
    const hrefs = [...res.text.matchAll(/(?:href|action)="([^"]*)"/g)].map((m) => m[1]);
    for (const href of hrefs) expect(href).not.toContain(pid);
  });
});
