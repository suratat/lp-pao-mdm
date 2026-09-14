const { createApp } = require('./app');
const { createMdmClient } = require('./mdmClient');
const { createKeycloakServiceTokenProvider } = require('./security/keycloakClient');

const PORT = process.env.PORT || 3100;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้งค่า ${name}`);
  return value;
}

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';

  const getServiceToken = createKeycloakServiceTokenProvider({
    tokenUrl: requireEnv('KEYCLOAK_TOKEN_URL'),
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'mdm-portal',
    clientSecret: requireEnv('KEYCLOAK_CLIENT_SECRET'),
    scope: 'personnel:self',
  });

  const mdmClient = createMdmClient({
    baseUrl: process.env.MDM_API_BASE_URL || 'https://mdm.lp-pao.go.th',
    getServiceToken,
    actingAssertionSecret: requireEnv('PORTAL_ACTING_ASSERTION_SECRET'),
    portalClientId: process.env.KEYCLOAK_CLIENT_ID || 'mdm-portal',
  });

  const app = createApp({
    mdmClient,
    sessionSecret: requireEnv('PORTAL_SESSION_SECRET'),
    isProduction,
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`MDM Portal ฟังอยู่ที่ port ${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ', err);
  process.exit(1);
});
