const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { DATABASE_URL } = require('./config');
const { createTestAuthContext } = require('./testJwks');

async function buildTestApp() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const auth = await createTestAuthContext();
  const app = await createApp({
    pool,
    authConfig: { jwks: auth.jwks, issuer: auth.issuer, audience: auth.audience },
  });
  return { app, pool, auth };
}

module.exports = { buildTestApp };
