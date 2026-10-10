const crypto = require('node:crypto');
const request = require('supertest');
const { buildIntegrationHarness } = require('./testHarness');

// หน้า "ผู้ติดต่อฉุกเฉิน" ของ portal ถูกซ่อนตาม default (ไม่ต้องการใช้งาน; HR Console ยังแก้ได้) ไฟล์นี้ระบุ flag
// ชัดเจนในแต่ละ harness จึงรันได้เสมอไม่ขึ้นกับ env

async function makePerson(harness) {
  const personId = crypto.randomUUID();
  await harness.apiCtx.pool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  return personId;
}

describe('Portal ผู้ติดต่อฉุกเฉิน ปิด (default)', () => {
  let harness;
  let agent;
  let personId;

  beforeAll(async () => {
    harness = await buildIntegrationHarness({ emergencyContactsEnabled: false });
    personId = await makePerson(harness);
    // ข้อมูลที่มีอยู่แล้วต้องคงอยู่ (ฝั่ง HR แก้ได้) - ใส่ตรง ๆ ใน DB
    await harness.apiCtx.pool.query(
      `INSERT INTO mdm.emergency_contact (person_id, full_name, relationship, phone, priority) VALUES ($1, 'นางสมมติ เดิม', 'ญาติ', '0811112222', 1)`,
      [personId]
    );
    agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId });
  });

  afterAll(async () => {
    await harness.close();
  });

  const stored = async () =>
    (await harness.apiCtx.pool.query(`SELECT full_name, phone, priority FROM mdm.emergency_contact WHERE person_id = $1`, [personId])).rows;

  test('เมนูไม่มีลิงก์ผู้ติดต่อฉุกเฉิน และหน้าข้อมูลของฉันไม่แสดงผู้ติดต่อฉุกเฉิน', async () => {
    const res = await agent.get('/portal/me');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('/portal/me/emergency-contacts');
    expect(res.text).not.toContain('ผู้ติดต่อฉุกเฉิน');
    expect(res.text).not.toContain('nav-emergency-contacts');
    expect(res.text).not.toContain('นางสมมติ เดิม');
    expect(res.text).toContain('/portal/me/contact');
  });

  test('GET /portal/me/emergency-contacts -> 404 (ทั้งมี/ไม่มี ?saved=)', async () => {
    expect((await agent.get('/portal/me/emergency-contacts')).status).toBe(404);
    const withSaved = await agent.get('/portal/me/emergency-contacts?saved=2');
    expect(withSaved.status).toBe(404);
    expect(withSaved.text).not.toContain('บันทึกแล้ว');
  });

  test('POST -> 404 และไม่เขียนข้อมูล (ข้อมูลเดิมคงอยู่ ไม่มี data_change_log เพิ่ม)', async () => {
    const logs = () =>
      harness.apiCtx.pool
        .query(`SELECT count(*)::int AS n FROM audit.data_change_log WHERE person_id = $1 AND table_name = 'emergency_contact'`, [personId])
        .then((r) => r.rows[0].n);
    const logsBefore = await logs();
    const before = await stored();

    const res = await agent
      .post('/portal/me/emergency-contacts')
      .type('form')
      .send({ fullName_0: 'ไม่ควรถูกบันทึก', relationship_0: 'ทดสอบ', phone_0: '0899999999' });

    expect(res.status).toBe(404);
    expect(await stored()).toEqual(before);
    expect(await logs()).toBe(logsBefore);
  });

  test('ยังไม่ล็อกอิน: ถูกส่งไปหน้า login ตามเดิม', async () => {
    const res = await request(harness.portalApp).get('/portal/me/emergency-contacts');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });
});

describe('Portal ผู้ติดต่อฉุกเฉิน เปิด (PORTAL_EMERGENCY_CONTACTS_ENABLED=true)', () => {
  let harness;
  let agent;

  beforeAll(async () => {
    harness = await buildIntegrationHarness({ emergencyContactsEnabled: true });
    agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: await makePerson(harness) });
  });

  afterAll(async () => {
    await harness.close();
  });

  test('เมนูมีลิงก์และหน้าตอบ 200', async () => {
    const me = await agent.get('/portal/me');
    expect(me.text).toContain('<a href="/portal/me/emergency-contacts">ผู้ติดต่อฉุกเฉิน</a>');
    expect(me.text).not.toContain('nav-emergency-contacts');
    expect((await agent.get('/portal/me/emergency-contacts')).status).toBe(200);
  });
});
