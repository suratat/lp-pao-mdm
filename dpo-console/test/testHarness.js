const request = require('supertest');
const { buildTestApp } = require('../../api/test/testApp');
const { createApp: createDpoConsoleApp } = require('../src/app');
const { createKeycloakAuthClient } = require('../src/security/keycloakAuthClient');
const { createIdTokenVerifier } = require('../src/security/idTokenVerifier');
const { createMdmClient } = require('../src/mdmClient');
const { createMockKeycloakServer } = require('./mockKeycloakServer');
const { createSessionStore } = require('../src/session/sessionStore');

const DPO_CONSOLE_CLIENT_ID = 'dpo-console-test';
const DPO_CONSOLE_CLIENT_SECRET = 'dpo-console-test-secret';
const REDIRECT_URI = 'http://dpo-console.test/auth/callback';
const DPO_SCOPE = 'openid audit:read events:read';

// role/scope ทั้งหมดที่มีใน realm จริง (อ่านจาก infra/keycloak/realm-export.json) - ใช้จำลองผู้ใช้ที่มีครบทุกอย่าง
const REALM_EXPORT = require('../../infra/keycloak/realm-export.json');
const ALL_REALM_ROLES = REALM_EXPORT.roles.realm.map((r) => r.name);
const ALL_CLIENT_SCOPES = REALM_EXPORT.clientScopes.map((c) => c.name);

function defaultScenarios() {
  return {
    'good-dpo-code': { roles: ['dpo'], displayName: 'DPO หนึ่ง', username: 'dpo.one', scope: DPO_SCOPE },
    'good-auditor-code': { roles: ['auditor'], displayName: 'ผู้ตรวจสอบหนึ่ง', username: 'auditor.one', scope: DPO_SCOPE },
    // T10-fix: token ใหญ่ผิดปกติ (ผู้ใช้มีทุก realm role และทุก scope ของระบบ + role ปลอม 300 ตัว) - ดู test/session.test.js
    'huge-token-code': {
      roles: ALL_REALM_ROLES,
      padRoles: 300,
      displayName: 'ผู้ใช้ token ใหญ่มาก',
      username: 'dpo.huge',
      scope: `openid ${ALL_CLIENT_SCOPES.join(' ')}`,
      expiresIn: 1,
    },
    // เลียนแบบ revokeRefreshToken=true (refresh token ใช้ได้ครั้งเดียว) + หน่วงตอบ เพื่อให้ request พร้อมกันชนกัน
    'rotating-code': {
      roles: ['dpo'],
      displayName: 'DPO refresh token หมุนเวียน',
      username: 'dpo.rotating',
      scope: DPO_SCOPE,
      expiresIn: 1,
      rotateRefresh: true,
      refreshDelayMs: 150,
    },
    'no-role-code': { roles: ['staff'], displayName: 'พนักงานทั่วไป', username: 'staff.user', scope: 'personnel:self' },
    'no-id-token-code': { roles: ['dpo'], omitIdToken: true, scope: DPO_SCOPE },
    'short-lived-code': { roles: ['dpo'], displayName: 'DPO หมดอายุเร็ว', username: 'dpo.shortlived', scope: DPO_SCOPE, expiresIn: 1 },
    'short-lived-no-refresh-code': {
      roles: ['dpo'],
      displayName: 'DPO ไม่มี refresh',
      username: 'dpo.norefresh',
      scope: DPO_SCOPE,
      expiresIn: 1,
      refreshable: false,
    },
  };
}

// รัน instance จริงของ MDM API (api/src/app.js) บน loopback port จริง + mock Keycloak token endpoint
// (ไม่ mock MDM API เลย - DPO Console คุยผ่าน HTTP จริงทุกประการเหมือนโปรดักชัน)
async function buildIntegrationHarness({ scenarios } = {}) {
  const apiCtx = await buildTestApp();
  const apiServer = await new Promise((resolve) => {
    const server = apiCtx.app.listen(0, () => resolve(server));
  });
  const apiPort = apiServer.address().port;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const mockKeycloak = createMockKeycloakServer({
    auth: apiCtx.auth,
    dpoConsoleClientId: DPO_CONSOLE_CLIENT_ID,
    dpoConsoleClientSecret: DPO_CONSOLE_CLIENT_SECRET,
    scenarios: scenarios || defaultScenarios(),
  });
  const keycloakBaseUrl = await mockKeycloak.listen();

  const keycloakAuthClient = createKeycloakAuthClient({
    authorizationUrl: `${keycloakBaseUrl}/protocol/openid-connect/auth`,
    tokenUrl: `${keycloakBaseUrl}/protocol/openid-connect/token`,
    logoutUrl: `${keycloakBaseUrl}/protocol/openid-connect/logout`,
    clientId: DPO_CONSOLE_CLIENT_ID,
    clientSecret: DPO_CONSOLE_CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    scope: DPO_SCOPE,
  });

  const verifyIdToken = createIdTokenVerifier({
    jwks: apiCtx.auth.jwks,
    issuer: apiCtx.auth.issuer,
    audience: DPO_CONSOLE_CLIENT_ID,
  });

  const mdmClient = createMdmClient({ baseUrl: apiBaseUrl });

  const sessionStore = createSessionStore();
  const dpoConsoleApp = createDpoConsoleApp({
    keycloakAuthClient,
    verifyIdToken,
    mdmClient,
    sessionStore,
    isProduction: false,
  });

  return {
    apiCtx,
    dpoConsoleApp,
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
async function loginAsDpo(app, code = 'good-dpo-code') {
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  await agent.get('/auth/callback').query({ code, state });
  return agent;
}

module.exports = { ALL_REALM_ROLES, ALL_CLIENT_SCOPES, buildIntegrationHarness, loginAsDpo, DPO_CONSOLE_CLIENT_ID, DPO_CONSOLE_CLIENT_SECRET, REDIRECT_URI };
