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

// migration 1700000000044: up -> down -> up เฉพาะตัวนี้ (ต่อจากเทสต์ด้านบนที่ปล่อยให้ DB อยู่ที่ "up" ครบ) - เดินถอยทีละ 1 จนกว่า 044 จะถูกย้อน
// (ไม่ผูกกับ count:1 เพราะจะผิดตัวเมื่อมี migration ใหม่กว่า) แล้วตรวจฟังก์ชัน/สิทธิ์ทั้งสองทิศ และว่า partition ที่สร้างไว้ไม่หาย
test(
  'migration 044 (ensure_access_log_partition): up -> down -> up',
  async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    const FN = 'audit.ensure_access_log_partition(date)';
    const state = async () => {
      const {
        rows: [row],
      } = await pool.query(
        `SELECT prosecdef, proconfig,
                has_function_privilege('mdm_app', oid, 'EXECUTE') AS app_can,
                has_function_privilege('mdm_worker', oid, 'EXECUTE') AS worker_can
         FROM pg_proc WHERE oid = '${FN}'::regprocedure`
      );
      return row;
    };
    const partitions = async () =>
      (
        await pool.query(
          `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'audit.access_log'::regclass ORDER BY c.relname`
        )
      ).rows.map((r) => r.relname);
    const applied = async () =>
      (await pool.query(`SELECT 1 FROM pgmigrations WHERE name LIKE '%044_access_log_partition_ensure_definer'`)).rowCount > 0;

    expect(await applied()).toBe(true);
    expect(await state()).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog, audit'], app_can: false, worker_can: true });
    const partitionsUp = await partitions();
    expect(partitionsUp.length).toBeGreaterThanOrEqual(5); // 4 เดือน + default

    for (let i = 0; i < 100 && (await applied()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await migrate(DATABASE_URL, 'down', { count: 1 });
    }
    expect(await applied()).toBe(false);
    // กลับเป็นฟังก์ชันเดิม: SECURITY INVOKER, ไม่มี search_path, EXECUTE ให้ PUBLIC (รวม mdm_app) - และ partition ที่สร้างไว้ยังอยู่
    expect(await state()).toMatchObject({ prosecdef: false, proconfig: null, app_can: true });
    expect(await partitions()).toEqual(partitionsUp);

    await migrate(DATABASE_URL, 'up');
    expect(await applied()).toBe(true);
    expect(await state()).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog, audit'], app_can: false, worker_can: true });
    expect(await partitions()).toEqual(partitionsUp); // up ซ้ำบนเดือนที่มีอยู่แล้วไม่ error ไม่เกิด partition ซ้ำ

    await pool.end();
  },
  120000
);
