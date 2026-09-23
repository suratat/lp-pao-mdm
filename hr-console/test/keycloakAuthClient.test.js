const { createTestAuthContext } = require('../../api/test/testJwks');
const { createKeycloakAuthClient, randomState } = require('../src/security/keycloakAuthClient');
const { createIdTokenVerifier } = require('../src/security/idTokenVerifier');
const { createMockKeycloakServer } = require('./mockKeycloakServer');

const CLIENT_ID = 'hr-console-unit-test';
const CLIENT_SECRET = 'unit-test-secret';
const REDIRECT_URI = 'http://hr-console.test/auth/callback';

describe('keycloakAuthClient + idTokenVerifier (unit, ไม่พึ่ง Postgres/MDM API จริง)', () => {
  let auth;
  let mockKeycloak;
  let baseUrl;

  beforeAll(async () => {
    auth = await createTestAuthContext();
    mockKeycloak = createMockKeycloakServer({
      auth,
      hrConsoleClientId: CLIENT_ID,
      hrConsoleClientSecret: CLIENT_SECRET,
      scenarios: {
        'good-code': { roles: ['hr_officer'], displayName: 'HR หนึ่ง', username: 'hr.one', scope: 'personnel:provision' },
        'no-role-code': { roles: ['staff'], displayName: 'พนักงาน', username: 'staff.one', scope: 'personnel:self' },
      },
    });
    baseUrl = await mockKeycloak.listen();
  });

  afterAll(async () => {
    await mockKeycloak.close();
  });

  function authClient() {
    return createKeycloakAuthClient({
      authorizationUrl: `${baseUrl}/protocol/openid-connect/auth`,
      tokenUrl: `${baseUrl}/protocol/openid-connect/token`,
      logoutUrl: `${baseUrl}/protocol/openid-connect/logout`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      scope: 'openid personnel:provision',
    });
  }

  test('randomState สุ่มค่าไม่ซ้ำกัน', () => {
    expect(randomState()).not.toBe(randomState());
  });

  test('buildLoginUrl ใส่ response_type/client_id/redirect_uri/scope/state ตาม contract', () => {
    const url = new URL(authClient().buildLoginUrl('state-123'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('openid personnel:provision');
    expect(url.searchParams.get('state')).toBe('state-123');
  });

  test('exchangeCode: code ที่ถูกต้อง -> ได้ access_token/refresh_token/id_token', async () => {
    const result = await authClient().exchangeCode('good-code');
    expect(result.ok).toBe(true);
    expect(result.tokens.access_token).toBeTruthy();
    expect(result.tokens.refresh_token).toBeTruthy();
    expect(result.tokens.id_token).toBeTruthy();
  });

  test('exchangeCode: code ผิด -> ok=false ไม่ throw', async () => {
    const result = await authClient().exchangeCode('unknown-code');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  test('exchangeCode: client secret ผิด -> ok=false status 401', async () => {
    const client = createKeycloakAuthClient({
      authorizationUrl: `${baseUrl}/protocol/openid-connect/auth`,
      tokenUrl: `${baseUrl}/protocol/openid-connect/token`,
      clientId: CLIENT_ID,
      clientSecret: 'wrong-secret',
      redirectUri: REDIRECT_URI,
      scope: 'openid',
    });
    const result = await client.exchangeCode('good-code');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  test('exchangeCode: เชื่อมต่อ Keycloak ไม่ได้ -> ok=false reason upstream_unreachable ไม่ throw', async () => {
    const client = createKeycloakAuthClient({
      authorizationUrl: 'http://127.0.0.1:1/protocol/openid-connect/auth',
      tokenUrl: 'http://127.0.0.1:1/protocol/openid-connect/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      scope: 'openid',
    });
    const result = await client.exchangeCode('good-code');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('upstream_unreachable');
  });

  test('refreshTokens: refresh token ที่ออกจาก exchangeCode ใช้ขอ token ใหม่ได้', async () => {
    const first = await authClient().exchangeCode('good-code');
    const refreshed = await authClient().refreshTokens(first.tokens.refresh_token);
    expect(refreshed.ok).toBe(true);
    expect(refreshed.tokens.access_token).toBeTruthy();
  });

  test('buildLogoutUrl ใส่ id_token_hint/post_logout_redirect_uri เมื่อมี logoutUrl ตั้งไว้', () => {
    const url = new URL(authClient().buildLogoutUrl('id-token-value', 'http://hr-console.test/'));
    expect(url.pathname).toBe('/protocol/openid-connect/logout');
    expect(url.searchParams.get('id_token_hint')).toBe('id-token-value');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://hr-console.test/');
  });

  test('buildLogoutUrl คืน null เมื่อไม่ได้ตั้ง logoutUrl (KEYCLOAK_LOGOUT_URL ไม่บังคับ)', () => {
    const client = createKeycloakAuthClient({
      authorizationUrl: `${baseUrl}/protocol/openid-connect/auth`,
      tokenUrl: `${baseUrl}/protocol/openid-connect/token`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      scope: 'openid',
    });
    expect(client.buildLogoutUrl()).toBeNull();
  });

  describe('idTokenVerifier', () => {
    function verifier() {
      return createIdTokenVerifier({ jwks: auth.jwks, issuer: auth.issuer, audience: CLIENT_ID });
    }

    test('id_token ของผู้มี role hr_officer -> isHrOfficer=true พร้อม displayName', async () => {
      const { tokens } = await authClient().exchangeCode('good-code');
      const identity = await verifier()(tokens.id_token);
      expect(identity.isHrOfficer).toBe(true);
      expect(identity.displayName).toBe('HR หนึ่ง');
    });

    test('id_token ของผู้ไม่มี role hr_officer -> isHrOfficer=false', async () => {
      const { tokens } = await authClient().exchangeCode('no-role-code');
      const identity = await verifier()(tokens.id_token);
      expect(identity.isHrOfficer).toBe(false);
    });

    test('id_token ที่ aud ไม่ตรงกับ client id ของ hr-console -> ปฏิเสธ (throw)', async () => {
      const wrongAudienceVerifier = createIdTokenVerifier({ jwks: auth.jwks, issuer: auth.issuer, audience: 'someone-else' });
      const { tokens } = await authClient().exchangeCode('good-code');
      await expect(wrongAudienceVerifier(tokens.id_token)).rejects.toThrow();
    });
  });
});
