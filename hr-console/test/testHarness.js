const request = require('supertest');
const { buildTestApp } = require('../../api/test/testApp');
const { createApp: createHrConsoleApp } = require('../src/app');
const { createKeycloakAuthClient } = require('../src/security/keycloakAuthClient');
const { createIdTokenVerifier } = require('../src/security/idTokenVerifier');
const { createMdmClient } = require('../src/mdmClient');
const { createMockKeycloakServer } = require('./mockKeycloakServer');

const HR_CONSOLE_CLIENT_ID = 'hr-console-test';
const HR_CONSOLE_CLIENT_SECRET = 'hr-console-test-secret';
const REDIRECT_URI = 'http://hr-console.test/auth/callback';
const SESSION_SECRET = 'hr-console-test-session-secret';
const HR_SCOPE = 'openid personnel:provision personnel:write:employment personnel:import personnel:read:basic';

function defaultScenarios() {
  return {
    'good-code': { roles: ['hr_officer'], displayName: 'เจ้าหน้าที่ ก.', username: 'hr.staff', scope: HR_SCOPE },
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

  const hrConsoleApp = createHrConsoleApp({
    keycloakAuthClient,
    verifyIdToken,
    mdmClient,
    sessionSecret: SESSION_SECRET,
    isProduction: false,
  });

  return {
    apiCtx,
    hrConsoleApp,
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

module.exports = { buildIntegrationHarness, loginAsHrOfficer, HR_CONSOLE_CLIENT_ID, HR_CONSOLE_CLIENT_SECRET, REDIRECT_URI };
