const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { DATABASE_URL } = require('./config');
const { createTestAuthContext } = require('./testJwks');
const { createFakeVaultClient } = require('../src/security/vault');

async function buildTestApp({ actingAssertion } = {}) {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const auth = await createTestAuthContext();
  const vault = createFakeVaultClient();
  const app = await createApp({
    pool,
    authConfig: { jwks: auth.jwks, issuer: auth.issuer, audience: auth.audience, actingAssertion },
    vault,
  });
  return { app, pool, auth, vault };
}

module.exports = { buildTestApp };
