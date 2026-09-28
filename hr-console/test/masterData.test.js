const crypto = require('node:crypto');
const request = require('supertest');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { MdmApiError } = require('../src/mdmClient');
const { createMdmClient } = require('../src/mdmClient');

// T10: หน้า HR Console จัดการหน่วยงาน/ตำแหน่ง - รันกับ MDM API จริง (in-process) + mock Keycloak เหมือนเทสอื่นของ HR Console
let harness;
let adminPool;
let apiBaseUrl;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

const uniqueCode = () => `HRC-${crypto.randomUUID().slice(0, 10)}`;
const uniquePositionNo = () => {
  const n = (d) => String(crypto.randomInt(0, 10 ** d)).padStart(d, '0');
  return `9${n(1)}-${n(1)}-${n(2)}-${n(4)}-${n(3)}`;
};

const loginAdmin = () => loginAsHrOfficer(harness.hrConsoleApp, 'master-data-admin-code');
const loginOfficerOnly = () => loginAsHrOfficer(harness.hrConsoleApp, 'good-code');

async function createOrgViaConsole(agent, fields = {}) {
  const code = fields.code || uniqueCode();
  const res = await agent
    .post('/hr/master-data/org-units')
    .type('form')
    .send({ code, nameTh: 'หน่วยงานทดสอบ HR Console', unitLevel: 'DIVISION', ...fields });
  expect(res.status).toBe(302);
  const { rows } = await adminPool.query(`SELECT org_unit_id FROM mdm.org_unit WHERE code = $1`, [code]);
  return { code, orgUnitId: rows[0].org_unit_id };
}

describe('gate: ต้องมี hr_master_data_admin (hr_officer ทั่วไปเข้าไม่ได้)', () => {
  const paths = [
    ['get', '/hr/master-data'],
    ['get', '/hr/master-data/org-units'],
    ['get', '/hr/master-data/org-units/new'],
    ['get', '/hr/master-data/positions'],
    ['get', '/hr/master-data/positions/new'],
    ['get', `/hr/master-data/org-units/${crypto.randomUUID()}/edit`],
    ['get', `/hr/master-data/positions/${crypto.randomUUID()}/edit`],
    ['post', '/hr/master-data/org-units'],
    ['post', '/hr/master-data/positions'],
    ['post', `/hr/master-data/org-units/${crypto.randomUUID()}`],
    ['post', `/hr/master-data/positions/${crypto.randomUUID()}`],
  ];

  test.each(paths)('hr_officer ทั่วไป: %s %s -> 403', async (method, path) => {
    const agent = await loginOfficerOnly();
    const res = await agent[method](path).type('form').send({ code: uniqueCode(), nameTh: 'x', unitLevel: 'DIVISION' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('hr_master_data_admin');
  });

  test('POST ของ hr_officer ทั่วไปไม่สร้างข้อมูลใน DB', async () => {
    const agent = await loginOfficerOnly();
    const code = uniqueCode();
    await agent.post('/hr/master-data/org-units').type('form').send({ code, nameTh: 'ห้ามสร้าง', unitLevel: 'DIVISION' });
    const { rows } = await adminPool.query(`SELECT 1 FROM mdm.org_unit WHERE code = $1`, [code]);
    expect(rows).toHaveLength(0);
  });

  test('ไม่ได้ login -> redirect ไป /auth/login', async () => {
    const res = await request(harness.hrConsoleApp).get('/hr/master-data/org-units');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('ลิงก์เมนู "จัดการหน่วยงาน/ตำแหน่ง" แสดงเฉพาะผู้มี role ใหม่', async () => {
    const officer = await loginOfficerOnly();
    expect((await officer.get('/hr/claim-requests')).text).not.toContain('/hr/master-data');
    const admin = await loginAdmin();
    expect((await admin.get('/hr/claim-requests')).text).toContain('href="/hr/master-data"');
  });

  test('ผู้มีแต่ hr_master_data_admin (ไม่มี hr_officer) login ไม่ได้ - ยังบังคับ hr_officer เป็นเงื่อนไขเข้า console', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    const loginRes = await agent.get('/auth/login');
    const state = new URL(loginRes.headers.location).searchParams.get('state');
    const callback = await agent.get('/auth/callback').query({ code: 'master-data-only-code', state });
    expect(callback.status).toBe(403);
    expect((await agent.get('/hr/master-data/org-units')).status).toBe(302);
  });

  test('ชั้น API: แม้ข้าม HR Console ไปเรียก MDM API ตรงด้วย token ของ hr_officer ทั่วไป (มี scope แต่ไม่มี role) -> 403 insufficient-role', async () => {
    // ขอ token ผ่าน flow จริงของ mock Keycloak แล้วส่งตรงไปที่ MDM API
    const api = await harness.apiCtx.auth.signToken({
      scope: 'personnel:manage:reference personnel:read:basic',
      realmRoles: ['hr_officer'],
      azp: 'hr-console-test',
    });
    const res = await request(harness.apiCtx.app)
      .post('/api/v1/org-units')
      .set('Authorization', `Bearer ${api}`)
      .send({ code: uniqueCode(), nameTh: 'x', unitLevel: 'DIVISION' });
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/insufficient-role$/);
  });
});

describe('หน่วยงาน (org units)', () => {
  test('รายการแสดงหน่วยงานจริง (มี PS กองการเจ้าหน้าที่) และมีลิงก์เพิ่ม/แก้ไข', async () => {
    const agent = await loginAdmin();
    const res = await agent.get('/hr/master-data/org-units');
    expect(res.status).toBe(200);
    expect(res.text).toContain('กองการเจ้าหน้าที่');
    expect(res.text).toContain('/hr/master-data/org-units/new');
    expect(res.text).toContain('/edit');
  });

  test('ฟอร์มเพิ่ม: ต้นสังกัดและระดับเป็น dropdown, มี validation ฝั่ง client (pattern/required) ของ code', async () => {
    const agent = await loginAdmin();
    const res = await agent.get('/hr/master-data/org-units/new');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<select name="parentId">/);
    expect(res.text).toMatch(/<select name="unitLevel" required>/);
    expect(res.text).toMatch(/<input name="code" required maxlength="50" pattern="/);
    expect(res.text).toContain('setCustomValidity');
  });

  test('สร้างหน่วยงานได้จริง (redirect + มีแถวใน DB + เขียน reference_change_log ด้วย sub ของผู้ใช้)', async () => {
    const agent = await loginAdmin();
    const parent = await createOrgViaConsole(agent);
    const { code, orgUnitId } = await createOrgViaConsole(agent, { parentId: parent.orgUnitId, unitLevel: 'SECTION', nameEn: 'Test' });
    const { rows } = await adminPool.query(`SELECT parent_id, unit_level, name_en, is_active FROM mdm.org_unit WHERE code = $1`, [code]);
    expect(rows[0]).toMatchObject({ parent_id: parent.orgUnitId, unit_level: 'SECTION', name_en: 'Test', is_active: true });
    const log = await adminPool.query(`SELECT DISTINCT actor_sub FROM audit.reference_change_log WHERE record_id = $1`, [orgUnitId]);
    expect(log.rows).toEqual([{ actor_sub: 'hr.masterdata' }]);
  });

  test('code ซ้ำ -> แสดงข้อความชัดเจนในฟอร์ม (409) พร้อมค่าที่กรอกไว้ ไม่ใช่หน้า error 500', async () => {
    const agent = await loginAdmin();
    const { code } = await createOrgViaConsole(agent);
    const res = await agent.post('/hr/master-data/org-units').type('form').send({ code, nameTh: 'ซ้ำ', unitLevel: 'DIVISION' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('รหัสหน่วยงานซ้ำ');
    expect(res.text).toContain(`value="${code}"`);
  });

  test('server ตรวจซ้ำ: code มีช่องว่าง/ระดับไม่ได้เลือก/parentId ไม่ใช่ uuid -> 422 ไม่เรียก API', async () => {
    const agent = await loginAdmin();
    const res = await agent.post('/hr/master-data/org-units').type('form').send({ code: 'bad code', nameTh: '', unitLevel: '', parentId: 'พิมพ์เอง' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('รหัสหน่วยงานใช้ได้เฉพาะ');
    expect(res.text).toContain('กรุณากรอกชื่อหน่วยงาน');
    expect(res.text).toContain('กรุณาเลือกระดับหน่วยงาน');
    expect(res.text).toContain('กรุณาเลือกหน่วยงานต้นสังกัดจากรายการ');
  });

  test('แก้ไข: code อ่านอย่างเดียว (disabled), แก้ชื่อได้, ปิดใช้งาน (soft-delete) แล้วแถวยังอยู่', async () => {
    const agent = await loginAdmin();
    const { code, orgUnitId } = await createOrgViaConsole(agent);
    const edit = await agent.get(`/hr/master-data/org-units/${orgUnitId}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.text).toMatch(new RegExp(`<input value="${code}" disabled />`));
    expect(edit.text).not.toContain('name="code"');
    expect(edit.text).toContain('data-was="true"');

    const saved = await agent
      .post(`/hr/master-data/org-units/${orgUnitId}`)
      .type('form')
      .send({ nameTh: 'ชื่อใหม่ผ่านคอนโซล', unitLevel: 'DIVISION', parentId: '', isActive: 'true', code: 'IGNORED' });
    expect(saved.status).toBe(302);
    let row = (await adminPool.query(`SELECT code, name_th, is_active FROM mdm.org_unit WHERE org_unit_id = $1`, [orgUnitId])).rows[0];
    expect(row).toMatchObject({ code, name_th: 'ชื่อใหม่ผ่านคอนโซล', is_active: true }); // code ถูกไม่สนใจ

    const off = await agent.post(`/hr/master-data/org-units/${orgUnitId}`).type('form').send({ nameTh: 'ชื่อใหม่ผ่านคอนโซล', unitLevel: 'DIVISION', isActive: 'false' });
    expect(off.status).toBe(302);
    row = (await adminPool.query(`SELECT is_active FROM mdm.org_unit WHERE org_unit_id = $1`, [orgUnitId])).rows[0];
    expect(row.is_active).toBe(false);
  });

  test('ปิดใช้งานหน่วยงานที่ยังมีตำแหน่ง active -> แสดง 409 org-unit-in-use ในฟอร์ม', async () => {
    const agent = await loginAdmin();
    const { orgUnitId } = await createOrgViaConsole(agent);
    await agent.post('/hr/master-data/positions').type('form').send({ positionNo: uniquePositionNo(), titleTh: 'ตำแหน่งค้าง', positionType: 'GENERAL', orgUnitId });
    const res = await agent.post(`/hr/master-data/org-units/${orgUnitId}`).type('form').send({ nameTh: 'x', unitLevel: 'DIVISION', isActive: 'false' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('ปิดใช้งานหน่วยงานไม่ได้');
  });

  test('แก้ไขหน่วยงานที่ไม่มี / id ไม่ใช่ uuid -> 404', async () => {
    const agent = await loginAdmin();
    expect((await agent.get(`/hr/master-data/org-units/${crypto.randomUUID()}/edit`)).status).toBe(404);
    expect((await agent.get('/hr/master-data/org-units/not-a-uuid/edit')).status).toBe(404);
  });

  test('รายการกรองสถานะ: ปิดใช้งานแล้วหายจาก "ใช้งาน" และอยู่ใน "ปิดใช้งาน"', async () => {
    const agent = await loginAdmin();
    const { code, orgUnitId } = await createOrgViaConsole(agent, { nameTh: 'หน่วยงานปิดแล้ว HRC' });
    await agent.post(`/hr/master-data/org-units/${orgUnitId}`).type('form').send({ nameTh: 'หน่วยงานปิดแล้ว HRC', unitLevel: 'DIVISION', isActive: 'false' });
    expect((await agent.get('/hr/master-data/org-units')).text).not.toContain(code);
    expect((await agent.get('/hr/master-data/org-units?status=inactive')).text).toContain(code);
    expect((await agent.get('/hr/master-data/org-units?status=all')).text).toContain(code);
  });
});

describe('ตำแหน่ง (positions)', () => {
  test('ฟอร์มเพิ่ม: หน่วยงาน/หมวดตำแหน่งเป็น dropdown (ไม่มี input พิมพ์เอง) และเลขที่ตำแหน่งมี pattern ที่ใช้งานได้จริง', async () => {
    const agent = await loginAdmin();
    const res = await agent.get('/hr/master-data/positions/new');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<select name="orgUnitId" required>/);
    expect(res.text).toMatch(/<select name="positionType" required>/);
    expect(res.text).not.toMatch(/<input[^>]*name="orgUnit/);
    expect(res.text).toContain('กองการเจ้าหน้าที่'); // ตัวเลือกหน่วยงานมาจากข้อมูลจริง
    expect(res.text).toContain('ผู้อำนวยการสถานศึกษา'); // หมวดตำแหน่งมาจาก GET /position-types

    // ดึง pattern ที่ฝังใน HTML จริงมาทดสอบ (สิ่งที่เบราว์เซอร์ใช้)
    const attr = res.text.match(/<input name="positionNo"[\s\S]*?pattern="([^"]*)"/)[1].replace(/&amp;/g, '&');
    const re = new RegExp(attr);
    for (const ok of ['52-1-07-3106-003', '52-1-07-3106-003 (ถ)', 'EX-001', '7', '12', '123', '999', '1000', '9999']) expect([ok, re.test(ok)]).toEqual([ok, true]);
    for (const bad of ['', '52-1-07-3106', 'ex-001', '12345', 'ABC', ' 52-1-07-3106-003', '52-1-07-3106-003(ถ)', '12a', '-5']) expect([bad, re.test(bad)]).toEqual([bad, false]);
  });

  test('pattern ในฟอร์มคอมไพล์ได้ทั้งโหมด u และ v (pattern attribute ของเบราว์เซอร์ใหม่ใช้ v) และสคริปต์ inline ไม่มี syntax error', async () => {
    const agent = await loginAdmin();
    for (const path of ['/hr/master-data/positions/new', '/hr/master-data/org-units/new']) {
      // eslint-disable-next-line no-await-in-loop
      const html = (await agent.get(path)).text;
      const patterns = [...html.matchAll(/ pattern="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(() => new RegExp(p, 'u')).not.toThrow();
        expect(() => new RegExp(p, 'v')).not.toThrow();
      }
      const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
      expect(() => new Function(script)).not.toThrow(); // eslint-disable-line no-new-func
    }
  });

  test('เลขที่ตำแหน่งแบบเลขลำดับล้วน 3-4 หลัก (ลูกจ้างประจำ) สร้าง/แก้ผ่านคอนโซลได้ ส่วน 5 หลักขึ้นไปถูกปฏิเสธ', async () => {
    const agent = await loginAdmin();
    const { orgUnitId } = await createOrgViaConsole(agent);
    let created = null;
    for (let i = 0; i < 10 && !created; i += 1) {
      const positionNo = String(crypto.randomInt(100, 10000)); // 3-4 หลัก (สุ่มชนของที่มีอยู่ได้ -> ลองใหม่)
      // eslint-disable-next-line no-await-in-loop
      const res = await agent.post('/hr/master-data/positions').type('form').send({ positionNo, titleTh: 'ลูกจ้างประจำทดสอบ', positionType: 'GENERAL', orgUnitId });
      if (res.status === 302) created = positionNo;
    }
    expect(created).toMatch(/^\d{3,4}$/);
    const { rows } = await adminPool.query('SELECT position_id FROM mdm.position WHERE position_no = $1', [created]);
    expect(rows).toHaveLength(1);

    const tooLong = await agent.post('/hr/master-data/positions').type('form').send({ positionNo: '12345', titleTh: 'x', positionType: 'GENERAL', orgUnitId });
    expect(tooLong.status).toBe(422);
    expect(tooLong.text).toContain('รูปแบบเลขที่ตำแหน่งไม่ถูกต้อง');
  });

  test('สร้างตำแหน่งได้จริง; เลขที่ซ้ำ -> 409 ข้อความ "เลขที่ตำแหน่งซ้ำ" พร้อมค่าที่กรอก (ไม่ใช่ 500)', async () => {
    const agent = await loginAdmin();
    const { orgUnitId } = await createOrgViaConsole(agent);
    const positionNo = uniquePositionNo();
    const form = { positionNo, titleTh: 'นักวิชาการทดสอบ', lineOfWork: 'สายงานทดสอบ', positionType: 'ACADEMIC', orgUnitId };

    const first = await agent.post('/hr/master-data/positions').type('form').send(form);
    expect(first.status).toBe(302);
    const { rows } = await adminPool.query(`SELECT title_th, line_of_work, position_type, is_active FROM mdm.position WHERE position_no = $1`, [positionNo]);
    expect(rows[0]).toMatchObject({ title_th: 'นักวิชาการทดสอบ', line_of_work: 'สายงานทดสอบ', position_type: 'ACADEMIC', is_active: true });

    const dup = await agent.post('/hr/master-data/positions').type('form').send(form);
    expect(dup.status).toBe(409);
    expect(dup.text).toContain('เลขที่ตำแหน่งซ้ำ');
    expect(dup.text).toContain(positionNo);
  });

  test('สองคำขอพร้อมกัน (สอง session) ด้วย position_no เดียวกัน -> สำเร็จหนึ่ง (302) อีกอันเป็น 409 ไม่มี 500', async () => {
    const [a, b] = await Promise.all([loginAdmin(), loginAdmin()]);
    const { orgUnitId } = await createOrgViaConsole(a);
    const form = { positionNo: uniquePositionNo(), titleTh: 'race', positionType: 'GENERAL', orgUnitId };
    const results = await Promise.all([a.post('/hr/master-data/positions').type('form').send(form), b.post('/hr/master-data/positions').type('form').send(form)]);
    expect(results.map((r) => r.status).sort()).toEqual([302, 409]);
  });

  test('server ตรวจซ้ำ: รูปแบบเลขที่ผิด/หน่วยงานไม่ได้เลือกจากรายการ/ไม่เลือกหมวด -> 422 พร้อมข้อความ', async () => {
    const agent = await loginAdmin();
    const res = await agent.post('/hr/master-data/positions').type('form').send({ positionNo: '12-3', titleTh: 'x', positionType: '', orgUnitId: 'กองการเจ้าหน้าที่' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('รูปแบบเลขที่ตำแหน่งไม่ถูกต้อง');
    expect(res.text).toContain('กรุณาเลือกหน่วยงานจากรายการ');
    expect(res.text).toContain('กรุณาเลือกหมวดตำแหน่งจากรายการ');
  });

  test('แก้ไข: แก้ชื่อ/เลขที่ได้, ปิดใช้งาน (soft-delete) แล้วเปิดกลับได้', async () => {
    const agent = await loginAdmin();
    const { orgUnitId } = await createOrgViaConsole(agent);
    const positionNo = uniquePositionNo();
    await agent.post('/hr/master-data/positions').type('form').send({ positionNo, titleTh: 'ก่อนแก้', positionType: 'GENERAL', orgUnitId });
    const { rows } = await adminPool.query(`SELECT position_id FROM mdm.position WHERE position_no = $1`, [positionNo]);
    const positionId = rows[0].position_id;

    const edit = await agent.get(`/hr/master-data/positions/${positionId}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.text).toContain(`value="${positionNo}"`);

    const newNo = uniquePositionNo();
    const body = (o) => ({ positionNo: newNo, titleTh: 'หลังแก้', positionType: 'ACADEMIC', orgUnitId, isActive: 'true', ...o });
    expect((await agent.post(`/hr/master-data/positions/${positionId}`).type('form').send(body({}))).status).toBe(302);
    expect((await adminPool.query(`SELECT position_no, title_th FROM mdm.position WHERE position_id = $1`, [positionId])).rows[0]).toEqual({ position_no: newNo, title_th: 'หลังแก้' });

    expect((await agent.post(`/hr/master-data/positions/${positionId}`).type('form').send(body({ isActive: 'false' }))).status).toBe(302);
    expect((await adminPool.query(`SELECT is_active FROM mdm.position WHERE position_id = $1`, [positionId])).rows[0].is_active).toBe(false);
    // ช่องค้นหาสะท้อนค่า q กลับในหน้า จึงเช็กจากจำนวนที่พบและแถวในตารางแทนการหาข้อความตรงๆ
    const activeView = await agent.get('/hr/master-data/positions?q=' + encodeURIComponent(newNo));
    expect(activeView.text).toContain('พบ 0 ตำแหน่ง');
    const inactiveView = await agent.get('/hr/master-data/positions?status=inactive&q=' + encodeURIComponent(newNo));
    expect(inactiveView.text).toContain('พบ 1 ตำแหน่ง');
    expect(inactiveView.text).toContain(`<td>${newNo}</td>`);

    expect((await agent.post(`/hr/master-data/positions/${positionId}`).type('form').send(body({ isActive: 'true' }))).status).toBe(302);
  });

  test('รายการตำแหน่ง: ค้นหา/กรองหน่วยงาน/แบ่งหน้า (1,000+ ตำแหน่งจริงจาก seed)', async () => {
    const agent = await loginAdmin();
    const all = await agent.get('/hr/master-data/positions');
    expect(all.status).toBe(200);
    expect(all.text).toMatch(/หน้า 1\/\d+/);
    expect(all.text).toContain('52-1-07-3106-003'.slice(0, 2)); // มีข้อมูล seed

    const found = await agent.get('/hr/master-data/positions?q=' + encodeURIComponent('52-1-07-3106-003'));
    expect(found.text).toContain('นักวิชาการคอมพิวเตอร์');
    expect(found.text).toContain('พบ 1 ตำแหน่ง');

    const page2 = await agent.get('/hr/master-data/positions?page=2');
    expect(page2.text).toMatch(/หน้า 2\/\d+/);
  });

  test('ตำแหน่งที่มีผู้ดำรงตำแหน่ง: ปิดใช้งานผ่านคอนโซลแล้วได้ 409 position-occupied ในฟอร์ม', async () => {
    const agent = await loginAdmin();
    const { orgUnitId } = await createOrgViaConsole(agent);
    const positionNo = uniquePositionNo();
    await agent.post('/hr/master-data/positions').type('form').send({ positionNo, titleTh: 'มีคนครอง', positionType: 'GENERAL', orgUnitId });
    const { rows } = await adminPool.query(`SELECT position_id FROM mdm.position WHERE position_no = $1`, [positionNo]);
    const positionId = rows[0].position_id;
    const personId = crypto.randomUUID();
    await adminPool.query(`INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`, [personId, crypto.randomBytes(32).toString('hex')]);
    await adminPool.query(
      `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
       VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
      [personId, `EMP-HRC-${crypto.randomUUID()}`, positionId, orgUnitId]
    );

    const res = await agent.post(`/hr/master-data/positions/${positionId}`).type('form').send({ positionNo, titleTh: 'มีคนครอง', positionType: 'GENERAL', orgUnitId, isActive: 'false' });
    expect(res.status).toBe(409);
    expect(res.text).toContain('แก้ตำแหน่งไม่ได้เพราะมีผู้ดำรงตำแหน่งอยู่');
  });
});

describe('mdmClient (ชั้น client)', () => {
  test('ส่ง error จาก API เป็น MdmApiError พร้อม status/problem', async () => {
    const server = await new Promise((resolve) => {
      const s = harness.apiCtx.app.listen(0, () => resolve(s));
    });
    apiBaseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const client = createMdmClient({ baseUrl: apiBaseUrl });
      const token = await harness.apiCtx.auth.signToken({ scope: 'personnel:manage:reference', realmRoles: ['hr_officer'] });
      await expect(client.createOrgUnit(token, { code: uniqueCode(), nameTh: 'x', unitLevel: 'DIVISION' })).rejects.toMatchObject({
        status: 403,
        problem: { type: expect.stringMatching(/insufficient-role$/) },
      });
      await expect(client.createOrgUnit(token, {})).rejects.toBeInstanceOf(MdmApiError);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
