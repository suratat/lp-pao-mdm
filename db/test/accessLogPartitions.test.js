const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// migration 1700000000044: audit.ensure_access_log_partition เป็น SECURITY DEFINER, EXECUTE เฉพาะ mdm_worker,
// สร้างล่วงหน้า 3 เดือน, partition ใหม่ได้ trigger append-only จากตารางแม่
// ใช้ SET ROLE จาก connection ของ migrator (superuser ของ container ทดสอบ) เหมือน stgHrWorkerGrants.test.js
let pool;
const FAR_MONTH = '2040-05-01'; // เดือนที่ไม่มี partition อยู่แล้ว (ลบทิ้งใน afterAll)

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.query('DROP TABLE IF EXISTS audit.access_log_2040_05');
  await pool.end();
});

async function asRole(role, fn) {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await fn(client);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

const partitionNames = async () =>
  (
    await pool.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'audit.access_log'::regclass ORDER BY c.relname`
    )
  ).rows.map((r) => r.relname);

describe('migration 044: ensure_access_log_partition', () => {
  test('ฟังก์ชันเป็น SECURITY DEFINER, ตั้ง search_path = pg_catalog, audit และไม่ให้ EXECUTE แก่ PUBLIC', async () => {
    const {
      rows: [fn],
    } = await pool.query(
      `SELECT prosecdef, proconfig, proacl::text AS acl
       FROM pg_proc WHERE oid = 'audit.ensure_access_log_partition(date)'::regprocedure`
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=pg_catalog, audit']);
    expect(fn.acl).not.toMatch(/(^|[{,])=X/); // "=X/owner" = PUBLIC
    expect(fn.acl).toContain('mdm_worker=X/');
  });

  test('migrate สร้างล่วงหน้าเดือนปัจจุบัน + 3 เดือน', async () => {
    const { rows } = await pool.query(
      `SELECT 'access_log_' || to_char(date_trunc('month', now()) + make_interval(months => m), 'YYYY_MM') AS name
       FROM generate_series(0, 3) AS m`
    );
    const existing = await partitionNames();
    for (const { name } of rows) expect(existing).toContain(name);
    expect(existing).toContain('access_log_default');
  });

  test('ขอบเขตของ partition 4 เดือนที่ migrate สร้างต่อเนื่องกัน ไม่มีช่องว่าง (ไม่มีแถวหลุดลง default)', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'audit.access_log'::regclass
         AND c.relname IN (
           SELECT 'access_log_' || to_char(date_trunc('month', now()) + make_interval(months => m), 'YYYY_MM')
           FROM generate_series(0, 3) AS m
         )
       ORDER BY c.relname`
    );
    expect(rows).toHaveLength(4);
    const ranges = rows.map((r) => {
      const [, from, to] = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(r.bound);
      return { name: r.relname, from, to };
    });
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i].from).toBe(ranges[i - 1].to);
  });

  test('เรียกซ้ำได้: เดือนที่มีอยู่แล้วไม่ error และไม่เกิด partition ซ้ำ', async () => {
    const before = await partitionNames();
    await pool.query(`SELECT audit.ensure_access_log_partition(date_trunc('month', now())::date)`);
    await pool.query(`SELECT audit.ensure_access_log_partition(date_trunc('month', now())::date)`);
    expect(await partitionNames()).toEqual(before);

    await pool.query(`SELECT audit.ensure_access_log_partition($1::date)`, [FAR_MONTH]);
    await pool.query(`SELECT audit.ensure_access_log_partition($1::date)`, ['2040-05-20']); // วันอื่นในเดือนเดียวกัน
    expect((await partitionNames()).filter((n) => n === 'access_log_2040_05')).toHaveLength(1);
  });

  test('mdm_worker เรียกได้จริง (ทั้งที่ไม่มีสิทธิ์ CREATE ใน schema audit)', async () => {
    const canCreate = await pool.query(`SELECT has_schema_privilege('mdm_worker', 'audit', 'CREATE') AS ok`);
    expect(canCreate.rows[0].ok).toBe(false);

    await asRole('mdm_worker', (c) => c.query(`SELECT audit.ensure_access_log_partition('2040-06-01')`));
    expect(await partitionNames()).toContain('access_log_2040_06');
    await pool.query('DROP TABLE audit.access_log_2040_06');
  });

  // mdm_app/mdm_audit มี USAGE บน schema audit จึงชนที่ EXECUTE ของฟังก์ชัน (พิสูจน์ว่า REVOKE FROM PUBLIC ได้ผล);
  // mdm_readonly ไม่มี USAGE บน schema audit เลย จึงถูกปฏิเสธที่ชั้น schema
  test.each([
    ['mdm_app', /permission denied for function ensure_access_log_partition/],
    ['mdm_audit', /permission denied for function ensure_access_log_partition/],
    ['mdm_readonly', /permission denied for schema audit/],
  ])('role %s เรียกไม่ได้ (permission denied)', async (role, pattern) => {
    await expect(asRole(role, (c) => c.query(`SELECT audit.ensure_access_log_partition('2040-07-01')`))).rejects.toThrow(pattern);
    expect(await partitionNames()).not.toContain('access_log_2040_07');
  });

  test('partition ใหม่ได้ trigger append-only จากตารางแม่: UPDATE/DELETE ถูกปฏิเสธ', async () => {
    const {
      rows: [{ person_id: personId }],
    } = await pool.query(`INSERT INTO mdm.person (pid_hash) VALUES ($1) RETURNING person_id`, [crypto.randomBytes(32).toString('hex')]);

    const { rows: triggers } = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit.access_log_2040_05'::regclass AND NOT tgisinternal`
    );
    expect(triggers.map((t) => t.tgname)).toContain('access_log_append_only');

    const {
      rows: [{ access_id: accessId }],
    } = await pool.query(
      `INSERT INTO audit.access_log (accessed_at, subject_person_id, actor_type, endpoint, http_method)
       VALUES ('2040-05-15 10:00:00+00', $1, 'SERVICE', '/persons/x', 'GET') RETURNING access_id`,
      [personId]
    );
    // แถวลง partition เดือนนั้น ไม่ใช่ default
    const { rows: placed } = await pool.query(
      `SELECT tableoid::regclass::text AS part FROM audit.access_log WHERE access_id = $1`,
      [accessId]
    );
    expect(placed[0].part).toBe('audit.access_log_2040_05');

    await expect(pool.query(`UPDATE audit.access_log SET response_status = 500 WHERE access_id = $1`, [accessId])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit.access_log WHERE access_id = $1`, [accessId])).rejects.toThrow(/append-only/);
  });
});
