const request = require('supertest');
const { buildIntegrationHarness } = require('./testHarness');
const { FIXTURE_PERSON_ID } = require('../../api/test/fixtures');

let harness;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('MDM Portal self-service (T9 รอบแรก)', () => {
  test('redirect ไป /auth/login เมื่อยังไม่ได้ล็อกอิน', async () => {
    const res = await request(harness.portalApp).get('/portal/me');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('flow เต็ม: dev-login -> ดูข้อมูลตนเอง -> แก้ไข contact -> อ่านค่ากลับตรง', async () => {
    const agent = request.agent(harness.portalApp);

    const login = await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/portal/me');

    const me = await agent.get('/portal/me');
    expect(me.status).toBe(200);
    expect(me.text).toContain('ทดสอบ');
    expect(me.text).toContain('EMP-0001');

    const contactForm = await agent.get('/portal/me/contact');
    expect(contactForm.status).toBe(200);
    expect(contactForm.text).toContain('0812345678');

    const update = await agent.post('/portal/me/contact').type('form').send({
      mobilePhone: '0899999999',
      emailPersonal: 'updated@example.com',
      fullText: 'ที่อยู่ใหม่สำหรับทดสอบ',
    });
    expect(update.status).toBe(302);

    const contactFormAfter = await agent.get('/portal/me/contact');
    expect(contactFormAfter.text).toContain('0899999999');
    expect(contactFormAfter.text).toContain('updated@example.com');
    expect(contactFormAfter.text).not.toContain('0812345678');
  });

  test('emergency contacts: แทนที่ทั้งชุดแล้วอ่านกลับตรง', async () => {
    const agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });

    const update = await agent.post('/portal/me/emergency-contacts').type('form').send({
      fullName_0: 'นายทดสอบ พอร์ทัล',
      relationship_0: 'พี่น้อง',
      phone_0: '0811112222',
    });
    expect(update.status).toBe(302);

    const page = await agent.get('/portal/me/emergency-contacts');
    expect(page.text).toContain('นายทดสอบ พอร์ทัล');
    expect(page.text).toContain('0811112222');
  });

  test('report-identity-issue: ส่งแล้วได้ 200 พร้อมข้อความรับแจ้ง', async () => {
    const agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });

    const res = await agent
      .post('/portal/me/report-identity-issue')
      .type('form')
      .send({ fieldKey: 'identity.reg_address_text', description: 'ที่อยู่ผิด' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('รับแจ้งแล้ว');
  });

  test('consents: grant แล้วเห็นสถานะ GRANTED, withdraw แล้วเห็น WITHDRAWN', async () => {
    const agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });

    const grant = await agent
      .post('/portal/me/consents/DIRECTORY_PUBLISH')
      .type('form')
      .send({ status: 'GRANTED', policyVersion: 'v1' });
    expect(grant.status).toBe(302);

    const afterGrant = await agent.get('/portal/me/consents');
    expect(afterGrant.text).toContain('GRANTED');

    const withdraw = await agent
      .post('/portal/me/consents/DIRECTORY_PUBLISH')
      .type('form')
      .send({ status: 'WITHDRAWN', policyVersion: 'v1' });
    expect(withdraw.status).toBe(302);

    const afterWithdraw = await agent.get('/portal/me/consents');
    expect(afterWithdraw.text).toContain('WITHDRAWN');
  });

  test('consents: 400 จาก MDM API ถูกส่งต่อมาแสดงผล เมื่อ purpose ไม่ใช้ฐาน consent', async () => {
    const agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });

    const res = await agent
      .post('/portal/me/consents/HR_ADMIN')
      .type('form')
      .send({ status: 'GRANTED', policyVersion: 'v1' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('ไม่ต้องขอและถอนไม่ได้');
  });

  test('logout แล้วเข้าหน้า self-service ไม่ได้อีก', async () => {
    const agent = request.agent(harness.portalApp);
    await agent.post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
    await agent.get('/auth/logout');
    const res = await agent.get('/portal/me');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('production mode: dev-login ปิดใช้งาน (404) และหน้า login ตอบ 501 ไม่ใช่ฟอร์มปลอม', async () => {
    const { createApp } = require('../src/app');
    const prodApp = createApp({ mdmClient: {}, sessionSecret: 'x', isProduction: true });

    const loginPage = await request(prodApp).get('/auth/login');
    expect(loginPage.status).toBe(501);

    const devLogin = await request(prodApp).post('/auth/dev-login').type('form').send({ personId: FIXTURE_PERSON_ID });
    expect(devLogin.status).toBe(404);
  });
});
