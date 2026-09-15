const { Pool } = require('pg');
const { DATABASE_URL, MIGRATOR_DATABASE_URL } = require('./config');
const { loadBatch } = require('../src/loader/loadBatch');
const { buildCsv, validRow, defaultColumnMap } = require('./fixtures');

let pool;
let adminPool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

describe('loadBatch (§5.3 ระยะ 1: "export ระบบเดิม -> schema stg_hr")', () => {
  test('โหลด CSV เข้า stg_hr ครบทุกแถว พร้อม pid_plaintext และ pid_loaded_at', async () => {
    const rows = [validRow(), validRow()];
    const csv = buildCsv(rows);

    const { batchId, rowCount } = await loadBatch(pool, {
      csvContent: csv,
      columnMap: defaultColumnMap,
      sourceFilename: 'test.csv',
      importedBy: 'tester',
    });

    expect(rowCount).toBe(2);

    const { rows: batch } = await adminPool.query(`SELECT status, source_system FROM stg_hr.import_batch WHERE batch_id = $1`, [
      batchId,
    ]);
    expect(batch[0].status).toBe('LOADED');
    expect(batch[0].source_system).toBe('LHR');

    const { rows: rawRows } = await adminPool.query(
      `SELECT pid_plaintext, pid_loaded_at, employee_no, org_unit_code, source_data FROM stg_hr.raw_row WHERE batch_id = $1 ORDER BY row_ref`,
      [batchId]
    );
    expect(rawRows).toHaveLength(2);
    expect(rawRows[0].pid_plaintext).toBe(rows[0].pid);
    expect(rawRows[0].pid_loaded_at).not.toBeNull();
    // ไม่มี mapping ของ employeeNo อีกต่อไป (column-map.json) - คอลัมน์นี้ต้องเป็น NULL เสมอหลังโหลด
    // (employeeNo ถูกกำหนดเป็น pid_plaintext ตอนแปลงเป็น EmploymentImportRow ใน toImportRow.js แทน)
    expect(rawRows[0].employee_no).toBeNull();
    expect(rawRows[0].org_unit_code).toBe('PERSONNEL-ADMIN');
    expect(rawRows[0].source_data).toBeTruthy();
  });

  test('แถวที่ไม่มี pid -> pid_plaintext และ pid_loaded_at เป็น null', async () => {
    const row = validRow({ pid: '' });
    const csv = buildCsv([row]);

    const { batchId } = await loadBatch(pool, {
      csvContent: csv,
      columnMap: defaultColumnMap,
      sourceFilename: 'no-pid.csv',
      importedBy: 'tester',
    });

    const { rows: rawRows } = await adminPool.query(
      `SELECT pid_plaintext, pid_loaded_at FROM stg_hr.raw_row WHERE batch_id = $1`,
      [batchId]
    );
    expect(rawRows[0].pid_plaintext).toBeNull();
    expect(rawRows[0].pid_loaded_at).toBeNull();
  });
});
