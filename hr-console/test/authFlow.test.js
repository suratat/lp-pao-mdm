const request = require('supertest');
const { buildIntegrationHarness, loginAsHrOfficer, HR_CONSOLE_CLIENT_ID } = require('./testHarness');

describe('HR Console auth flow ผ่าน Keycloak (integration, mock Keycloak token endpoint)', () => {
  let harness;

  beforeAll(async () => {
    harness = await buildIntegrationHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function startLogin(agent) {
    const res = await agent.get('/auth/login');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    const state = location.searchParams.get('state');
    return { location, state };
  }

  test('GET /auth/login redirect ไป Keycloak พร้อม client_id/scope/state', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    const { location } = await startLogin(agent);
    expect(location.pathname).toBe('/protocol/openid-connect/auth');
    expect(location.searchParams.get('client_id')).toBe(HR_CONSOLE_CLIENT_ID);
    expect(location.searchParams.get('scope')).toContain('personnel:provision');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  test('login สำเร็จ (role hr_officer): สร้าง session แล้วเข้า /hr/claim-requests ได้จริง', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    const { state } = await startLogin(agent);

    const callback = await agent.get('/auth/callback').query({ code: 'good-code', state });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/hr/claim-requests');
    expect(callback.headers['set-cookie']).toBeDefined();

    const list = await agent.get('/hr/claim-requests');
    expect(list.status).toBe(200);
    expect(list.text).toContain('เจ้าหน้าที่ ก.');
  });

  test('login: ไม่มี realm role hr_officer -> 403 และไม่สร้าง session', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    const { state } = await startLogin(agent);

    const callback = await agent.get('/auth/callback').query({ code: 'no-role-code', state });
    expect(callback.status).toBe(403);
    expect(callback.text).toContain('hr_officer');
    // Set-Cookie อาจมี (แค่ล้าง state cookie ของ oauth flow เอง) แต่ต้องไม่มี hr_console_session ใหม่
    expect((callback.headers['set-cookie'] || []).some((c) => c.startsWith('hr_console_session='))).toBe(false);

    const list = await agent.get('/hr/claim-requests');
    expect(list.status).toBe(302);
    expect(list.headers.location).toBe('/auth/login');
  });

  test('callback: state ไม่ตรงกับที่ตั้งไว้ตอน login -> 400 กัน CSRF', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    await startLogin(agent);

    const res = await agent.get('/auth/callback').query({ code: 'good-code', state: 'wrong-state-value' });
    expect(res.status).toBe(400);
    expect((res.headers['set-cookie'] || []).some((c) => c.startsWith('hr_console_session='))).toBe(false);
  });

  test('callback: ไม่มี code -> 400 ไม่ crash', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    const { state } = await startLogin(agent);
    const res = await agent.get('/auth/callback').query({ state });
    expect(res.status).toBe(400);
  });

  test('callback: Keycloak ไม่ส่ง id_token กลับมา -> 502 อธิบายให้ตรวจ scope openid', async () => {
    const agent = request.agent(harness.hrConsoleApp);
    const { state } = await startLogin(agent);
    const res = await agent.get('/auth/callback').query({ code: 'no-id-token-code', state });
    expect(res.status).toBe(502);
  });

  test('ยังไม่ล็อกอิน -> เข้า /hr/* ถูก redirect ไป /auth/login เสมอ', async () => {
    const res = await request(harness.hrConsoleApp).get('/hr/claim-requests');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');

    const res2 = await request(harness.hrConsoleApp).get('/hr/reverify');
    expect(res2.status).toBe(302);
    expect(res2.headers.location).toBe('/auth/login');
  });

  test('access token ใกล้หมดอายุ -> silent refresh อัตโนมัติผ่าน refresh_token ไม่ต้อง login ใหม่', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'short-lived-code');

    // expiresIn=1s < REFRESH_BUFFER_MS (15s) ของ authGate เสมอ -> request แรกหลัง login ต้อง refresh ทันที
    const res = await agent.get('/hr/claim-requests');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined(); // authGate ต้อง set session cookie ใหม่หลัง refresh
  });

  test('access token หมดอายุและไม่มี refresh_token -> redirect ไป login', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp, 'short-lived-no-refresh-code');
    const res = await agent.get('/hr/claim-requests');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('logout ล้าง session แล้ว redirect ไป Keycloak end-session endpoint', async () => {
    const agent = await loginAsHrOfficer(harness.hrConsoleApp);

    const res = await agent.get('/auth/logout');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).pathname).toBe('/protocol/openid-connect/logout');

    const afterLogout = await agent.get('/hr/claim-requests');
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.location).toBe('/auth/login');
  });
});
