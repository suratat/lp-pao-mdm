const request = require('supertest');
const { buildIntegrationHarness, loginAsDpo, DPO_CONSOLE_CLIENT_ID } = require('./testHarness');

describe('DPO Console auth flow ผ่าน Keycloak (integration, mock Keycloak token endpoint)', () => {
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
    const agent = request.agent(harness.dpoConsoleApp);
    const { location } = await startLogin(agent);
    expect(location.pathname).toBe('/protocol/openid-connect/auth');
    expect(location.searchParams.get('client_id')).toBe(DPO_CONSOLE_CLIENT_ID);
    expect(location.searchParams.get('scope')).toContain('audit:read');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  test('login สำเร็จ (role dpo): สร้าง session แล้วเข้า /dpo/access-logs ได้จริง', async () => {
    const agent = request.agent(harness.dpoConsoleApp);
    const { state } = await startLogin(agent);

    const callback = await agent.get('/auth/callback').query({ code: 'good-dpo-code', state });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/dpo/access-logs');
    expect(callback.headers['set-cookie']).toBeDefined();

    const list = await agent.get('/dpo/access-logs');
    expect(list.status).toBe(200);
    expect(list.text).toContain('DPO หนึ่ง');
  });

  test('login สำเร็จ (role auditor): ก็เข้าได้เหมือนกัน (audit:read มีทั้ง dpo และ auditor)', async () => {
    const agent = request.agent(harness.dpoConsoleApp);
    const { state } = await startLogin(agent);

    const callback = await agent.get('/auth/callback').query({ code: 'good-auditor-code', state });
    expect(callback.status).toBe(302);

    const list = await agent.get('/dpo/access-logs');
    expect(list.status).toBe(200);
    expect(list.text).toContain('ผู้ตรวจสอบหนึ่ง');
  });

  test('login: ไม่มี realm role dpo/auditor -> 403 และไม่สร้าง session', async () => {
    const agent = request.agent(harness.dpoConsoleApp);
    const { state } = await startLogin(agent);

    const callback = await agent.get('/auth/callback').query({ code: 'no-role-code', state });
    expect(callback.status).toBe(403);
    expect(callback.text).toContain('dpo');
    expect((callback.headers['set-cookie'] || []).some((c) => c.startsWith('dpo_console_sid='))).toBe(false);

    const list = await agent.get('/dpo/access-logs');
    expect(list.status).toBe(302);
    expect(list.headers.location).toBe('/auth/login');
  });

  test('callback: state ไม่ตรงกับที่ตั้งไว้ตอน login -> 400 กัน CSRF', async () => {
    const agent = request.agent(harness.dpoConsoleApp);
    await startLogin(agent);

    const res = await agent.get('/auth/callback').query({ code: 'good-dpo-code', state: 'wrong-state-value' });
    expect(res.status).toBe(400);
    expect((res.headers['set-cookie'] || []).some((c) => c.startsWith('dpo_console_sid='))).toBe(false);
  });

  test('callback: ไม่มี code -> 400 ไม่ crash', async () => {
    const agent = request.agent(harness.dpoConsoleApp);
    const { state } = await startLogin(agent);
    const res = await agent.get('/auth/callback').query({ state });
    expect(res.status).toBe(400);
  });

  test('callback: Keycloak ไม่ส่ง id_token กลับมา -> 502 อธิบายให้ตรวจ scope openid', async () => {
    const agent = request.agent(harness.dpoConsoleApp);
    const { state } = await startLogin(agent);
    const res = await agent.get('/auth/callback').query({ code: 'no-id-token-code', state });
    expect(res.status).toBe(502);
  });

  test('ยังไม่ล็อกอิน -> เข้า /dpo/* ถูก redirect ไป /auth/login เสมอ', async () => {
    const res = await request(harness.dpoConsoleApp).get('/dpo/access-logs');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('access token ใกล้หมดอายุ -> silent refresh อัตโนมัติผ่าน refresh_token ไม่ต้อง login ใหม่', async () => {
    const agent = await loginAsDpo(harness.dpoConsoleApp, 'short-lived-code');

    // expiresIn=1s < REFRESH_BUFFER_MS (15s) ของ authGate เสมอ -> request แรกหลัง login ต้อง refresh ทันที
    const res = await agent.get('/dpo/access-logs');
    expect(res.status).toBe(200);
    // token ใหม่อยู่ใน sessionStore ฝั่งเซิร์ฟเวอร์ - ไม่ต้องส่ง Set-Cookie อะไรกลับไปเลย (cookie คือ session id เดิม)
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('access token หมดอายุและไม่มี refresh_token -> redirect ไป login', async () => {
    const agent = await loginAsDpo(harness.dpoConsoleApp, 'short-lived-no-refresh-code');
    const res = await agent.get('/dpo/access-logs');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('logout ล้าง session แล้ว redirect ไป Keycloak end-session endpoint', async () => {
    const agent = await loginAsDpo(harness.dpoConsoleApp);

    const res = await agent.get('/auth/logout');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).pathname).toBe('/protocol/openid-connect/logout');

    const afterLogout = await agent.get('/dpo/access-logs');
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.location).toBe('/auth/login');
  });
});
