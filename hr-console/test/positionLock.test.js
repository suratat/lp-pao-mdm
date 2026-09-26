const crypto = require('node:crypto');
const vm = require('node:vm');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { insertFixtureOrgUnit } = require('../../api/test/fixtures');
const { POSITION_RULES: API_RULES } = require('../../api/src/services/personnelPositionRules');
const { PERSONNEL_TYPES, positionRuleFor } = require('../src/personnelTypes');

// ฟอร์ม approve claim: ช่อง "เลขที่ตำแหน่ง" lock ตามประเภทบุคลากร (พนักงานจ้าง/จ้างเหมา/ฝ่ายการเมือง = ห้ามมี, ข้าราชการ/ครู/
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
  test('ช่องเลขที่ตำแหน่งเป็น text (positionNo) ไม่ใช่ UUID, มี pattern + กฎครบทุกประเภทฝังใน select, ไม่มีช่อง positionId เหลือ', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const res = await agent.get(`/hr/claim-requests/${await makeClaim()}/approve`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<input name="positionNo" id="positionNo"/);
    expect(res.text).not.toContain('name="positionId"');
    const rules = JSON.parse(res.text.match(/data-position-rules="([^"]*)"/)[1].replace(/&quot;/g, '"'));
    expect(rules).toEqual(API_RULES);
    const pattern = res.text.match(/<input name="positionNo"[\s\S]*?pattern="([^"]*)"/)[1];
    expect(() => new RegExp(pattern, 'v')).not.toThrow();
    for (const ok of ['1', '50', '123', '9999', '52-1-07-3106-003']) expect([ok, new RegExp(pattern).test(ok)]).toEqual([ok, true]);
  });
});

// รัน "สคริปต์ inline จริง" จากหน้าที่ render ใน sandbox ด้วย DOM จำลองแบบเรียบง่าย (ไม่มี jsdom ในรายการ dependency) - พิสูจน์ logic
// การ lock/unlock ตอนโหลด, ตอนเปลี่ยน dropdown และตอน pageshow (คืนค่าฟอร์มเมื่อกด Back)
async function loadFormScript() {
  const agent = await loginAsHrOfficer(harness.hrConsoleApp);
  const html = (await agent.get(`/hr/claim-requests/${await makeClaim()}/approve`)).text;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const rulesAttr = html.match(/data-position-rules="([^"]*)"/)[1].replace(/&quot;/g, '"');
  const patternAttr = html.match(/data-pattern="([^"]*)"/)[1];
  const messageAttr = html.match(/data-pattern-message="([^"]*)"/)[1];

  const makeEl = (attrs = {}) => {
    const handlers = {};
    return {
      attrs, handlers, value: '', disabled: false, required: false, textContent: '', validity: '',
      getAttribute(n) { return this.attrs[n]; },
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      setCustomValidity(m) { this.validity = m; },
      fire(type) { (handlers[type] || []).forEach((fn) => fn()); },
    };
  };
  const select = makeEl({ 'data-position-rules': rulesAttr });
  select.value = 'CIVIL_SERVANT'; // ค่าเริ่มต้นของ dropdown = ตัวแรก (ข้าราชการ)
  const input = makeEl({ 'data-pattern': patternAttr.replace(/&amp;/g, '&'), 'data-pattern-message': messageAttr });
  const hint = makeEl();
  const win = makeEl();
  const doc = { getElementById: (id) => ({ personnelType: select, positionNo: input, positionNoHint: hint })[id] };
  vm.runInNewContext(script, { document: doc, window: win, RegExp, JSON });
  return { select, input, hint, win };
}

describe('สคริปต์ lock ช่องเลขที่ตำแหน่ง (รัน script จริง ใน DOM จำลอง)', () => {
  test('ตอนโหลดหน้า (ค่าเริ่มต้น = ข้าราชการ): ช่อง enable + required', async () => {
    const { input, hint } = await loadFormScript();
    expect([input.disabled, input.required]).toEqual([false, true]);
    expect(hint.textContent).toContain('จำเป็นต้องระบุ');
  });

  test.each(FORBIDDEN)('เลือก %s: ล้างค่า + disable + ไม่ required', async (type) => {
    const { select, input, hint } = await loadFormScript();
    input.value = '12345';
    select.value = type;
    select.fire('change');
    expect([input.value, input.disabled, input.required, input.validity]).toEqual(['', true, false, '']);
    expect(hint.textContent).toContain('ไม่มีเลขที่ตำแหน่ง');
  });

  test.each(REQUIRED)('เลือก %s: enable + required และรับ input ได้', async (type) => {
    const { select, input } = await loadFormScript();
    select.value = 'GENERAL_EMPLOYEE';
    select.fire('change'); // ปิดก่อน แล้วเปลี่ยนกลับ - ต้องเปิดกลับได้
    select.value = type;
    select.fire('change');
    expect([input.disabled, input.required]).toEqual([false, true]);
    input.value = '123';
    input.fire('input');
    expect(input.validity).toBe('');
  });

  test('OTHER: enable แต่ไม่ required', async () => {
    const { select, input } = await loadFormScript();
    select.value = 'OTHER';
    select.fire('change');
    expect([input.disabled, input.required]).toEqual([false, false]);
  });

  test('เลขลำดับ 1-4 หลักผ่าน pattern, รูปแบบผิดได้ข้อความ error (setCustomValidity), ช่องว่างหัวท้ายถูกตัดตอน blur', async () => {
    const { select, input } = await loadFormScript();
    select.value = 'PERMANENT_EMPLOYEE';
    select.fire('change');
    for (const ok of ['7', '50', '123', '9999']) {
      input.value = ok;
      input.fire('input');
      expect([ok, input.validity]).toEqual([ok, '']);
    }
    for (const bad of ['12345', 'abc', '12a']) {
      input.value = bad;
      input.fire('input');
      expect(input.validity).toContain('รูปแบบเลขที่ตำแหน่งไม่ถูกต้อง');
    }
    input.value = '  123  ';
    input.fire('blur');
    expect([input.value, input.validity]).toEqual(['123', '']);
  });

  test('pageshow (กด Back แล้วเบราว์เซอร์คืนค่าฟอร์มเดิมโดยไม่ยิง change): สถานะช่องต้องกลับมาตรงกับประเภทที่เลือกอยู่', async () => {
    const { select, input, win } = await loadFormScript();
    select.value = 'GENERAL_EMPLOYEE'; // เบราว์เซอร์คืนค่า select แต่ช่องยัง enable + มีค่าเก่าค้าง
    input.disabled = false;
    input.value = '999';
    win.fire('pageshow');
    expect([input.value, input.disabled, input.required]).toEqual(['', true, false]);

    select.value = 'TEACHER';
    input.disabled = true; // สภาพตรงข้าม: คืนค่า select เป็นประเภทที่ต้องมี แต่ช่องค้าง disabled
    win.fire('pageshow');
    expect([input.disabled, input.required]).toEqual([false, true]);
  });
});

describe('ตรวจซ้ำที่ server (ข้าม client ผ่าน devtools/curl): ไม่เรียก API และไม่เปลี่ยน claim', () => {
  test.each(FORBIDDEN)('%s + ส่ง positionNo มา -> 422 และ claim ยังรอ HR', async (type) => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const position = await makePosition();
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: type, positionNo: position.no });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ห้ามระบุเลขที่ตำแหน่ง');
    expect(await claimStatus(claimId)).toBe('PENDING_HR');
  });

  test.each(REQUIRED)('%s + ไม่ส่ง positionNo -> 422 และ claim ยังรอ HR', async (type) => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: type });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ต้องระบุเลขที่ตำแหน่ง');
    expect(await claimStatus(claimId)).toBe('PENDING_HR');
  });

  test('เลขที่ตำแหน่งที่ไม่มีอยู่ / ตำแหน่งที่ปิดใช้งานแล้ว -> 422 "ไม่พบเลขที่ตำแหน่ง" (ไม่ใช่ 500)', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const inactive = await makePosition({ isActive: false });
    for (const no of ['99999', inactive.no]) {
      const claimId = await makeClaim();
      // eslint-disable-next-line no-await-in-loop
      const res = await approve(agent, claimId, { personnelType: 'PERMANENT_EMPLOYEE', positionNo: no });
      expect(res.status).toBe(422);
      expect(res.text).toContain('ไม่พบเลขที่ตำแหน่ง');
      // eslint-disable-next-line no-await-in-loop
      expect(await claimStatus(claimId)).toBe('PENDING_HR');
    }
  });
});

describe('บันทึกผ่านจริง', () => {
  test('ลูกจ้างประจำ + เลขที่ตำแหน่งเป็นเลขลำดับ (3-4 หลัก) -> บันทึกผ่าน และ employment ผูกตำแหน่งนั้นจริง', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const position = await makePosition();
    expect(position.no).toMatch(/^\d{4}$/);
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: 'PERMANENT_EMPLOYEE', positionNo: position.no });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/hr/claim-requests?resolved=approved');
    const { rows } = await adminPool.query(
      `SELECT e.personnel_type, e.position_id FROM mdm.claim_request c JOIN mdm.employment e ON e.person_id = c.resolved_person_id
       WHERE c.claim_request_id = $1`,
      [claimId]
    );
    expect(rows).toEqual([{ personnel_type: 'PERMANENT_EMPLOYEE', position_id: position.id }]);
  });

  test.each(FORBIDDEN)('%s ไม่มีเลขที่ตำแหน่ง -> บันทึกผ่าน และ position_id เป็น NULL', async (type) => {
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

  test('OTHER: มีหรือไม่มีเลขที่ตำแหน่งก็ผ่าน', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    expect((await approve(agent, await makeClaim(), { personnelType: 'OTHER' })).status).toBe(302);
    const position = await makePosition();
    expect((await approve(agent, await makeClaim(), { personnelType: 'OTHER', positionNo: position.no })).status).toBe(302);
  });
});
