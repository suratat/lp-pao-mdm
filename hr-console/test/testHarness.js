const request = require('supertest');
const { buildTestApp } = require('../../api/test/testApp');
const { createApp: createHrConsoleApp } = require('../src/app');
const { createKeycloakAuthClient } = require('../src/security/keycloakAuthClient');
const { createIdTokenVerifier } = require('../src/security/idTokenVerifier');
const { createMdmClient } = require('../src/mdmClient');
const { createMockKeycloakServer } = require('./mockKeycloakServer');
const { createSessionStore } = require('../src/session/sessionStore');

const HR_CONSOLE_CLIENT_ID = 'hr-console-test';
const HR_CONSOLE_CLIENT_SECRET = 'hr-console-test-secret';
const REDIRECT_URI = 'http://hr-console.test/auth/callback';
const HR_SCOPE = 'openid personnel:provision personnel:write:employment personnel:import personnel:read:basic';
// T10: ใน Keycloak จริง scope นี้เป็น default client scope ของ hr-console จึงอยู่ใน token ของ hr_officer ทุกคน
const HR_SCOPE_WITH_MANAGE = `${HR_SCOPE} personnel:manage:reference`;

// role/scope ทั้งหมดที่มีใน realm จริง (อ่านจาก infra/keycloak/realm-export.json) - ใช้จำลองผู้ใช้ที่มีครบทุกอย่าง
const REALM_EXPORT = require('../../infra/keycloak/realm-export.json');
const ALL_REALM_ROLES = REALM_EXPORT.roles.realm.map((r) => r.name);
const ALL_CLIENT_SCOPES = REALM_EXPORT.clientScopes.map((c) => c.name);

function defaultScenarios() {
  return {
    'good-code': { roles: ['hr_officer'], displayName: 'เจ้าหน้าที่ ก.', username: 'hr.staff', scope: HR_SCOPE_WITH_MANAGE },
    // T10: ผู้จัดการ master data = hr_officer + hr_master_data_admin
    'master-data-admin-code': {
      roles: ['hr_officer', 'hr_master_data_admin'],
      displayName: 'เจ้าหน้าที่ PS (master data)',
      username: 'hr.masterdata',
      scope: HR_SCOPE_WITH_MANAGE,
    },
    // มี hr_master_data_admin แต่ไม่มี hr_officer -> login ไม่ได้ (ยังบังคับ hr_officer เป็นเงื่อนไขเข้า console)
    'master-data-only-code': {
      roles: ['hr_master_data_admin'],
      displayName: 'มีแต่ master data',
      username: 'hr.mdonly',
      scope: HR_SCOPE_WITH_MANAGE,
    },
    // T10-fix: token ใหญ่ผิดปกติ - ผู้ใช้ที่มีทุก realm role และทุก scope ของระบบ + role ปลอมอีก 300 ตัว
    'huge-token-code': {
      roles: ALL_REALM_ROLES,
      padRoles: 300,
      displayName: 'ผู้ใช้ token ใหญ่มาก',
      username: 'hr.huge',
      scope: `openid ${ALL_CLIENT_SCOPES.join(' ')}`,
      expiresIn: 1, // ทุก request ต้อง refresh -> ทดสอบ cookie ตลอดเส้นทาง refresh ด้วย
    },
    // T10-fix: เลียนแบบ revokeRefreshToken=true (refresh token ใช้ได้ครั้งเดียว) + หน่วงตอบ เพื่อให้ request พร้อมกันชนกัน
    'rotating-code': {
      roles: ['hr_officer'],
      displayName: 'เจ้าหน้าที่ refresh token หมุนเวียน',
      username: 'hr.rotating',
      scope: HR_SCOPE_WITH_MANAGE,
      expiresIn: 1,
      rotateRefresh: true,
      refreshDelayMs: 150,
    },
    'master-data-admin-short-code': {
      roles: ['hr_officer', 'hr_master_data_admin'],
      displayName: 'PS master data อายุ token สั้น',
      username: 'hr.mdshort',
      scope: HR_SCOPE_WITH_MANAGE,
      expiresIn: 1,
      rotateRefresh: true,
    },
    'no-role-code': { roles: ['staff'], displayName: 'พนักงานทั่วไป', username: 'staff.user', scope: 'personnel:self' },
    'no-id-token-code': { roles: ['hr_officer'], omitIdToken: true, scope: HR_SCOPE },
    'short-lived-code': { roles: ['hr_officer'], displayName: 'เจ้าหน้าที่หมดอายุเร็ว', username: 'hr.shortlived', scope: HR_SCOPE, expiresIn: 1 },
    'short-lived-no-refresh-code': {
      roles: ['hr_officer'],
      displayName: 'เจ้าหน้าที่ไม่มี refresh',
      username: 'hr.norefresh',
      scope: HR_SCOPE,
      expiresIn: 1,
      refreshable: false,
    },
  };
}

// รัน instance จริงของ MDM API (api/src/app.js) บน loopback port จริง + mock Keycloak token endpoint
// (ไม่ mock MDM API เลย - HR Console คุยผ่าน HTTP จริงทุกประการเหมือนโปรดักชัน)
async function buildIntegrationHarness({ scenarios } = {}) {
  const apiCtx = await buildTestApp();
  const apiServer = await new Promise((resolve) => {
    const server = apiCtx.app.listen(0, () => resolve(server));
  });
  const apiPort = apiServer.address().port;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const mockKeycloak = createMockKeycloakServer({
    auth: apiCtx.auth,
    hrConsoleClientId: HR_CONSOLE_CLIENT_ID,
    hrConsoleClientSecret: HR_CONSOLE_CLIENT_SECRET,
    scenarios: scenarios || defaultScenarios(),
  });
  const keycloakBaseUrl = await mockKeycloak.listen();

  const keycloakAuthClient = createKeycloakAuthClient({
    authorizationUrl: `${keycloakBaseUrl}/protocol/openid-connect/auth`,
    tokenUrl: `${keycloakBaseUrl}/protocol/openid-connect/token`,
    logoutUrl: `${keycloakBaseUrl}/protocol/openid-connect/logout`,
    clientId: HR_CONSOLE_CLIENT_ID,
    clientSecret: HR_CONSOLE_CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    scope: HR_SCOPE,
  });

  const verifyIdToken = createIdTokenVerifier({
    jwks: apiCtx.auth.jwks,
    issuer: apiCtx.auth.issuer,
    audience: HR_CONSOLE_CLIENT_ID,
  });

  const mdmClient = createMdmClient({ baseUrl: apiBaseUrl });

  const sessionStore = createSessionStore();
  const hrConsoleApp = createHrConsoleApp({
    keycloakAuthClient,
    verifyIdToken,
    mdmClient,
    sessionStore,
    isProduction: false,
  });

  return {
    apiCtx,
    hrConsoleApp,
    sessionStore,
    mockKeycloak,
    async close() {
      await mockKeycloak.close();
      await new Promise((resolve) => apiServer.close(resolve));
      await apiCtx.pool.end();
    },
  };
}

// ล็อกอินให้ครบ flow จริง (login -> callback) แล้วคืน supertest agent ที่ถือ session cookie แล้ว
async function loginAsHrOfficer(app, code = 'good-code') {
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code, state });
  return agent;
}

module.exports = { ALL_REALM_ROLES, ALL_CLIENT_SCOPES, buildIntegrationHarness, loginAsHrOfficer, HR_CONSOLE_CLIENT_ID, HR_CONSOLE_CLIENT_SECRET, REDIRECT_URI };
