const path = require('node:path');
const { execSync } = require('node:child_process');
const { Pool } = require('pg');
const { migrate } = require('../../db/test/helpers');
const { MIGRATOR_DATABASE_URL, DATABASE_URL } = require('./config');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'db', 'docker-compose.yml');

module.exports = async () => {
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
  await adminPool.query(`GRANT mdm_migrate TO ${testUser};`);

  await adminPool.end();

  // pipeline.test.js เรียก api/test/testApp.js (buildTestApp) เพื่อทดสอบ end-to-end ผ่าน HTTP จริงตาม
  // สถาปัตยกรรมที่ตกลงไว้ (runImport เรียก POST /sync/hr/employment-batch ผ่าน HTTP เท่านั้น ไม่เรียก
  // service ของ api/ ตรงๆ) จึงต้องเตรียม role/fixture ของ api/test ไว้ด้วย (idempotent - เรียกซ้ำได้)
  await require('../../api/test/globalSetup')();
};
