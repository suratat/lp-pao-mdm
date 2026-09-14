const { createApp } = require('./app');
const { createMdmClient } = require('./mdmClient');
const { createKeycloakServiceTokenProvider } = require('./security/keycloakClient');
const { createCheckAuthClient } = require('./security/checkAuthClient');

const PORT = process.env.PORT || 3100;
const CHECK_AUTH_ENV_KEYS = ['CHECK_BASE_URL', 'CHECK_CLIENT_ID', 'CHECK_CLIENT_SECRET', 'PORTAL_AUTH_CALLBACK_URL'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้งค่า ${name}`);
  return value;
}

// ล็อกอินจริงผ่าน check.lp-pao.go.th (ดู portal/README.md) ต้องตั้ง env ทั้ง 4 ตัวให้ครบ - ถ้าไม่ตั้งเลย
// สักตัวใน dev/test คืน null (fallback ไป dev-login stub เดิม) แต่ถ้าตั้งมาไม่ครบ (บางตัว) หรืออยู่ใน
// production ให้ error ทันที กันตั้งค่าพลาดครึ่ง ๆ กลาง ๆ แล้วไม่รู้ตัว
function buildCheckAuthClient(isProduction) {
  const present = CHECK_AUTH_ENV_KEYS.filter((key) => process.env[key]);
  if (present.length === 0) {
    if (isProduction) {
      throw new Error(`ต้องตั้งค่า ${CHECK_AUTH_ENV_KEYS.join(', ')} ใน production`);
    }
    return null;
  }
  const missing = CHECK_AUTH_ENV_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`ตั้งค่าการล็อกอินผ่าน check.lp-pao.go.th ไม่ครบ ขาด: ${missing.join(', ')}`);
  }
  return createCheckAuthClient({
    baseUrl: process.env.CHECK_BASE_URL,
    clientId: process.env.CHECK_CLIENT_ID,
    clientSecret: process.env.CHECK_CLIENT_SECRET,
    redirectUri: process.env.PORTAL_AUTH_CALLBACK_URL,
  });
}

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  const checkAuthClient = buildCheckAuthClient(isProduction);

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
    checkAuthClient,
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
