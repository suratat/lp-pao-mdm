const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { loadApproveForm } = require('./approveFormDom');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { insertFixtureOrgUnit } = require('../../api/test/fixtures');
const { POSITION_RULES: API_RULES } = require('../../api/src/services/personnelPositionRules');
const { PERSONNEL_TYPES, positionRuleFor } = require('../src/personnelTypes');

// ฟอร์ม approve claim: dropdown "ตำแหน่ง" (positionId) lock ตามประเภทบุคลากร (พนักงานจ้าง/จ้างเหมา/ฝ่ายการเมือง = ห้ามมี, ข้าราชการ/ครู/
// ลูกจ้างประจำ/ถ่ายโอน = ต้องมี, อื่นๆ = ไม่บังคับ) + ตรวจซ้ำที่ server (ไม่พึ่ง disabled ฝั่ง client)
let harness;
let adminPool;
let orgUnitId;
const FORBIDDEN = ['CONTRACT_EMPLOYEE', 'GENERAL_EMPLOYEE', 'EXPERT_EMPLOYEE', 'OUTSOURCE_INDIVIDUAL', 'POLITICAL_APPOINTEE'];
const REQUIRED = ['CIVIL_SERVANT', 'TEACHER', 'PERMANENT_EMPLOYEE', 'TRANSFERRED_HEALTH'];

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  orgUnitId = await insertFixtureOrgUnit(adminPool);
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

async function makeClaim() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
     VALUES ($1, 'นายทดสอบ ล็อกตำแหน่ง', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
    [crypto.randomBytes(32).toString('hex')]
  );
  return rows[0].claim_request_id;
}

// เลขลำดับล้วน (แบบลูกจ้างประจำ) ที่ไม่ซ้ำ
async function makePosition({ isActive = true } = {}) {
  for (let i = 0; i < 20; i += 1) {
    const no = String(crypto.randomInt(1000, 10000));
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await adminPool.query(
      `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id, is_active)
       VALUES ($1, 'ลูกจ้างประจำทดสอบ', 'GENERAL', $2, $3) ON CONFLICT DO NOTHING RETURNING position_id`,
      [no, orgUnitId, isActive]
    );
    if (rows[0]) return { no, id: rows[0].position_id };
  }
  throw new Error('สุ่มเลขที่ตำแหน่งไม่ซ้ำไม่สำเร็จ');
}

const approve = (agent, claimId, fields) =>
  agent
    .post(`/hr/claim-requests/${claimId}/approve`)
    .type('form')
    .send({ employeeNo: makeFakePid(), orgUnitId, effectiveFrom: '2024-01-01', ...fields });

const claimStatus = async (id) => (await adminPool.query('SELECT status FROM mdm.claim_request WHERE claim_request_id = $1', [id])).rows[0].status;

describe('กฎในโค้ด hr-console ตรงกับ MDM API (กัน drift)', () => {
  test('ตาราง positionRule ของ hr-console = POSITION_RULES ของ API ทุกประเภท (และครบทุกประเภทใน dropdown)', () => {
    for (const t of PERSONNEL_TYPES) expect([t.value, t.positionRule]).toEqual([t.value, API_RULES[t.value]]);
    expect(PERSONNEL_TYPES.map((t) => t.value).sort()).toEqual(Object.keys(API_RULES).sort());
    for (const type of FORBIDDEN) expect(positionRuleFor(type)).toBe('FORBIDDEN');
    for (const type of REQUIRED) expect(positionRuleFor(type)).toBe('REQUIRED');
    expect(positionRuleFor('OTHER')).toBe('OPTIONAL');
    expect(positionRuleFor('UNKNOWN')).toBe('OPTIONAL');
  });
});

describe('หน้าฟอร์ม approve: โครงสร้าง HTML', () => {
  test('ช่องตำแหน่งเป็น select (positionId) ไม่ใช่ช่องพิมพ์, มีกฎครบทุกประเภทฝังใน select ประเภทบุคลากร', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const res = await agent.get(`/hr/claim-requests/${await makeClaim()}/approve`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<select name="positionId" id="positionId"/);
    expect(res.text).not.toContain('name="positionNo"');
    const rules = JSON.parse(res.text.match(/data-position-rules="([^"]*)"/)[1].replace(/&quot;/g, '"'));
    expect(rules).toEqual(API_RULES);
  });
});

// รัน "สคริปต์ inline จริง" ของหน้าใน DOM จำลอง (ดู approveFormDom.js) - พิสูจน์ logic การ lock/unlock ตอนโหลด, ตอนเปลี่ยน dropdown
// และตอน pageshow (คืนค่าฟอร์มเมื่อกด Back) โดยสร้างตำแหน่งใต้ orgUnitId ของเทสต์ไว้ก่อนโหลดหน้า
async function loadFormScript() {
  const position = await makePosition();
  const agent = await loginAsHrOfficer(harness.hrConsoleApp);
  const html = (await agent.get(`/hr/claim-requests/${await makeClaim()}/approve`)).text;
  const form = loadApproveForm(html);
  return { ...form, position, select: form.typeSelect, field: form.posSelect };
}

describe('สคริปต์ lock ช่องตำแหน่ง (รัน script จริง ใน DOM จำลอง)', () => {
  test('ตอนโหลดหน้า (ค่าเริ่มต้น = ข้าราชการ, ยังไม่เลือกหน่วยงาน): ช่อง disabled จนกว่าจะเลือกหน่วยงาน แต่ required', async () => {
    const { field, hint } = await loadFormScript();
    expect([field.disabled, field.required]).toEqual([true, true]);
    expect(hint.textContent).toContain('จำเป็นต้องระบุ');
  });

  test('เลือกหน่วยงานแล้ว (ข้าราชการ): ช่อง enable + required', async () => {
    const { field, chooseOrg } = await loadFormScript();
    chooseOrg(orgUnitId);
    expect([field.disabled, field.required]).toEqual([false, true]);
  });

  test.each(FORBIDDEN)('เลือก %s: ล้างค่า + disable + ไม่ required (แม้เลือกตำแหน่งไว้แล้ว)', async (type) => {
    const { field, hint, position, chooseOrg, chooseType } = await loadFormScript();
    chooseOrg(orgUnitId);
    field.value = position.id;
    chooseType(type);
    expect([field.value, field.disabled, field.required]).toEqual(['', true, false]);
    expect(hint.textContent).toContain('ไม่มีตำแหน่ง');
  });

  test.each(REQUIRED)('เลือก %s: enable + required และเลือกตำแหน่งได้', async (type) => {
    const { field, position, chooseOrg, chooseType } = await loadFormScript();
    chooseOrg(orgUnitId);
    chooseType('GENERAL_EMPLOYEE'); // ปิดก่อน แล้วเปลี่ยนกลับ - ต้องเปิดกลับได้
    expect(field.disabled).toBe(true);
    chooseType(type);
    expect([field.disabled, field.required]).toEqual([false, true]);
    expect(field.children.some((o) => o.value === position.id)).toBe(true);
  });

  test('OTHER: enable แต่ไม่ required', async () => {
    const { field, chooseOrg, chooseType } = await loadFormScript();
    chooseOrg(orgUnitId);
    chooseType('OTHER');
    expect([field.disabled, field.required]).toEqual([false, false]);
  });

  test('pageshow (กด Back แล้วเบราว์เซอร์คืนค่าฟอร์มเดิมโดยไม่ยิง change): สถานะช่องต้องกลับมาตรงกับประเภทที่เลือกอยู่', async () => {
    const { select, field, position, orgSelect, win } = await loadFormScript();
    orgSelect.value = orgUnitId; // เบราว์เซอร์คืนค่า select ทั้งสอง แต่ช่องตำแหน่งยัง enable + มีค่าเก่าค้าง
    select.value = 'GENERAL_EMPLOYEE';
    field.disabled = false;
    field.value = position.id;
    win.fire('pageshow');
    expect([field.value, field.disabled, field.required]).toEqual(['', true, false]);

    select.value = 'TEACHER';
    field.disabled = true; // สภาพตรงข้าม: คืนค่า select เป็นประเภทที่ต้องมี แต่ช่องค้าง disabled
    win.fire('pageshow');
    expect([field.disabled, field.required]).toEqual([false, true]);
  });
});

describe('ตรวจซ้ำที่ server (ข้าม client ผ่าน devtools/curl): ไม่เรียก API และไม่เปลี่ยน claim', () => {
  test.each(FORBIDDEN)('%s + ส่ง positionId มา -> 422 และ claim ยังรอ HR', async (type) => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const position = await makePosition();
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: type, positionId: position.id });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ห้ามระบุเลขที่ตำแหน่ง');
    expect(await claimStatus(claimId)).toBe('PENDING_HR');
  });

  test.each(REQUIRED)('%s + ไม่ส่ง positionId -> 422 และ claim ยังรอ HR', async (type) => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: type });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ต้องระบุเลขที่ตำแหน่ง');
    expect(await claimStatus(claimId)).toBe('PENDING_HR');
  });
});

describe('บันทึกผ่านจริง', () => {
  test('ลูกจ้างประจำ + ตำแหน่งเลขลำดับ (3-4 หลัก) ในหน่วยงานเดียวกัน -> บันทึกผ่าน และ employment ผูกตำแหน่งนั้นจริง', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const position = await makePosition();
    expect(position.no).toMatch(/^\d{4}$/);
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: 'PERMANENT_EMPLOYEE', positionId: position.id });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/hr/claim-requests?resolved=approved');
    const { rows } = await adminPool.query(
      `SELECT e.personnel_type, e.position_id FROM mdm.claim_request c JOIN mdm.employment e ON e.person_id = c.resolved_person_id
       WHERE c.claim_request_id = $1`,
      [claimId]
    );
    expect(rows).toEqual([{ personnel_type: 'PERMANENT_EMPLOYEE', position_id: position.id }]);
  });

  test.each(FORBIDDEN)('%s ไม่มีตำแหน่ง -> บันทึกผ่าน และ position_id เป็น NULL', async (type) => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: type });
    expect(res.status).toBe(302);
    const { rows } = await adminPool.query(
      `SELECT e.position_id FROM mdm.claim_request c JOIN mdm.employment e ON e.person_id = c.resolved_person_id WHERE c.claim_request_id = $1`,
      [claimId]
    );
    expect(rows).toEqual([{ position_id: null }]);
  });

  test('OTHER: มีหรือไม่มีตำแหน่งก็ผ่าน', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    expect((await approve(agent, await makeClaim(), { personnelType: 'OTHER' })).status).toBe(302);
    const position = await makePosition();
    expect((await approve(agent, await makeClaim(), { personnelType: 'OTHER', positionId: position.id })).status).toBe(302);
  });
});
