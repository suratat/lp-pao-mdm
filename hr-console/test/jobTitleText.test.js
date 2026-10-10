const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { insertClaimWithFakePid, fakePidForClaim } = require('./claimHelpers');
const { loadApproveForm } = require('./approveFormDom');
const { PERSONNEL_TYPES, jobTitleAllowedFor } = require('../src/personnelTypes');
const { checkJobTitleText, normalizeJobTitleText, MAX_LENGTH } = require('../src/jobTitleText');
const api = require('../../api/src/services/jobTitleText');

// ฟอร์ม approve claim: ช่อง "ชื่อตำแหน่ง/ลักษณะงาน" (ข้อความอิสระ) - ใช้ได้กับประเภทที่ห้ามมีตำแหน่ง + OTHER เท่านั้น,
// OTHER เลือกได้อย่างใดอย่างหนึ่งระหว่างตำแหน่งกับข้อความ, server ของ console ตรวจซ้ำเสมอ
let harness;
let adminPool;
let orgUnitId;
let position; // { id, no } ตำแหน่ง active ใต้ orgUnitId
const suffix = crypto.randomUUID().slice(0, 8);
const FORBIDDEN = ['CONTRACT_EMPLOYEE', 'GENERAL_EMPLOYEE', 'EXPERT_EMPLOYEE', 'OUTSOURCE_INDIVIDUAL', 'POLITICAL_APPOINTEE'];
const REQUIRED = ['CIVIL_SERVANT', 'TEACHER', 'PERMANENT_EMPLOYEE', 'TRANSFERRED_HEALTH'];
const ALLOWED = [...FORBIDDEN, 'OTHER'];

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  const org = await adminPool.query(`INSERT INTO mdm.org_unit (code, name_th, unit_level) VALUES ($1, 'หน่วยงานทดสอบข้อความตำแหน่ง', 'DIVISION') RETURNING org_unit_id`, [`JT-${suffix}`]);
  orgUnitId = org.rows[0].org_unit_id;
  const pos = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, 'ตำแหน่งทดสอบข้อความ', 'GENERAL', $2) RETURNING position_id`,
    [`JT-${suffix}`, orgUnitId]
  );
  position = { id: pos.rows[0].position_id };
});

afterAll(async () => {
  // claim ที่ค้าง PENDING_HR จากเทสต์นี้ต้องไม่ไปดันรายการของเทสต์อื่นหลุดหน้าแรก (หน้ารายการดึงทีละ 50 รายการ)
  await adminPool.query(`UPDATE mdm.claim_request SET status = 'REJECTED' WHERE display_name = $1 AND status = 'PENDING_HR'`, ['นายทดสอบ ข้อความตำแหน่ง']);
  await harness.close();
  await adminPool.end();
});

// ตำแหน่งใหม่ต่อการบันทึกจริงแต่ละครั้ง - mdm.employment มี EXCLUDE กันตำแหน่งเดียวถูกครองพร้อมกันสองคน
async function freshPositionId() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id) VALUES ($1, 'ตำแหน่งทดสอบข้อความใหม่', 'GENERAL', $2) RETURNING position_id`,
    [`JT-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

async function makeClaim() {
  return insertClaimWithFakePid(adminPool, harness.apiCtx.vault, 'นายทดสอบ ข้อความตำแหน่ง');
}
const claimStatus = async (id) => (await adminPool.query('SELECT status FROM mdm.claim_request WHERE claim_request_id = $1', [id])).rows[0].status;

async function getForm() {
  const agent = await loginAsHrOfficer(harness.hrConsoleApp);
  const res = await agent.get(`/hr/claim-requests/${await makeClaim()}/approve`);
  expect(res.status).toBe(200);
  return { agent, html: res.text };
}
const approve = (agent, claimId, fields) =>
  agent.post(`/hr/claim-requests/${claimId}/approve`).type('form').send({ employeeNo: fakePidForClaim(claimId), orgUnitId, effectiveFrom: '2024-01-01', ...fields });

const savedRow = async (claimId) =>
  (
    await adminPool.query(
      `SELECT e.job_title_text, e.position_id FROM mdm.claim_request c JOIN mdm.employment e ON e.person_id = c.resolved_person_id WHERE c.claim_request_id = $1`,
      [claimId]
    )
  ).rows;

describe('กฎ hr-console = กฎ API (กัน drift)', () => {
  test('jobTitleAllowedFor ตรงกับ API ทุกประเภท และตรงสเปก (ห้ามมีตำแหน่ง + OTHER = ใช้ได้)', () => {
    for (const t of PERSONNEL_TYPES) expect([t.value, jobTitleAllowedFor(t.value)]).toEqual([t.value, api.jobTitleAllowedFor(t.value)]);
    for (const t of ALLOWED) expect(jobTitleAllowedFor(t)).toBe(true);
    for (const t of REQUIRED) expect(jobTitleAllowedFor(t)).toBe(false);
    expect(MAX_LENGTH).toBe(api.MAX_LENGTH);
  });

  test('normalize/ตรวจเลขบัตร/ความยาว ให้ผลตรงกับ API ทุกตัวอย่าง', () => {
    const corpus = [
      'ช่างไฟฟ้า', '  ช่าง\r\nไฟฟ้า  ', '\u202Eช่าง\u200Bไฟฟ้า', '', '   ', '\u202E', 'ก'.repeat(255), 'ก'.repeat(256), '😀'.repeat(256),
      '1234567890123', '1-2345-67890-12-3', '1 2345 67890 12 3', '๑๒๓๔๕๖๗๘๙๐๑๒๓', '12345\u200B67890123', 'โทร 081-234-5678', '123456789012',
      'เลขที่ตำแหน่งเดิม 52-1-07-3106-003', 'ปี 2567 ระดับ 3',
    ];
    for (const text of corpus) {
      expect([text, normalizeJobTitleText(text)]).toEqual([text, api.normalizeJobTitleText(text)]);
      let apiResult;
      try {
        apiResult = { text: api.validateJobTitleText(text) };
      } catch (e) {
        apiResult = { error: e.code };
      }
      const mine = checkJobTitleText(text);
      expect([text, Boolean(mine.error)]).toEqual([text, Boolean(apiResult.error)]);
      if (!mine.error) expect(mine.text).toBe(apiResult.text);
    }
  });
});

describe('หน้าฟอร์ม approve: โครงสร้าง HTML', () => {
  test('มีช่อง jobTitleText (maxlength 255) ภายใน #jobTitleRow และไม่ผูกกับ positionId/positionNo', async () => {
    const { html } = await getForm();
    expect(html).toMatch(/<div id="jobTitleRow">/);
    expect(html).toMatch(/<input name="jobTitleText" id="jobTitleText" maxlength="255"/);
    expect(html).toMatch(/<select name="positionId" id="positionId">/);
    expect(html).not.toContain('name="positionNo"');
  });
});

describe('สคริปต์ของหน้า (รัน script จริง ใน DOM จำลอง)', () => {
  const load = async () => {
    const form = loadApproveForm((await getForm()).html);
    form.chooseOrg(orgUnitId);
    return form;
  };

  test.each(ALLOWED)('%s: ช่องข้อความ enable และมองเห็น', async (type) => {
    const form = await load();
    form.chooseType(type);
    expect([form.jobInput.disabled, form.jobRow.hidden]).toEqual([false, false]);
  });

  test.each(REQUIRED)('%s: ช่องข้อความถูกซ่อน+disable+ล้างค่า (แม้เคยพิมพ์ไว้ตอนเป็นประเภทอื่น)', async (type) => {
    const form = await load();
    form.chooseType('OTHER');
    form.typeJobTitle('พนักงานขับรถ');
    expect(form.jobInput.value).toBe('พนักงานขับรถ');
    form.chooseType(type);
    expect([form.jobInput.value, form.jobInput.disabled, form.jobRow.hidden]).toEqual(['', true, true]);
    form.chooseType('OTHER'); // เปลี่ยนกลับ: เปิดกลับได้ และค่าว่าง (ไม่คืนค่าเก่า)
    expect([form.jobInput.value, form.jobInput.disabled, form.jobRow.hidden]).toEqual(['', false, false]);
  });

  test.each(FORBIDDEN)('%s: ตำแหน่งถูกปิด+ล้างค่า ส่วนข้อความพิมพ์ได้ (ไม่ปิดตำแหน่ง/ข้อความซ้อนกัน)', async (type) => {
    const form = await load();
    form.choosePosition(position.id);
    form.chooseType(type);
    expect([form.posSelect.value, form.posSelect.disabled, form.jobInput.disabled]).toEqual(['', true, false]);
    form.typeJobTitle('ผู้ช่วยช่าง');
    expect([form.jobInput.value, form.jobInput.disabled, form.posSelect.disabled]).toEqual(['ผู้ช่วยช่าง', false, true]);
  });

  test('OTHER: ยังไม่กรอกอะไร -> ทั้งสองช่อง enable', async () => {
    const form = await load();
    form.chooseType('OTHER');
    expect([form.posSelect.disabled, form.jobInput.disabled]).toEqual([false, false]);
  });

  test('OTHER: พิมพ์ข้อความ -> ช่องตำแหน่งถูกปิด (ค่าว่าง); ลบข้อความ (เปลี่ยนใจ) -> เปิดกลับและเลือกตำแหน่งแทนได้', async () => {
    const form = await load();
    form.chooseType('OTHER');
    form.typeJobTitle('อาสาสมัคร');
    expect([form.posSelect.disabled, form.posSelect.value]).toEqual([true, '']);
    expect(form.hint.textContent).toContain('ปิดเพราะกรอกชื่อตำแหน่ง');
    form.typeJobTitle('   '); // ช่องว่างล้วน = ไม่ได้กรอก
    expect(form.posSelect.disabled).toBe(false);
    form.typeJobTitle('');
    form.choosePosition(position.id);
    expect([form.posSelect.value, form.jobInput.disabled, form.jobInput.value]).toEqual([position.id, true, '']);
  });

  test('OTHER: เลือกตำแหน่ง -> ช่องข้อความถูกปิดและล้างค่า; เลือก placeholder กลับ (เปลี่ยนใจ) -> เปิดกลับ', async () => {
    const form = await load();
    form.chooseType('OTHER');
    form.choosePosition(position.id);
    expect([form.jobInput.disabled, form.jobInput.value]).toEqual([true, '']);
    expect(form.jobHint.textContent).toContain('ปิดเพราะเลือกตำแหน่งแล้ว');
    form.choosePosition('');
    expect(form.jobInput.disabled).toBe(false);
    form.typeJobTitle('ที่ปรึกษา');
    expect([form.jobInput.value, form.posSelect.disabled]).toEqual(['ที่ปรึกษา', true]);
  });

  test('OTHER: เปลี่ยนหน่วยงานจนตำแหน่งที่เลือกหาย -> ตำแหน่งถูกล้างและช่องข้อความเปิดกลับ', async () => {
    const form = await load();
    form.chooseType('OTHER');
    form.choosePosition(position.id);
    expect(form.jobInput.disabled).toBe(true);
    form.chooseOrg('');
    expect(form.posSelect.value).toBe('');
    expect(form.jobInput.disabled).toBe(false);
  });

  test('pageshow (กด Back): คืนค่ามาทั้งตำแหน่งและข้อความใน OTHER -> ตำแหน่งชนะ ข้อความถูกล้าง', async () => {
    const form = await load();
    form.typeSelect.value = 'OTHER';
    form.posSelect.value = position.id;
    form.jobInput.value = 'ข้อความที่เบราว์เซอร์คืนมา';
    form.win.fire('pageshow');
    expect([form.posSelect.value, form.jobInput.value, form.jobInput.disabled]).toEqual([position.id, '', true]);
  });

  test('pageshow: คืนประเภทที่ต้องมีตำแหน่งแต่ช่องข้อความยังมีค่าค้าง/ไม่ถูกซ่อน -> ล้างและซ่อน; คืนประเภทที่ห้ามมีตำแหน่ง -> เปิดช่องข้อความ', async () => {
    const form = await load();
    form.typeSelect.value = 'TEACHER';
    form.jobInput.value = 'ค้างอยู่';
    form.jobInput.disabled = false;
    form.jobRow.hidden = false;
    form.win.fire('pageshow');
    expect([form.jobInput.value, form.jobInput.disabled, form.jobRow.hidden]).toEqual(['', true, true]);

    form.typeSelect.value = 'GENERAL_EMPLOYEE';
    form.jobInput.disabled = true;
    form.jobRow.hidden = true;
    form.win.fire('pageshow');
    expect([form.jobInput.disabled, form.jobRow.hidden]).toEqual([false, false]);
  });
});

describe('server ของ console ตรวจซ้ำ (ข้ามฟอร์มผ่าน devtools/curl): 422 และ claim ยังรอ HR', () => {
  const rejected = async (fields, message, notContain = []) => {
    const { agent } = await getForm();
    const claimId = await makeClaim();
    const spy = jest.spyOn(harness.mdmClient, 'resolveClaimRequest');
    const res = await approve(agent, claimId, fields);
    expect(spy).not.toHaveBeenCalled(); // ตรวจที่ console ก่อน ไม่เรียก MDM API เลย
    spy.mockRestore();
    expect(res.status).toBe(422);
    expect(res.text).toContain(message);
    for (const text of notContain) expect(res.text).not.toContain(text);
    expect(await claimStatus(claimId)).toBe('PENDING_HR');
  };

  test.each(REQUIRED)('%s + ตำแหน่ง + ส่งข้อความ -> 422', async (type) => {
    await rejected({ personnelType: type, positionId: position.id, jobTitleText: 'ช่าง' }, 'ห้ามระบุชื่อตำแหน่ง/ลักษณะงานแบบข้อความ');
  });

  test('OTHER ส่งทั้งตำแหน่งและข้อความ -> 422', async () => {
    await rejected({ personnelType: 'OTHER', positionId: position.id, jobTitleText: 'อาสา' }, 'ห้ามระบุทั้งสองอย่าง');
  });

  test('เลขบัตร 13 หลัก (ติดกัน/มีขีด/เว้นวรรค/เลขไทย) -> 422 และหน้า error ไม่ echo เลขนั้นกลับมา', async () => {
    const pid = makeFakePid();
    const dashed = `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
    const spaced = dashed.replace(/-/g, ' ');
    const thai = pid.replace(/\d/g, (d) => '๐๑๒๓๔๕๖๗๘๙'[Number(d)]);
    for (const text of [`ช่าง ${pid}`, dashed, spaced, thai]) {
      // eslint-disable-next-line no-await-in-loop
      await rejected({ personnelType: 'CONTRACT_EMPLOYEE', jobTitleText: text }, 'ห้ามมีเลขบัตรประชาชน 13 หลัก', [pid, dashed, spaced, thai]);
    }
  });

  test('ยาวเกิน 255 ตัวอักษร (ข้าม maxlength ของฟอร์ม) -> 422', async () => {
    await rejected({ personnelType: 'GENERAL_EMPLOYEE', jobTitleText: 'ก'.repeat(256) }, 'ยาวเกิน 255');
  });

  test('ผิดหลายข้อพร้อมกันแสดงครบ', async () => {
    const { agent } = await getForm();
    const res = await approve(agent, await makeClaim(), { personnelType: 'TEACHER', jobTitleText: 'ก'.repeat(300) });
    expect(res.status).toBe(422);
    for (const m of ['ต้องระบุเลขที่ตำแหน่ง', 'ยาวเกิน 255', 'ห้ามระบุชื่อตำแหน่ง/ลักษณะงานแบบข้อความ']) expect(res.text).toContain(m);
  });
});

describe('บันทึกผ่านจริง', () => {
  test('console ส่ง jobTitleText ที่ normalize แล้วไปที่ MDM API (ไม่ส่งข้อความดิบ) และไม่ส่งค่าถ้าว่าง', async () => {
    const { agent } = await getForm();
    const spy = jest.spyOn(harness.mdmClient, 'resolveClaimRequest');
    await approve(agent, await makeClaim(), { personnelType: 'GENERAL_EMPLOYEE', jobTitleText: '\u202E  ช่างไฟ\r\nฟ้า  ' });
    await approve(agent, await makeClaim(), { personnelType: 'GENERAL_EMPLOYEE', jobTitleText: '   ' });
    const sent = spy.mock.calls.map(([, , payload]) => payload.employment);
    spy.mockRestore();
    expect(sent[0].jobTitleText).toBe('ช่างไฟ ฟ้า');
    expect(sent[1].jobTitleText).toBeUndefined(); // undefined = ถูกตัดออกตอน JSON.stringify
    expect(sent[1].positionId).toBeUndefined();
  });

  test.each(FORBIDDEN)('%s + ข้อความ -> บันทึกผ่าน เก็บ job_title_text และ position_id เป็น NULL', async (type) => {
    const { agent } = await getForm();
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: type, jobTitleText: 'ผู้ช่วยช่างไฟฟ้า' });
    expect(res.status).toBe(302);
    expect(await savedRow(claimId)).toEqual([{ job_title_text: 'ผู้ช่วยช่างไฟฟ้า', position_id: null }]);
  });

  test('OTHER: ข้อความอย่างเดียว / ตำแหน่งอย่างเดียว / ไม่ใส่เลย ผ่านทั้งสามแบบ', async () => {
    const { agent } = await getForm();
    const a = await makeClaim();
    expect((await approve(agent, a, { personnelType: 'OTHER', jobTitleText: 'อาสาสมัคร' })).status).toBe(302);
    expect(await savedRow(a)).toEqual([{ job_title_text: 'อาสาสมัคร', position_id: null }]);

    const b = await makeClaim();
    const bPos = await freshPositionId();
    expect((await approve(agent, b, { personnelType: 'OTHER', positionId: bPos })).status).toBe(302);
    expect(await savedRow(b)).toEqual([{ job_title_text: null, position_id: bPos }]);

    const c = await makeClaim();
    expect((await approve(agent, c, { personnelType: 'OTHER' })).status).toBe(302);
    expect(await savedRow(c)).toEqual([{ job_title_text: null, position_id: null }]);
  });

  test('ข้อความถูก normalize ก่อนบันทึก (ตัด bidi/control, รวมบรรทัด, trim) และข้อความว่างล้วนถือว่าไม่ส่ง', async () => {
    const { agent } = await getForm();
    const a = await makeClaim();
    expect((await approve(agent, a, { personnelType: 'GENERAL_EMPLOYEE', jobTitleText: '\u202E  ช่างไฟ\r\nฟ้า\u0000  ' })).status).toBe(302);
    expect(await savedRow(a)).toEqual([{ job_title_text: 'ช่างไฟ ฟ้า', position_id: null }]);

    // ข้อความว่างล้วนในประเภทที่ต้องมีตำแหน่ง (ฟอร์มที่ซ่อนช่องแล้วส่งค่าว่างมา) ต้องไม่ถูกมองเป็นการส่งข้อความ
    const b = await makeClaim();
    const bPos = await freshPositionId();
    expect((await approve(agent, b, { personnelType: 'TEACHER', positionId: bPos, jobTitleText: '   ' })).status).toBe(302);
    expect(await savedRow(b)).toEqual([{ job_title_text: null, position_id: bPos }]);
  });
});

describe('การแสดงผล: XSS และข้อความยาว (หน้า reverify ของ hr-console)', () => {
  const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';

  async function makeStaleWithText(jobTitleText) {
    const personId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
       VALUES ($1, $2, 'ACTIVE', 'STALE', now() - interval '400 days', now() - interval '400 days', 1)`,
      [personId, crypto.randomBytes(32).toString('hex')]
    );
    await adminPool.query(
      `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, gender, synced_at)
       VALUES ($1, 'นาย', 'แสดงข้อความ', $2, 'M', now())`,
      [personId, `ตำแหน่ง${suffix}`]
    );
    // INSERT ตรง (ข้ามกฎของ API) เพื่อจำลองข้อมูลอันตราย/ยาวผิดปกติที่หลุดมาอยู่ใน DB
    await adminPool.query(
      `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, org_unit_id, effective_from, is_current, employment_status, updated_by, job_title_text)
       VALUES ($1, $2, 'GENERAL_EMPLOYEE', $3, CURRENT_DATE, true, 'ACTIVE', 'test', $4)`,
      [personId, `EMP-JT-${crypto.randomUUID()}`, orgUnitId, jobTitleText]
    );
    return personId;
  }

  test('ข้อความอันตราย (<script>, ") ถูก escape ทุกจุด ไม่ทะลุเป็น HTML จริง', async () => {
    await makeStaleWithText(XSS);
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const res = await agent.get('/hr/reverify');
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('<script>alert(1)');
    expect(res.text).not.toContain('<img src=x');
  });

  test('ข้อความยาว 255 ตัวอักษรไม่มีช่องว่างแสดงได้ครบ และทุกตารางของ layout มี overflow-wrap: anywhere', async () => {
    const long = 'ก'.repeat(255);
    await makeStaleWithText(long);
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);
    const res = await agent.get('/hr/reverify');
    expect(res.text).toContain(long);
    expect(res.text).toMatch(/td, th \{[^}]*overflow-wrap: anywhere;[^}]*\}/);
  });
});
