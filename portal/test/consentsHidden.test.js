const request = require('supertest');
const { buildIntegrationHarness } = require('./testHarness');
const { FIXTURE_PERSON_ID } = require('../../api/test/fixtures');

// หน้า "ความยินยอม" ถูกซ่อนตาม default เพราะ consent ยังไม่ถูกบังคับใช้จริง (ดู Status Log ใน CLAUDE.md)
// ไฟล์นี้ระบุ consentsEnabled ชัดเจนในแต่ละ harness จึงรันได้เสมอไม่ขึ้นกับ env

describe('Portal consents ปิด (default)', () => {
  let harness;
  let agent;

  beforeAll(async () => {
    harness = await buildIntegrationHarness({ consentsEnabled: false });
    agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
  });

  afterAll(async () => {
    await harness.close();
  });

  test('เมนูไม่มีลิงก์ความยินยอม ทุกหน้า (รวมหน้าข้อมูลของฉัน)', async () => {
    const res = await agent.get('/portal/me');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('/portal/me/consents');
    expect(res.text).not.toContain('ความยินยอม');
    expect(res.text).not.toContain('nav-consents');
    expect(res.text).toContain('/portal/me/contact');
  });

  test('GET /portal/me/consents -> 404', async () => {
    const res = await agent.get('/portal/me/consents');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('ความยินยอมการใช้ข้อมูล');
  });

  test('POST /portal/me/consents/DIRECTORY_PUBLISH -> 404 และไม่เขียน consent_record', async () => {
    const before = await harness.apiCtx.pool.query(`SELECT count(*)::int AS n FROM mdm.consent_record`);
    const res = await agent
      .post('/portal/me/consents/DIRECTORY_PUBLISH')
      .type('form')
      .send({ status: 'GRANTED', policyVersion: 'v1' });
    expect(res.status).toBe(404);
    const after = await harness.apiCtx.pool.query(`SELECT count(*)::int AS n FROM mdm.consent_record`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('ยังไม่ล็อกอิน: ยังถูกส่งไปหน้า login ตามเดิม (ไม่เผยว่ามี/ไม่มี route)', async () => {
    const res = await request(harness.portalApp).get('/portal/me/consents');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });
});

describe('Portal consents เปิด (PORTAL_CONSENTS_ENABLED=true)', () => {
  let harness;
  let agent;

  beforeAll(async () => {
    harness = await buildIntegrationHarness({ consentsEnabled: true });
    agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
  });

  afterAll(async () => {
    await harness.close();
  });

  test('เมนูมีลิงก์และหน้าตอบ 200', async () => {
    const me = await agent.get('/portal/me');
    expect(me.text).toContain('<a href="/portal/me/consents">ความยินยอม</a>');
    expect(me.text).not.toContain('nav-consents');
    const page = await agent.get('/portal/me/consents');
    expect(page.status).toBe(200);
  });
});
