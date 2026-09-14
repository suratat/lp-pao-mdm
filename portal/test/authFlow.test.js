const request = require('supertest');
const { createCheckAuthClient } = require('../src/security/checkAuthClient');
const { createMockCheckServer } = require('./mockCheckServer');
const { buildIntegrationHarness } = require('./testHarness');
const { FIXTURE_PERSON_ID } = require('../../api/test/fixtures');

const CLIENT_ID = 'mdm-portal-test';
const CLIENT_SECRET = 'test-check-client-secret';
const REDIRECT_URI = 'http://portal.test/auth/callback';

describe('checkAuthClient (unit, ไม่พึ่ง check-app จริง)', () => {
  let mockCheck;
  let baseUrl;

  beforeAll(async () => {
    mockCheck = createMockCheckServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, personIdForValidToken: FIXTURE_PERSON_ID });
    baseUrl = await mockCheck.listen();
  });

  afterAll(async () => {
    await mockCheck.close();
  });

  function client(overrides = {}) {
    return createCheckAuthClient({ baseUrl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, ...overrides });
  }

  test('buildLoginUrl ใส่ client_id และ redirect_uri ตาม contract', () => {
    const url = new URL(client().buildLoginUrl());
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  test('verifyToken: token ที่มี person_id -> ok พร้อม claims', async () => {
    const result = await client().verifyToken('valid-with-person');
    expect(result.ok).toBe(true);
    expect(result.claims.person_id).toBe(FIXTURE_PERSON_ID);
  });

  test('verifyToken: token ที่ scope ไม่พอ -> ok แต่ไม่มี person_id (field หายไปเฉย ๆ)', async () => {
    const result = await client().verifyToken('valid-no-person');
    expect(result.ok).toBe(true);
    expect(result.claims.person_id).toBeUndefined();
    expect('person_id' in result.claims).toBe(false);
  });

  test('verifyToken: token หมดอายุ/ใช้ไปแล้ว -> ok=false reason invalid_or_expired_token', async () => {
    const result = await client().verifyToken('expired');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.reason).toBe('invalid_or_expired_token');
  });

  test('verifyToken: client credential ผิด -> ok=false reason invalid_client', async () => {
    const result = await client({ clientSecret: 'wrong-secret' }).verifyToken('valid-with-person');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.reason).toBe('invalid_client');
  });

  test('verifyToken: response ไม่ใช่ JSON -> ok=false reason invalid_response ไม่ throw', async () => {
    const result = await client().verifyToken('malformed-response');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_response');
  });

  test('verifyToken: check ไม่ตอบสนอง (network error) -> ok=false reason upstream_unreachable ไม่ throw', async () => {
    const unreachable = createCheckAuthClient({
      baseUrl: 'http://127.0.0.1:1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    const result = await unreachable.verifyToken('valid-with-person');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream_unreachable');
  });
});

describe('Portal auth flow ผ่าน check.lp-pao.go.th (integration, mock check server)', () => {
  let mockCheck;
  let checkBaseUrl;
  let harness;

  beforeAll(async () => {
    mockCheck = createMockCheckServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, personIdForValidToken: FIXTURE_PERSON_ID });
    checkBaseUrl = await mockCheck.listen();

    const checkAuthClient = createCheckAuthClient({
      baseUrl: checkBaseUrl,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    harness = await buildIntegrationHarness({ checkAuthClient });
  });

  afterAll(async () => {
    await harness.close();
    await mockCheck.close();
  });

  test('GET /auth/login redirect ไป check จริงพร้อม client_id/redirect_uri', async () => {
    const res = await request(harness.portalApp).get('/auth/login');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin).toBe(checkBaseUrl);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  test('GET /auth/callback สำเร็จ: สร้าง session แล้วเข้า /portal/me ได้จริง', async () => {
    const agent = request.agent(harness.portalApp);

    const callback = await agent.get('/auth/callback').query({ token: 'valid-with-person' });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/portal/me');
    expect(callback.headers['set-cookie']).toBeDefined();

    const me = await agent.get('/portal/me');
    expect(me.status).toBe(200);
    expect(me.text).toContain('ทดสอบ');
  });

  test('GET /auth/callback ไม่มี token -> 400 ไม่ crash ไม่มี session', async () => {
    const res = await request(harness.portalApp).get('/auth/callback');
    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('GET /auth/callback: check ตอบสำเร็จแต่ไม่มี person_id -> 403 ข้อความแจ้งติดต่อ HR ไม่มี session', async () => {
    const res = await request(harness.portalApp).get('/auth/callback').query({ token: 'valid-no-person' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('ติดต่อฝ่ายบุคคล');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('GET /auth/callback: token หมดอายุ -> 401 ข้อความให้ล็อกอินใหม่ ไม่มี session', async () => {
    const res = await request(harness.portalApp).get('/auth/callback').query({ token: 'expired' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('หมดอายุ');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('response ของ error page ไม่มี client secret หรือ token หลุดออกมา', async () => {
    const res = await request(harness.portalApp).get('/auth/callback').query({ token: 'expired' });
    expect(res.text).not.toContain(CLIENT_SECRET);
    expect(res.text).not.toContain('expired');
  });
});

describe('Portal auth: ไม่ตั้งค่า check (checkAuthClient=null) fallback dev-login เดิมทุกประการ', () => {
  let harness;

  beforeAll(async () => {
    harness = await buildIntegrationHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  test('GET /auth/login ยังเป็นหน้า dev form เดิม, /auth/callback ตอบ 404', async () => {
    const login = await request(harness.portalApp).get('/auth/login');
    expect(login.status).toBe(200);
    expect(login.text).toContain('โหมดพัฒนา/ทดสอบเท่านั้น');

    const callback = await request(harness.portalApp).get('/auth/callback').query({ token: 'anything' });
    expect(callback.status).toBe(404);
  });
});
