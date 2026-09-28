const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildIntegrationHarness, loginAsHrOfficer } = require('./testHarness');
const { MIGRATOR_DATABASE_URL } = require('../../api/test/config');
const { makeFakePid } = require('../../api/src/security/pid');
const { loadApproveForm, selectHtmlOf, parseOptions } = require('./approveFormDom');
const { orgUnitOptions, positionOptions } = require('../src/routes/claimRequestRoutes');

// ฟอร์ม approve claim: หน่วยงาน/ตำแหน่งเป็น dropdown (แทนช่องพิมพ์ UUID / เลขที่ตำแหน่ง) + ตำแหน่งกรองตามหน่วยงาน
// + server ของ console ตรวจซ้ำว่า orgUnitId/positionId มีอยู่จริง, active และตำแหน่งอยู่ในหน่วยงานที่เลือก
let harness;
let adminPool;
let orgA; // { id, code, name }
let orgB;
let orgInactive;
let orgEmpty; // หน่วยงาน active ที่ไม่มีตำแหน่ง active เลย
let posA1; // { id, no, title }
let posA2;
let posAInactive;
let posB1;
let typeNameAcademic;
let typeNameGeneral;

const suffix = crypto.randomUUID().slice(0, 8);

async function makeOrg(label, isActive = true) {
  const code = `DD-${label}-${suffix}`;
  const name = `หน่วยงานทดสอบ ${label} ${suffix}`;
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.org_unit (code, name_th, unit_level, is_active) VALUES ($1, $2, 'DIVISION', $3) RETURNING org_unit_id`,
    [code, name, isActive]
  );
  return { id: rows[0].org_unit_id, code, name };
}

async function makePos(orgId, no, title, type, { isActive = true, lineOfWork = null } = {}) {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, line_of_work, position_type, org_unit_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING position_id`,
    [no, title, lineOfWork, type, orgId, isActive]
  );
  return { id: rows[0].position_id, no, title };
}

beforeAll(async () => {
  harness = await buildIntegrationHarness();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  ({ rows: [{ name_th: typeNameAcademic }] } = await adminPool.query(`SELECT name_th FROM mdm.position_type WHERE code = 'ACADEMIC'`));
  ({ rows: [{ name_th: typeNameGeneral }] } = await adminPool.query(`SELECT name_th FROM mdm.position_type WHERE code = 'GENERAL'`));
  orgA = await makeOrg('A');
  orgB = await makeOrg('B');
  orgInactive = await makeOrg('X', false);
  orgEmpty = await makeOrg('E');
  posA1 = await makePos(orgA.id, `DD-A1-${suffix}`, 'นักวิชาการทดสอบ ก', 'ACADEMIC', { lineOfWork: `สายงานลับ-${suffix}` });
  posA2 = await makePos(orgA.id, `DD-A2-${suffix}`, 'เจ้าพนักงานทดสอบ ข', 'GENERAL');
  posAInactive = await makePos(orgA.id, `DD-A3-${suffix}`, 'ตำแหน่งที่ปิดแล้ว', 'GENERAL', { isActive: false });
  posB1 = await makePos(orgB.id, `DD-B1-${suffix}`, 'นักวิชาการทดสอบ ค', 'ACADEMIC');
});

afterAll(async () => {
  await harness.close();
  await adminPool.end();
});

async function makeClaim() {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
     VALUES ($1, 'นายทดสอบ ดรอปดาวน์', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
    [crypto.randomBytes(32).toString('hex')]
  );
  return rows[0].claim_request_id;
}

const claimStatus = async (id) => (await adminPool.query('SELECT status FROM mdm.claim_request WHERE claim_request_id = $1', [id])).rows[0].status;

async function getForm() {
  const agent = await loginAsHrOfficer(harness.hrConsoleApp);
  const res = await agent.get(`/hr/claim-requests/${await makeClaim()}/approve`);
  expect(res.status).toBe(200);
  return { agent, html: res.text };
}

const approve = (agent, claimId, fields) =>
  agent.post(`/hr/claim-requests/${claimId}/approve`).type('form').send({ employeeNo: makeFakePid(), effectiveFrom: '2024-01-01', ...fields });

describe('render รายการ', () => {
  test('หน่วยงานเป็น select ค่า = orgUnitId (UUID) แสดง "รหัส — ชื่อ" เฉพาะที่ active, ไม่มีช่องพิมพ์ UUID เหลือ', async () => {
    const { html } = await getForm();
    expect(html).toMatch(/<select name="orgUnitId" id="orgUnitId" required>/);
    expect(html).not.toMatch(/<input[^>]*name="orgUnitId"/);
    const options = parseOptions(selectHtmlOf(html, 'orgUnitId'));
    const byValue = new Map(options.map((o) => [o.value, o.textContent]));
    expect(byValue.get('')).toBe('— เลือกหน่วยงาน —');
    expect(byValue.get(orgA.id)).toBe(`${orgA.code} — ${orgA.name}`);
    expect(byValue.get(orgB.id)).toBe(`${orgB.code} — ${orgB.name}`);
    expect(byValue.has(orgInactive.id)).toBe(false);
  });

  test('ตำแหน่งเป็น select ค่า = positionId แสดง "เลขที่ — ชื่อ · ประเภท(ชื่อไทย)" เฉพาะที่ active, ไม่แสดงระดับ/สายงาน', async () => {
    const { html } = await getForm();
    expect(html).toMatch(/<select name="positionId" id="positionId">/);
    const options = parseOptions(selectHtmlOf(html, 'positionId'));
    const byValue = new Map(options.map((o) => [o.value, o]));
    expect(byValue.get(posA1.id).textContent).toBe(`${posA1.no} — ${posA1.title} · ${typeNameAcademic}`);
    expect(byValue.get(posA2.id).textContent).toBe(`${posA2.no} — ${posA2.title} · ${typeNameGeneral}`);
    expect(byValue.get(posB1.id).getAttribute('data-org-unit')).toBe(orgB.id);
    expect(byValue.get(posA1.id).getAttribute('data-org-unit')).toBe(orgA.id);
    expect(byValue.has(posAInactive.id)).toBe(false);
    expect(html).not.toContain(`สายงานลับ-${suffix}`); // line_of_work ไม่ถูกแสดงในฟอร์ม
  });

  test('ไม่มีคำว่า undefined ในหน้า (ชื่อประเภทตำแหน่งที่หาไม่เจอใช้ code แทน)', async () => {
    const { html } = await getForm();
    expect(html).not.toContain('undefined');
  });
});

describe('ตัวกรอง isActive ของ console (กันไว้อีกชั้น แม้ API ส่ง activeOnly=true มาแล้ว)', () => {
  test('orgUnitOptions ตัด inactive ออก + เรียงตามรหัส + escape HTML', () => {
    const html = orgUnitOptions([
      { orgUnitId: 'b', code: 'B2', nameTh: 'สอง <b>', isActive: true },
      { orgUnitId: 'a', code: 'A1', nameTh: 'หนึ่ง', isActive: true },
      { orgUnitId: 'x', code: 'X9', nameTh: 'ปิดแล้ว', isActive: false },
    ]);
    expect(html).not.toContain('ปิดแล้ว');
    expect(html.indexOf('A1')).toBeLessThan(html.indexOf('B2'));
    expect(html).toContain('สอง &lt;b&gt;');
  });

  test('positionOptions ตัด inactive ออก', () => {
    const html = positionOptions(
      [
        { positionId: 'p1', positionNo: '1', titleTh: 'เปิด', positionType: 'ACADEMIC', orgUnitId: 'o', isActive: true },
        { positionId: 'p2', positionNo: '2', titleTh: 'ปิดแล้ว', positionType: 'ACADEMIC', orgUnitId: 'o', isActive: false },
      ],
      [{ code: 'ACADEMIC', nameTh: 'วิชาการ' }]
    );
    expect(html).toContain('1 — เปิด · วิชาการ');
    expect(html).not.toContain('ปิดแล้ว');
  });
});

describe('กรองตำแหน่งตามหน่วยงาน (รัน script จริง ใน DOM จำลอง)', () => {
  test('ยังไม่เลือกหน่วยงาน: ไม่มีตำแหน่งให้เลือก + ช่อง disabled + placeholder บอกให้เลือกหน่วยงานก่อน', async () => {
    const form = loadApproveForm((await getForm()).html);
    expect(form.visiblePositions()).toEqual([]);
    expect(form.posSelect.disabled).toBe(true);
    expect(form.placeholderText()).toContain('เลือกหน่วยงานก่อน');
  });

  test('เลือกหน่วยงาน A: เห็นเฉพาะตำแหน่ง active ของ A; เปลี่ยนเป็น B: เห็นเฉพาะของ B', async () => {
    const form = loadApproveForm((await getForm()).html);
    form.chooseOrg(orgA.id);
    expect(form.visiblePositions().sort()).toEqual([posA1.id, posA2.id].sort());
    expect(form.posSelect.disabled).toBe(false);
    form.chooseOrg(orgB.id);
    expect(form.visiblePositions()).toEqual([posB1.id]);
    form.chooseOrg('');
    expect(form.visiblePositions()).toEqual([]);
  });

  test('เลือกตำแหน่งของ A แล้วเปลี่ยนเป็นหน่วยงาน B: ค่าที่เลือกถูกล้าง; เปลี่ยนแล้วกลับมา A ไม่ค้างค่าเก่า', async () => {
    const form = loadApproveForm((await getForm()).html);
    form.chooseOrg(orgA.id);
    form.posSelect.value = posA1.id;
    form.chooseOrg(orgB.id);
    expect(form.posSelect.value).toBe('');
    form.chooseOrg(orgA.id);
    expect(form.posSelect.value).toBe('');
  });

  test('หน่วยงานที่ไม่มีตำแหน่ง active: placeholder แจ้งว่าไม่มีตำแหน่ง', async () => {
    const form = loadApproveForm((await getForm()).html);
    form.chooseOrg(orgEmpty.id);
    expect(form.visiblePositions()).toEqual([]);
    expect(form.placeholderText()).toContain('ไม่มีตำแหน่งที่ใช้งานอยู่');
  });

  test('pageshow (กด Back): เบราว์เซอร์คืนหน่วยงาน+ตำแหน่งที่เลือกไว้ -> รายการตำแหน่งกรองตามหน่วยงานนั้นและค่ายังอยู่', async () => {
    const form = loadApproveForm((await getForm()).html);
    form.orgSelect.value = orgA.id; // คืนค่า select โดยไม่ยิง change
    form.win.fire('pageshow');
    expect(form.visiblePositions().sort()).toEqual([posA1.id, posA2.id].sort());
    form.posSelect.value = posA2.id;
    form.win.fire('pageshow');
    expect(form.posSelect.value).toBe(posA2.id);
  });

  test('lock ตามประเภทยังทำงานร่วมกับการกรอง: ประเภทที่ห้ามมีตำแหน่งล้างค่า+disable แม้เลือกหน่วยงานแล้ว, เปลี่ยนกลับแล้วรายการยังกรองตามหน่วยงาน', async () => {
    const form = loadApproveForm((await getForm()).html);
    form.chooseOrg(orgA.id);
    form.posSelect.value = posA1.id;
    form.chooseType('OUTSOURCE_INDIVIDUAL');
    expect([form.posSelect.value, form.posSelect.disabled, form.posSelect.required]).toEqual(['', true, false]);
    form.chooseType('TEACHER');
    expect([form.posSelect.disabled, form.posSelect.required]).toEqual([false, true]);
    expect(form.visiblePositions().sort()).toEqual([posA1.id, posA2.id].sort());
  });
});

describe('server ของ console ตรวจซ้ำ id ก่อนเรียก API (ข้าม client ผ่าน devtools/curl)', () => {
  const expectRejected = async (fields, message) => {
    const { agent } = await getForm();
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, fields);
    expect(res.status).toBe(422);
    expect(res.text).toContain(message);
    expect(await claimStatus(claimId)).toBe('PENDING_HR');
  };

  test('ไม่เลือกหน่วยงาน -> 422', async () => {
    await expectRejected({ personnelType: 'CONTRACT_EMPLOYEE' }, 'กรุณาเลือกหน่วยงาน');
  });

  test('orgUnitId ไม่ใช่ UUID -> 422', async () => {
    await expectRejected({ personnelType: 'CONTRACT_EMPLOYEE', orgUnitId: 'ไม่ใช่-uuid' }, 'หน่วยงานที่เลือกไม่ถูกต้อง');
  });

  test('orgUnitId ที่ไม่มีอยู่จริง -> 422', async () => {
    await expectRejected({ personnelType: 'CONTRACT_EMPLOYEE', orgUnitId: crypto.randomUUID() }, 'ไม่พบหน่วยงานที่เลือก');
  });

  test('orgUnitId ที่ปิดใช้งานแล้ว -> 422', async () => {
    await expectRejected({ personnelType: 'CONTRACT_EMPLOYEE', orgUnitId: orgInactive.id }, 'ไม่พบหน่วยงานที่เลือก');
  });

  test('positionId ไม่ใช่ UUID -> 422', async () => {
    await expectRejected({ personnelType: 'CIVIL_SERVANT', orgUnitId: orgA.id, positionId: 'DD-A1' }, 'ตำแหน่งที่เลือกไม่ถูกต้อง');
  });

  test('positionId ที่ไม่มีอยู่จริง -> 422', async () => {
    await expectRejected({ personnelType: 'CIVIL_SERVANT', orgUnitId: orgA.id, positionId: crypto.randomUUID() }, 'ไม่พบตำแหน่งที่เลือก');
  });

  test('positionId ที่ปิดใช้งานแล้ว -> 422', async () => {
    await expectRejected({ personnelType: 'CIVIL_SERVANT', orgUnitId: orgA.id, positionId: posAInactive.id }, 'ไม่พบตำแหน่งที่เลือก');
  });

  test('positionId มีจริงแต่อยู่คนละหน่วยงานกับที่เลือก -> 422 (MDM API เองไม่ตรวจข้อนี้ จึงต้องกันที่ console)', async () => {
    await expectRejected({ personnelType: 'CIVIL_SERVANT', orgUnitId: orgA.id, positionId: posB1.id }, 'ตำแหน่งที่เลือกไม่อยู่ในหน่วยงานที่เลือก');
  });

  test('ประเภทที่ห้ามมีตำแหน่ง + ส่ง positionId มา -> 422 (กฎ lock ยังทำงานที่ server)', async () => {
    await expectRejected({ personnelType: 'GENERAL_EMPLOYEE', orgUnitId: orgA.id, positionId: posA1.id }, 'ห้ามระบุเลขที่ตำแหน่ง');
  });

  test('หลายข้อผิดพลาดพร้อมกัน -> แสดงครบในหน้าเดียว', async () => {
    const { agent } = await getForm();
    const res = await approve(agent, await makeClaim(), { personnelType: 'CIVIL_SERVANT', orgUnitId: crypto.randomUUID() });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ต้องระบุเลขที่ตำแหน่ง');
    expect(res.text).toContain('ไม่พบหน่วยงานที่เลือก');
  });

  test('หน่วยงาน+ตำแหน่งถูกต้อง (ตำแหน่งอยู่ในหน่วยงานที่เลือก) -> บันทึกผ่าน และ employment ผูก org/position ตามที่เลือก', async () => {
    const { agent } = await getForm();
    const claimId = await makeClaim();
    const res = await approve(agent, claimId, { personnelType: 'CIVIL_SERVANT', orgUnitId: orgA.id, positionId: posA1.id });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/hr/claim-requests?resolved=approved');
    const { rows } = await adminPool.query(
      `SELECT e.org_unit_id, e.position_id FROM mdm.claim_request c JOIN mdm.employment e ON e.person_id = c.resolved_person_id WHERE c.claim_request_id = $1`,
      [claimId]
    );
    expect(rows).toEqual([{ org_unit_id: orgA.id, position_id: posA1.id }]);
  });

  test('ประเภทที่ไม่บังคับ/ห้ามมีตำแหน่ง + หน่วยงานถูกต้อง ไม่ส่งตำแหน่ง -> บันทึกผ่าน', async () => {
    const { agent } = await getForm();
    const res = await approve(agent, await makeClaim(), { personnelType: 'OUTSOURCE_INDIVIDUAL', orgUnitId: orgB.id });
    expect(res.status).toBe(302);
  });
});
