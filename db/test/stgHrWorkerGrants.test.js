const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');
const { migrate } = require('./helpers');
const { makeFakePid } = require('../../api/src/security/pid');

// migration 1700000000043: สิทธิ์ mdm_worker รายคอลัมน์ + trigger ป้องกัน source_data + backfill loaded_at
// ใช้ SET ROLE จาก connection ของ migrator (superuser ของ container ทดสอบ) เพื่อทดสอบในสิทธิ์ของ role จริง
// ไม่ต้องสร้าง login user เพิ่ม; SET ROLE เปลี่ยน current_user ตามที่ trigger ตรวจ

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function insertBatch(client) {
  const {
    rows: [{ batch_id: batchId }],
  } = await client.query(
    `INSERT INTO stg_hr.import_batch (source_filename, imported_by) VALUES ('grant-test.csv', 'tester') RETURNING batch_id`
  );
  return batchId;
}

async function insertRow(client, batchId, sourceData = { SENTINEL: 'x' }) {
  const {
    rows: [{ raw_row_id: rawRowId }],
  } = await client.query(
    `INSERT INTO stg_hr.raw_row (batch_id, row_ref, source_data) VALUES ($1, 'r1', $2::jsonb) RETURNING raw_row_id`,
    [batchId, JSON.stringify(sourceData)]
  );
  return rawRowId;
}

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

async function expectDenied(promise) {
  await expect(promise).rejects.toMatchObject({ code: '42501' });
}

describe('สิทธิ์ mdm_worker บน stg_hr.raw_row (รายคอลัมน์)', () => {
  let rawRowId;

  beforeEach(async () => {
    await pool.query('TRUNCATE stg_hr.raw_row, stg_hr.import_batch CASCADE');
    rawRowId = await insertRow(pool, await insertBatch(pool));
  });

  test('UPDATE source_data เป็น {} และ source_purged_at ได้ (job ล้าง)', async () => {
    await asRole('mdm_worker', (c) =>
      c.query(`UPDATE stg_hr.raw_row SET source_data = '{}'::jsonb, source_purged_at = now() WHERE raw_row_id = $1`, [
        rawRowId,
      ])
    );
    const { rows } = await pool.query(`SELECT source_data, source_purged_at FROM stg_hr.raw_row WHERE raw_row_id = $1`, [
      rawRowId,
    ]);
    expect(rows[0].source_data).toEqual({});
    expect(rows[0].source_purged_at).not.toBeNull();
  });

  test('SELECT loaded_at / source_purged_at ได้', async () => {
    const { rows } = await asRole('mdm_worker', (c) =>
      c.query(`SELECT loaded_at, source_purged_at FROM stg_hr.raw_row WHERE raw_row_id = $1`, [rawRowId])
    );
    expect(rows[0].loaded_at).not.toBeNull();
  });

  test('SELECT source_data ถูกปฏิเสธ (ไม่ให้ worker อ่านข้อมูลดิบ)', async () => {
    await expectDenied(asRole('mdm_worker', (c) => c.query(`SELECT source_data FROM stg_hr.raw_row`)));
  });

  test.each(['phone_raw', 'email_personal_raw', 'expected_first_name_th', 'expected_last_name_th', 'email_work', 'employee_no', 'external_value'])(
    'UPDATE %s ถูกปฏิเสธ (ยังไม่ได้รับสิทธิ์ล้าง)',
    async (column) => {
      await expectDenied(
        asRole('mdm_worker', (c) => c.query(`UPDATE stg_hr.raw_row SET ${column} = NULL WHERE raw_row_id = $1`, [rawRowId]))
      );
    }
  );

  test('UPDATE quality_errors และ loaded_at ถูกปฏิเสธ', async () => {
    await expectDenied(
      asRole('mdm_worker', (c) => c.query(`UPDATE stg_hr.raw_row SET quality_errors = '[]'::jsonb WHERE raw_row_id = $1`, [rawRowId]))
    );
    await expectDenied(
      asRole('mdm_worker', (c) => c.query(`UPDATE stg_hr.raw_row SET loaded_at = now() WHERE raw_row_id = $1`, [rawRowId]))
    );
  });
});

describe('trigger raw_row_guard_worker_source_data', () => {
  let rawRowId;

  beforeEach(async () => {
    await pool.query('TRUNCATE stg_hr.raw_row, stg_hr.import_batch CASCADE');
    rawRowId = await insertRow(pool, await insertBatch(pool));
  });

  test('mdm_worker เขียน source_data เป็นค่าอื่นนอกจาก {} -> ถูกปฏิเสธ', async () => {
    await expect(
      asRole('mdm_worker', (c) =>
        c.query(`UPDATE stg_hr.raw_row SET source_data = '{"a":1}'::jsonb WHERE raw_row_id = $1`, [rawRowId])
      )
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('source_data') });

    const { rows } = await pool.query(`SELECT source_data FROM stg_hr.raw_row WHERE raw_row_id = $1`, [rawRowId]);
    expect(rows[0].source_data).toEqual({ SENTINEL: 'x' });
  });

  test('mdm_worker เขียน source_data เป็น {} -> ผ่าน', async () => {
    await asRole('mdm_worker', (c) =>
      c.query(`UPDATE stg_hr.raw_row SET source_data = '{}'::jsonb WHERE raw_row_id = $1`, [rawRowId])
    );
    const { rows } = await pool.query(`SELECT source_data FROM stg_hr.raw_row WHERE raw_row_id = $1`, [rawRowId]);
    expect(rows[0].source_data).toEqual({});
  });

  test('INSERT source_data ที่มีข้อมูล (loadBatch ผ่าน mdm_migrate) -> ไม่ถูกขวาง', async () => {
    await asRole('mdm_migrate', async (c) => {
      const batchId = await insertBatch(c);
      await insertRow(c, batchId, { SENTINEL: 'loaded' });
    });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM stg_hr.raw_row WHERE source_data ? 'SENTINEL'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  test('mdm_migrate / owner UPDATE source_data เป็นค่าอื่นได้ (trigger เจาะจงเฉพาะ mdm_worker)', async () => {
    await asRole('mdm_migrate', (c) =>
      c.query(`UPDATE stg_hr.raw_row SET source_data = '{"b":2}'::jsonb WHERE raw_row_id = $1`, [rawRowId])
    );
    await pool.query(`UPDATE stg_hr.raw_row SET source_data = '{"c":3}'::jsonb WHERE raw_row_id = $1`, [rawRowId]);
    const { rows } = await pool.query(`SELECT source_data FROM stg_hr.raw_row WHERE raw_row_id = $1`, [rawRowId]);
    expect(rows[0].source_data).toEqual({ c: 3 });
  });
});

// ทดสอบ backfill และ reversibility: ถอย migration 043 ลง 1 ขั้น (ตารางมีแถว) แล้วขึ้นใหม่ - jest รัน --runInBand
// และ finally ขึ้นกลับเสมอ เพื่อไม่ให้ suite อื่นเห็นสถานะค้าง
describe('migration 043: backfill loaded_at และ down/up', () => {
  const T_PID = '2026-01-10T00:00:00Z';
  const T_BATCH = '2026-01-05T00:00:00Z';

  afterAll(async () => {
    await migrate(DATABASE_URL, 'up');
  });

  test('down ลบ trigger/function/index/คอลัมน์ครบ; up backfill COALESCE(pid_loaded_at, imported_at, now())', async () => {
    await pool.query('TRUNCATE stg_hr.raw_row, stg_hr.import_batch CASCADE');
    await migrate(DATABASE_URL, 'down', { count: 1 });

    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'stg_hr' AND table_name = 'raw_row' AND column_name IN ('loaded_at', 'source_purged_at')`
    );
    expect(cols).toHaveLength(0);
    const { rows: leftovers } = await pool.query(
      `SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'raw_row_guard_worker_source_data')::int AS triggers,
              (SELECT count(*) FROM pg_proc WHERE proname = 'guard_worker_source_data')::int AS functions,
              (SELECT count(*) FROM pg_indexes WHERE indexname = 'raw_row_source_unpurged_idx')::int AS indexes`
    );
    expect(leftovers[0]).toEqual({ triggers: 0, functions: 0, indexes: 0 });

    const {
      rows: [{ batch_id: batchId }],
    } = await pool.query(
      `INSERT INTO stg_hr.import_batch (source_filename, imported_by, imported_at)
       VALUES ('backfill.csv', 'tester', $1) RETURNING batch_id`,
      [T_BATCH]
    );
    await pool.query(
      `INSERT INTO stg_hr.raw_row (batch_id, row_ref, pid_plaintext, pid_loaded_at, source_data) VALUES
         ($1, 'with-pid', $3, $2, '{}'::jsonb),
         ($1, 'no-pid', NULL, NULL, '{}'::jsonb)`,
      [batchId, T_PID, makeFakePid()]
    );

    await migrate(DATABASE_URL, 'up');

    const { rows } = await pool.query(
      `SELECT row_ref, loaded_at, source_purged_at FROM stg_hr.raw_row WHERE batch_id = $1 ORDER BY row_ref`,
      [batchId]
    );
    const byRef = Object.fromEntries(rows.map((r) => [r.row_ref, r]));
    expect(byRef['with-pid'].loaded_at.toISOString()).toBe(new Date(T_PID).toISOString()); // pid_loaded_at ก่อน
    expect(byRef['no-pid'].loaded_at.toISOString()).toBe(new Date(T_BATCH).toISOString()); // ไม่มี pid -> imported_at
    expect(byRef['with-pid'].source_purged_at).toBeNull();

    const { rows: nullable } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'stg_hr' AND table_name = 'raw_row' AND column_name = 'loaded_at'`
    );
    expect(nullable[0].is_nullable).toBe('NO');
  });
});
