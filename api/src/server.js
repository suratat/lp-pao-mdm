const { createApp } = require('./app');
const { getPool } = require('./db/pool');
const { createVaultHttpClient } = require('./security/vault');

const PORT = process.env.PORT || 3000;

async function main() {
  const app = await createApp({
    pool: getPool(),
    authConfig: {
      jwks: process.env.JWT_JWKS_URI || 'https://iam.lp-pao.go.th/realms/lp-pao/protocol/openid-connect/certs',
      issuer: process.env.JWT_ISSUER || 'https://iam.lp-pao.go.th/realms/lp-pao',
      audience: process.env.JWT_AUDIENCE || 'mdm-api',
      // ทางเลือก B (§0.3, T9): ตรวจ X-Acting-Person จาก mdm-portal - ไม่ตั้ง secret แล้วปิดเงียบ (opt-in)
      actingAssertion: process.env.PORTAL_ACTING_ASSERTION_SECRET
        ? {
            secret: process.env.PORTAL_ACTING_ASSERTION_SECRET,
            allowedAzp: (process.env.PORTAL_ACTING_ASSERTION_AZP || 'mdm-portal').split(',').map((s) => s.trim()),
          }
        : undefined,
    },
    vault: createVaultHttpClient({
      addr: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
    }),
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`MDM API ฟังอยู่ที่ port ${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ', err);
  process.exit(1);
});
