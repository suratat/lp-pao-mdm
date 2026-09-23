const { createApp } = require('./app');
const { createKeycloakAuthClient } = require('./security/keycloakAuthClient');
const { createIdTokenVerifier } = require('./security/idTokenVerifier');
const { createMdmClient } = require('./mdmClient');

const PORT = process.env.PORT || 3300;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้งค่า ${name}`);
  return value;
}

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';

  const keycloakAuthClient = createKeycloakAuthClient({
    authorizationUrl: requireEnv('KEYCLOAK_AUTHORIZATION_URL'),
    tokenUrl: requireEnv('KEYCLOAK_TOKEN_URL'),
    logoutUrl: process.env.KEYCLOAK_LOGOUT_URL || null,
    clientId: requireEnv('DPO_CONSOLE_CLIENT_ID'),
    clientSecret: requireEnv('DPO_CONSOLE_CLIENT_SECRET'),
    redirectUri: requireEnv('DPO_CONSOLE_CALLBACK_URL'),
    scope: process.env.DPO_CONSOLE_SCOPES || 'openid audit:read events:read',
  });

  const verifyIdToken = createIdTokenVerifier({
    jwks: requireEnv('KEYCLOAK_JWKS_URI'),
    issuer: requireEnv('KEYCLOAK_ISSUER'),
    audience: requireEnv('DPO_CONSOLE_CLIENT_ID'),
  });

  const mdmClient = createMdmClient({ baseUrl: process.env.MDM_API_BASE_URL || 'https://mdm.lp-pao.go.th' });

  const app = createApp({
    keycloakAuthClient,
    verifyIdToken,
    mdmClient,
    sessionSecret: requireEnv('DPO_CONSOLE_SESSION_SECRET'),
    isProduction,
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`DPO Console ฟังอยู่ที่ port ${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ', err);
  process.exit(1);
});
