const path = require('node:path');
const { execSync } = require('node:child_process');
const { Pool } = require('pg');
const { migrate } = require('../../db/test/helpers');
const { MIGRATOR_DATABASE_URL, DATABASE_URL } = require('./config');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'db', 'docker-compose.yml');

module.exports = async () => {
  // ใช้ Postgres container + migrations เดียวกับ T1 (db/) ไม่สร้างซ้ำ
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d --wait`, { cwd: REPO_ROOT, stdio: 'inherit' });

  await migrate(MIGRATOR_DATABASE_URL, 'up');

  const adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });

  const testUser = new URL(DATABASE_URL).username;
  const testPassword = new URL(DATABASE_URL).password;
  await adminPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${testUser}') THEN
        CREATE ROLE ${testUser} LOGIN PASSWORD '${testPassword}';
      END IF;
    END
    $$;
  `);
  await adminPool.query(`GRANT mdm_worker TO ${testUser};`);

  await adminPool.end();
};
