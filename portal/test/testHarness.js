const { buildTestApp } = require('../../api/test/testApp');
const { createApp: createPortalApp } = require('../src/app');
const { createMdmClient } = require('../src/mdmClient');

const ACTING_SECRET = 'portal-test-acting-assertion-secret';
const SESSION_SECRET = 'portal-test-session-secret';

// รัน instance จริงของ MDM API (api/src/app.js) บน loopback port จริง แล้วให้ Portal คุยผ่าน HTTP เหมือน
// โปรดักชันทุกประการ (ไม่ mock MDM API) - ข้ามเฉพาะการขอ token จาก Keycloak จริง (ใช้ token ที่เซ็นด้วย
// local JWKS ของ api/test/testJwks.js แทน เหมือนที่เทสของ api/ ทำอยู่แล้ว)
// consentsEnabled / emergencyContactsEnabled: ไม่ระบุ = ตาม env PORTAL_CONSENTS_ENABLED / PORTAL_EMERGENCY_CONTACTS_ENABLED
// (default ปิด เหมือน server.js)
async function buildIntegrationHarness({
  checkAuthClient,
  consentsEnabled = process.env.PORTAL_CONSENTS_ENABLED === 'true',
  emergencyContactsEnabled = process.env.PORTAL_EMERGENCY_CONTACTS_ENABLED === 'true',
  emailCheck,
} = {}) {
  const apiCtx = await buildTestApp({ actingAssertion: { secret: ACTING_SECRET, allowedAzp: ['mdm-portal'] } });
  const apiServer = await new Promise((resolve) => {
    const server = apiCtx.app.listen(0, () => resolve(server));
  });
  const apiPort = apiServer.address().port;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const portalToken = await apiCtx.auth.signToken({ scope: 'personnel:self', sub: 'mdm-portal', azp: 'mdm-portal' });
  const getServiceToken = async () => portalToken;

  const mdmClient = createMdmClient({
    baseUrl: apiBaseUrl,
    getServiceToken,
    actingAssertionSecret: ACTING_SECRET,
    portalClientId: 'mdm-portal',
  });

  const portalApp = createPortalApp({
    mdmClient,
    sessionSecret: SESSION_SECRET,
    isProduction: false,
    checkAuthClient: checkAuthClient || null,
    consentsEnabled,
    emergencyContactsEnabled,
    emailCheck,
  });

  return {
    apiCtx,
    portalApp,
    async close() {
      await new Promise((resolve) => apiServer.close(resolve));
      await apiCtx.pool.end();
    },
  };
}

module.exports = { buildIntegrationHarness };
