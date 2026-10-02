const { createPools } = require('./pools');
const { runStgHrPurge } = require('../src/jobs/stgHrPurge');
const { makeFakePid } = require('../../api/src/security/pid');

// adminPool: เตรียม fixture (mdm_worker มีสิทธิ์แค่ SELECT/UPDATE รายคอลัมน์ของ stg_hr.raw_row เท่านั้น
// โดยเจตนา - โหลด/ตรวจคุณภาพเป็นงานของ migrate/ ไม่ใช่ worker) pool: connection จริงของ worker
// (mdm_worker) ที่ job function ภายใต้การทดสอบใช้
let adminPool;
let pool;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

// ค่า sentinel ของคอลัมน์ที่ job นี้ "ต้องไม่แตะ" (ล้างในขั้นถัดไปเมื่อ DPO สั่งเท่านั้น) - ไม่ใช่ข้อมูลบุคคลจริง
const UNTOUCHED = {
  expected_first_name_th: 'SENTINEL_FIRST',
  expected_last_name_th: 'SENTINEL_LAST',
  phone_raw: 'SENTINEL_PHONE',
  email_personal_raw: 'sentinel-personal@example.invalid',
  email_work: 'sentinel-work@example.invalid',
  employee_no: 'SENTINEL_EMPNO',
  external_value: 'SENTINEL_EXT',
};
const SOURCE_DATA = { SENTINEL_COL: 'SENTINEL_RAW_VALUE' };

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

async function insertRawRow({ pid = makeFakePid(), pidLoadedAt, loadedAt }) {
  const {
    rows: [{ batch_id: batchId }],
  } = await adminPool.query(
    `INSERT INTO stg_hr.import_batch (source_filename, imported_by) VALUES ('test.csv', 'tester') RETURNING batch_id`
  );
  const {
    rows: [{ raw_row_id: rawRowId }],
  } = await adminPool.query(
    `INSERT INTO stg_hr.raw_row (
       batch_id, row_ref, pid_plaintext, pid_loaded_at, loaded_at,
       expected_first_name_th, expected_last_name_th, phone_raw, email_personal_raw, email_work, employee_no,
       external_value, source_data, quality_errors
     ) VALUES ($1, 'r1', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, '[{"code":"SENTINEL"}]'::jsonb)
     RETURNING raw_row_id`,
    [
      batchId,
      pid,
      pidLoadedAt === undefined ? loadedAt : pidLoadedAt,
      loadedAt,
      UNTOUCHED.expected_first_name_th,
      UNTOUCHED.expected_last_name_th,
      UNTOUCHED.phone_raw,
      UNTOUCHED.email_personal_raw,
      UNTOUCHED.email_work,
      UNTOUCHED.employee_no,
      UNTOUCHED.external_value,
      JSON.stringify(SOURCE_DATA),
    ]
  );
  return rawRowId;
}

async function fetchRow(rawRowId) {
  const { rows } = await adminPool.query(`SELECT * FROM stg_hr.raw_row WHERE raw_row_id = $1`, [rawRowId]);
  return rows[0];
}

describe('stg-hr-purge (T8 §5.4: "ไม่เก็บ plaintext ใน stg_hr เกิน 30 วัน")', () => {
  test('แถวเก่าเกิน 30 วัน -> ล้าง pid_plaintext และ source_data พร้อมกัน และตั้ง source_purged_at', async () => {
    const rawRowId = await insertRawRow({ loadedAt: daysAgo(40) });

    const result = await runStgHrPurge({ pool });
    expect(result.purgedCount).toBe(1);

    const row = await fetchRow(rawRowId);
    expect(row.pid_plaintext).toBeNull();
    expect(row.source_data).toEqual({});
    expect(row.source_purged_at).not.toBeNull();
  });

  test('แถวใหม่ (ยังไม่ถึง 30 วัน) -> ไม่แตะทั้ง pid_plaintext และ source_data', async () => {
    const pid = makeFakePid();
    const rawRowId = await insertRawRow({ pid, loadedAt: daysAgo(5) });

    const result = await runStgHrPurge({ pool });
    expect(result.purgedCount).toBe(0);

    const row = await fetchRow(rawRowId);
    expect(row.pid_plaintext).toBe(pid);
    expect(row.source_data).toEqual(SOURCE_DATA);
    expect(row.source_purged_at).toBeNull();
  });

  test('แถวที่ไม่มี pid (pid_loaded_at เป็น NULL) แต่ source_data ยังมีข้อมูลและเก่าเกิน -> ต้องล้าง source_data', async () => {
    const rawRowId = await insertRawRow({ pid: null, pidLoadedAt: null, loadedAt: daysAgo(40) });

    const result = await runStgHrPurge({ pool });
    expect(result.purgedCount).toBe(1);

    const row = await fetchRow(rawRowId);
    expect(row.pid_plaintext).toBeNull();
    expect(row.source_data).toEqual({});
    expect(row.source_purged_at).not.toBeNull();
  });

  test('แถวที่ pid ถูกล้างไปแล้วแต่ source_data ยังอยู่ (ข้อมูลเก่าก่อนมี migration) -> ล้าง source_data รอบแรก', async () => {
    const rawRowId = await insertRawRow({ pid: null, pidLoadedAt: daysAgo(60), loadedAt: daysAgo(60) });
    expect((await fetchRow(rawRowId)).source_data).toEqual(SOURCE_DATA);

    await runStgHrPurge({ pool });

    expect((await fetchRow(rawRowId)).source_data).toEqual({});
  });

  test('รันซ้ำ -> ไม่นับซ้ำ และไม่เปลี่ยน source_purged_at', async () => {
    const rawRowId = await insertRawRow({ loadedAt: daysAgo(40) });

    expect((await runStgHrPurge({ pool })).purgedCount).toBe(1);
    const firstPurgedAt = (await fetchRow(rawRowId)).source_purged_at;

    expect((await runStgHrPurge({ pool })).purgedCount).toBe(0);
    expect((await fetchRow(rawRowId)).source_purged_at).toEqual(firstPurgedAt);
  });

  test('ไม่แตะคอลัมน์ข้อมูลบุคคลอื่น (ล้างในขั้นถัดไปเมื่อ DPO สั่งเท่านั้น) และ quality_errors', async () => {
    const rawRowId = await insertRawRow({ loadedAt: daysAgo(40) });

    await runStgHrPurge({ pool });

    const row = await fetchRow(rawRowId);
    for (const [column, value] of Object.entries(UNTOUCHED)) {
      expect({ column, value: row[column] }).toEqual({ column, value });
    }
    expect(row.quality_errors).toEqual([{ code: 'SENTINEL' }]);
  });

  test('ปรับ retentionDays เองได้ (เช่น purge ทันทีที่ 0 วัน)', async () => {
    const rawRowId = await insertRawRow({ loadedAt: new Date(Date.now() - 1000) });

    await runStgHrPurge({ pool, retentionDays: 0 });

    const row = await fetchRow(rawRowId);
    expect(row.pid_plaintext).toBeNull();
    expect(row.source_data).toEqual({});
  });
});
