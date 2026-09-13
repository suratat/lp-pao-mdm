const { execSync, spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { migrate } = require('./helpers');

// ทดสอบว่า migrate ขึ้น/ลง/ขึ้นได้จริงบน PostgreSQL 16 "เปล่า"
// ต้องใช้ container แยกต่างหาก (ไม่ใช้ database ที่สองใน container เดียวกับ mdm_test) เพราะ
// role ระดับ cluster (mdm_app ฯลฯ) ที่ migration 0002 สร้าง เป็นของทั้ง cluster ไม่ใช่ของ database เดียว
// ถ้าใช้ cluster เดียวกัน DROP ROLE ตอน migrate down จะล้มเหลวเพราะ role ยังมีสิทธิ์ค้างอยู่ใน mdm_test
const CONTAINER_NAME = `mdm-roundtrip-${Date.now()}`;
const HOST_PORT = 55433;
const DATABASE_URL = `postgres://postgres:postgres@localhost:${HOST_PORT}/postgres`;

function waitForPostgres(url, retries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = async (remaining) => {
      const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1000 });
      try {
        await pool.query('SELECT 1');
        await pool.end();
        resolve();
      } catch (err) {
        await pool.end().catch(() => {});
        if (remaining <= 0) return reject(err);
        setTimeout(() => attempt(remaining - 1), 1000);
      }
    };
    attempt(retries);
  });
}

beforeAll(async () => {
  execSync(
    `docker run -d --rm --name ${CONTAINER_NAME} -e POSTGRES_PASSWORD=postgres -p ${HOST_PORT}:5432 postgres:16`,
    { stdio: 'inherit' }
  );
  await waitForPostgres(DATABASE_URL);
}, 60000);

afterAll(async () => {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'inherit' });
});

test(
  'migrate up -> down -> up สำเร็จบน PostgreSQL 16 เปล่า',
  async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });

    const countTables = async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema IN ('mdm', 'audit', 'integration')`
      );
      return rows[0].n;
    };

    await migrate(DATABASE_URL, 'up');
    const afterUp = await countTables();
    expect(afterUp).toBeGreaterThan(0);

    await migrate(DATABASE_URL, 'down');
    expect(await countTables()).toBe(0);

    await migrate(DATABASE_URL, 'up');
    expect(await countTables()).toBe(afterUp);

    await pool.end();
  },
  120000
);
