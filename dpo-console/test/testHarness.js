const request = require('supertest');
const { buildTestApp } = require('../../api/test/testApp');
const { createApp: createDpoConsoleApp } = require('../src/app');
const { createKeycloakAuthClient } = require('../src/security/keycloakAuthClient');
const { createIdTokenVerifier } = require('../src/security/idTokenVerifier');
const { createMdmClient } = require('../src/mdmClient');
const { createMockKeycloakServer } = require('./mockKeycloakServer');

const DPO_CONSOLE_CLIENT_ID = 'dpo-console-test';
const DPO_CONSOLE_CLIENT_SECRET = 'dpo-console-test-secret';
const REDIRECT_URI = 'http://dpo-console.test/auth/callback';
const SESSION_SECRET = 'dpo-console-test-session-secret';
const DPO_SCOPE = 'openid audit:read events:read';

function defaultScenarios() {
  return {
    'good-dpo-code': { roles: ['dpo'], displayName: 'DPO หนึ่ง', username: 'dpo.one', scope: DPO_SCOPE },
    'good-auditor-code': { roles: ['auditor'], displayName: 'ผู้ตรวจสอบหนึ่ง', username: 'auditor.one', scope: DPO_SCOPE },
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

  const dpoConsoleApp = createDpoConsoleApp({
    keycloakAuthClient,
    verifyIdToken,
    mdmClient,
    sessionSecret: SESSION_SECRET,
    isProduction: false,
  });

  return {
    apiCtx,
    dpoConsoleApp,
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

module.exports = { buildIntegrationHarness, loginAsDpo, DPO_CONSOLE_CLIENT_ID, DPO_CONSOLE_CLIENT_SECRET, REDIRECT_URI };
