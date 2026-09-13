const { createPools } = require('./pools');
const { runStgHrPurge } = require('../src/jobs/stgHrPurge');

// adminPool: เตรียม fixture (mdm_worker มีสิทธิ์แค่ SELECT/UPDATE คอลัมน์ pid_plaintext ของ stg_hr.raw_row
// เท่านั้น โดยเจตนา - โหลด/ตรวจคุณภาพเป็นงานของ migrate/ ไม่ใช่ worker) pool: connection จริงของ worker
// (mdm_worker) ที่ job function ภายใต้การทดสอบใช้
let adminPool;
let pool;

beforeAll(() => {
  ({ adminPool, workerPool: pool } = createPools());
});

afterAll(async () => {
  await adminPool.end();
  await pool.end();
});

beforeEach(async () => {
  await adminPool.query('TRUNCATE stg_hr.raw_row, stg_hr.import_batch CASCADE');
});

async function insertRawRow({ pidPlaintext, pidLoadedAt }) {
  const {
    rows: [{ batch_id: batchId }],
  } = await adminPool.query(
    `INSERT INTO stg_hr.import_batch (source_filename, imported_by) VALUES ('test.csv', 'tester') RETURNING batch_id`
  );
  const {
    rows: [{ raw_row_id: rawRowId }],
  } = await adminPool.query(
    `INSERT INTO stg_hr.raw_row (batch_id, row_ref, pid_plaintext, pid_loaded_at, source_data)
     VALUES ($1, 'r1', $2, $3, '{}'::jsonb) RETURNING raw_row_id`,
    [batchId, pidPlaintext, pidLoadedAt]
  );
  return rawRowId;
}

describe('stg-hr-purge (T8 §5.4: "ไม่เก็บ plaintext ใน stg_hr เกิน 30 วัน")', () => {
  test('pid_plaintext ที่โหลดมาเกิน 30 วัน -> ถูกล้างเป็น NULL', async () => {
    const oldLoadedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const rawRowId = await insertRawRow({ pidPlaintext: '1234567890123', pidLoadedAt: oldLoadedAt });

    const result = await runStgHrPurge({ pool });
    expect(result.purgedCount).toBeGreaterThanOrEqual(1);

    const { rows } = await adminPool.query(`SELECT pid_plaintext FROM stg_hr.raw_row WHERE raw_row_id = $1`, [
      rawRowId,
    ]);
    expect(rows[0].pid_plaintext).toBeNull();
  });

  test('pid_plaintext ที่เพิ่งโหลด (ยังไม่ถึง 30 วัน) -> ไม่ถูกแตะ', async () => {
    const recentLoadedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const rawRowId = await insertRawRow({ pidPlaintext: '1234567890123', pidLoadedAt: recentLoadedAt });

    await runStgHrPurge({ pool });

    const { rows } = await adminPool.query(`SELECT pid_plaintext FROM stg_hr.raw_row WHERE raw_row_id = $1`, [
      rawRowId,
    ]);
    expect(rows[0].pid_plaintext).toBe('1234567890123');
  });

  test('แถวที่ pid_plaintext เป็น NULL อยู่แล้ว -> ไม่นับใน purgedCount', async () => {
    await insertRawRow({ pidPlaintext: null, pidLoadedAt: null });

    const result = await runStgHrPurge({ pool });
    expect(result.purgedCount).toBe(0);
  });

  test('ปรับ retentionDays เองได้ (เช่น purge ทันทีที่ 0 วัน)', async () => {
    const rawRowId = await insertRawRow({ pidPlaintext: '1234567890123', pidLoadedAt: new Date() });

    await runStgHrPurge({ pool, retentionDays: 0 });

    const { rows } = await adminPool.query(`SELECT pid_plaintext FROM stg_hr.raw_row WHERE raw_row_id = $1`, [
      rawRowId,
    ]);
    expect(rows[0].pid_plaintext).toBeNull();
  });
});
