const { createApp } = require('./app');
const { createKeycloakAuthClient } = require('./security/keycloakAuthClient');
const { createIdTokenVerifier } = require('./security/idTokenVerifier');
const { createMdmClient } = require('./mdmClient');

const PORT = process.env.PORT || 3200;

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
    clientId: requireEnv('HR_CONSOLE_CLIENT_ID'),
    clientSecret: requireEnv('HR_CONSOLE_CLIENT_SECRET'),
    redirectUri: requireEnv('HR_CONSOLE_CALLBACK_URL'),
    scope: process.env.HR_CONSOLE_SCOPES || 'openid personnel:provision personnel:write:employment personnel:import personnel:read:basic',
  });

  const verifyIdToken = createIdTokenVerifier({
    jwks: requireEnv('KEYCLOAK_JWKS_URI'),
    issuer: requireEnv('KEYCLOAK_ISSUER'),
    audience: requireEnv('HR_CONSOLE_CLIENT_ID'),
  });

  const mdmClient = createMdmClient({ baseUrl: process.env.MDM_API_BASE_URL || 'https://mdm.lp-pao.go.th' });

  const app = createApp({
    keycloakAuthClient,
    verifyIdToken,
    mdmClient,
    sessionSecret: requireEnv('HR_CONSOLE_SESSION_SECRET'),
    isProduction,
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`HR Console ฟังอยู่ที่ port ${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ', err);
  process.exit(1);
});
