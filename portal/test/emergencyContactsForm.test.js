const crypto = require('node:crypto');
const request = require('supertest');
const { buildIntegrationHarness } = require('./testHarness');

// เหตุการณ์บน prod หลัง PR-D1: ผู้ใช้แก้ผู้ติดต่อฉุกเฉินใน portal -> PUT /api/v1/me/emergency-contacts ได้ 200 body "[]" (2 ไบต์),
// GET /me ขนาดเท่าเดิม, ไม่มีแถวใหม่ใน data_change_log ทดสอบด้วยฟอร์มจริงของ portal -> API จริง (ไม่ mock MDM API)

let harness;

// หน้านี้ปิดตาม default (ดู consentsHidden/emergencyContactsHidden.test.js) - รันเฉพาะเมื่อเปิดด้วย env:
//   PORTAL_EMERGENCY_CONTACTS_ENABLED=true npm test
const describeEnabled = process.env.PORTAL_EMERGENCY_CONTACTS_ENABLED === 'true' ? describe : describe.skip;

// บุคคลใหม่ต่อเทสต์ (ไม่มีผู้ติดต่อฉุกเฉินเลย เหมือนผู้ใช้ในเหตุการณ์ที่ GET /me ไม่เปลี่ยนขนาด)
async function makePerson() {
  const personId = crypto.randomUUID();
  await harness.apiCtx.pool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  return personId;
}

async function login(personId) {
  const agent = request.agent(harness.portalApp);
  const res = await agent.post('/auth/dev-login').type('form').send({ personId });
  expect(res.status).toBe(302);
  return agent;
}

const db = (sql, params) => harness.apiCtx.pool.query(sql, params);
const stored = async (personId) =>
  (await db(`SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact WHERE person_id = $1 ORDER BY priority`, [personId])).rows;
const logCount = async (personId) =>
  Number((await db(`SELECT count(*)::int AS n FROM audit.data_change_log WHERE person_id = $1 AND table_name = 'emergency_contact'`, [personId])).rows[0].n);
const versionOf = async (personId) => (await db(`SELECT version FROM mdm.person WHERE person_id = $1`, [personId])).rows[0].version;

const post = (agent, fields) => agent.post('/portal/me/emergency-contacts').type('form').send(fields);

describeEnabled('ฟอร์มผู้ติดต่อฉุกเฉินของ portal', () => {
  beforeAll(async () => {
    harness = await buildIntegrationHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  test('เหตุการณ์ prod: กรอกชื่อ+เบอร์แต่ไม่กรอกความสัมพันธ์ -> ต้องไม่ "สำเร็จเงียบๆ" แต่แจ้งข้อผิดพลาด คงค่าที่พิมพ์ไว้ และไม่ส่งรายการว่างไปแทนที่ของเดิม', async () => {
    const personId = await makePerson();
    const agent = await login(personId);

    const res = await post(agent, { fullName_0: 'นางสมมติ ทดสอบ', phone_0: '0811112222' });

    // โค้ดเดิม: ตัดแถวที่ไม่ครบทิ้งเงียบๆ -> ส่ง [] ให้ API -> 200 "[]" -> redirect 302 โดยไม่มีข้อความอะไร ข้อมูลไม่ถูกบันทึก
    expect(res.status).toBe(422);
    expect(res.text).toContain('ความสัมพันธ์');
    expect(res.text).toContain('นางสมมติ ทดสอบ'); // ค่าที่พิมพ์ยังอยู่ในฟอร์ม
    expect(res.text).toContain('0811112222');
    expect(await stored(personId)).toEqual([]);
    expect(await logCount(personId)).toBe(0);
  });

  test('แถวหนึ่งครบอีกแถวไม่ครบ -> ปฏิเสธทั้งหมด ไม่บันทึกแถวที่ครบบางส่วน (เดิมบันทึกเฉพาะแถวที่ครบแล้วบอกว่าสำเร็จ)', async () => {
    const personId = await makePerson();
    const agent = await login(personId);

    const res = await post(agent, {
      fullName_0: 'นายสมมติ หนึ่ง',
      relationship_0: 'บิดา',
      phone_0: '0811110001',
      fullName_1: 'นางสมมติ สอง',
      phone_1: '0811110002',
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ผู้ติดต่อ 2');
    expect(await stored(personId)).toEqual([]);
  });

  test('กรอกครบ: บันทึกจริง (ลง data_change_log แบบไม่เก็บค่า, version เพิ่ม) และหน้าแสดงจำนวนที่ API ยืนยันว่าบันทึก', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const before = await versionOf(personId);

    const res = await post(agent, {
      fullName_0: 'นายสมมติ หนึ่ง',
      relationship_0: 'บิดา',
      phone_0: '0811110001',
      fullName_2: 'นางสมมติ สาม',
      relationship_2: 'มารดา',
      phone_2: '0811110003',
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/portal/me/emergency-contacts?saved=2');

    expect(await stored(personId)).toEqual([
      { full_name: 'นายสมมติ หนึ่ง', relationship: 'บิดา', phone: '0811110001', priority: 1 },
      { full_name: 'นางสมมติ สาม', relationship: 'มารดา', phone: '0811110003', priority: 3 },
    ]);
    expect(await logCount(personId)).toBe(6);
    expect(await versionOf(personId)).toBe(before + 1);

    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('บันทึกแล้ว 2 คน');
    expect(page.text).toContain('นายสมมติ หนึ่ง');
    expect(page.text).toContain('นางสมมติ สาม');
  });

  test('ส่งค่าเดิมซ้ำ -> ยังแจ้งว่าบันทึกแล้ว แต่ไม่มี log/version เพิ่ม; แก้เฉพาะเบอร์ -> log เดียว', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const form = { fullName_0: 'นายสมมติ หนึ่ง', relationship_0: 'บิดา', phone_0: '0811110001' };
    expect((await post(agent, form)).status).toBe(303);
    const afterFirst = { logs: await logCount(personId), version: await versionOf(personId) };

    const same = await post(agent, form);
    expect(same.status).toBe(303);
    expect({ logs: await logCount(personId), version: await versionOf(personId) }).toEqual(afterFirst);

    expect((await post(agent, { ...form, phone_0: '0899990001' })).status).toBe(303);
    expect(await logCount(personId)).toBe(afterFirst.logs + 1);
    expect((await stored(personId))[0].phone).toBe('0899990001');
  });

  test('ล้างทั้งสามช่องของแถวที่มีอยู่ = ลบผู้ติดต่อคนนั้น (ตั้งใจ) และหน้าแจ้ง "บันทึกแล้ว 0 คน"', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    await post(agent, { fullName_0: 'นายสมมติ หนึ่ง', relationship_0: 'บิดา', phone_0: '0811110001' });

    const res = await post(agent, {});
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/portal/me/emergency-contacts?saved=0');
    expect(await stored(personId)).toEqual([]);
    expect((await agent.get(res.headers.location)).text).toContain('บันทึกแล้ว 0 คน');
  });

  test('ค่ายาวเกินคอลัมน์ใน DB (ชื่อ 200 / ความสัมพันธ์ 50 / เบอร์ 20) -> 422 จาก portal ไม่ใช่ 500 และไม่บันทึก', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const base = { fullName_0: 'นายสมมติ หนึ่ง', relationship_0: 'บิดา', phone_0: '0811110001' };
    for (const over of [{ phone_0: '0'.repeat(21) }, { relationship_0: 'ก'.repeat(51) }, { fullName_0: 'ก'.repeat(201) }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(agent, { ...base, ...over });
      expect(res.status).toBe(422);
    }
    expect(await stored(personId)).toEqual([]);
  });

  test('ช่องว่างหัวท้ายถูกตัด; ช่องที่มีแต่ช่องว่างนับเป็นว่าง', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const res = await post(agent, {
      fullName_0: '  นายสมมติ หนึ่ง  ',
      relationship_0: ' บิดา ',
      phone_0: ' 0811110001 ',
      fullName_1: '   ',
      relationship_1: '  ',
      phone_1: ' ',
    });
    expect(res.status).toBe(303);
    expect(await stored(personId)).toEqual([{ full_name: 'นายสมมติ หนึ่ง', relationship: 'บิดา', phone: '0811110001', priority: 1 }]);
  });

  test('ข้อความผิดพลาดและฟอร์มที่แสดงกลับไม่ทำให้ HTML แตก (escape ค่าที่ผู้ใช้พิมพ์)', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const res = await post(agent, { fullName_0: '"><script>alert(1)</script>', phone_0: '0811110001' });
    expect(res.status).toBe(422);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  test('saved ใน query ต้องเป็นตัวเลข 0-3 เท่านั้น (ไม่สะท้อนข้อความอื่นลงหน้า)', async () => {
    const personId = await makePerson();
    const agent = await login(personId);
    const res = await agent.get('/portal/me/emergency-contacts?saved=<b>x</b>');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<b>x</b>');
    expect(res.text).not.toContain('บันทึกแล้ว');
  });
});
