const crypto = require('node:crypto');
const { createPools } = require('./pools');
const { runAccessLogPartitionEnsure, DEFAULT_MONTHS_AHEAD } = require('../src/jobs/accessLogPartitionEnsure');

// job access-log-partition-ensure รันด้วย connection ของ mdm_worker จริง (workerPool) เพื่อพิสูจน์ว่าสร้าง partition ได้ภายใต้สิทธิ์ของ worker
let adminPool;
let pool;
const FUTURE_AS_OF = '2031-03-15T12:00:00Z';
const FUTURE_MONTHS = ['2031_03', '2031_04', '2031_05', '2031_06'];

// access_log_default: trigger append-only เป็น row-level (BEFORE UPDATE OR DELETE) จึงไม่ถูกยิงตอน TRUNCATE - เก็บกวาดแถวทดสอบได้ด้วย adminPool
// (ทำทั้งก่อนและหลัง เพื่อไม่พึ่งลำดับเทสต์หรือสถานะที่ค้างจากรอบก่อนที่ DB ไม่ถูกลบ) ใช้ได้เพราะ DB ทดสอบ (localhost:55432) เป็นของเทสต์เท่านั้น
const cleanDefaultPartition = () => adminPool.query('TRUNCATE audit.access_log_default');

beforeAll(async () => {
  ({ adminPool, workerPool: pool } = createPools());
  await cleanDefaultPartition();
});

afterAll(async () => {
  await cleanDefaultPartition();
  for (const month of FUTURE_MONTHS) await adminPool.query(`DROP TABLE IF EXISTS audit.access_log_${month}`);
  await adminPool.end();
  await pool.end();
});

const silentLogger = () => ({ error: jest.fn() });

const partitionNames = async () =>
  (
    await adminPool.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'audit.access_log'::regclass`
    )
  ).rows.map((r) => r.relname);

describe('job access-log-partition-ensure', () => {
  test('ค่าเริ่มต้น: เดือนปัจจุบัน + 3 เดือนล่วงหน้า (4 partition) และไม่ log error เมื่อ default ว่าง', async () => {
    const logger = silentLogger();
    const { months, defaultPartitionRows } = await runAccessLogPartitionEnsure({ pool, logger });

    expect(DEFAULT_MONTHS_AHEAD).toBe(3);
    expect(months).toHaveLength(4);
    const { rows } = await adminPool.query(
      `SELECT to_char(date_trunc('month', now()) + make_interval(months => m), 'YYYY_MM') AS month FROM generate_series(0, 3) m ORDER BY m`
    );
    expect(months).toEqual(rows.map((r) => r.month));
    const existing = await partitionNames();
    for (const month of months) expect(existing).toContain(`access_log_${month}`);
    expect(defaultPartitionRows).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('สร้างครบ 3 เดือนถัดจากเดือนอ้างอิง (+ เดือนอ้างอิงเอง) ด้วยสิทธิ์ mdm_worker', async () => {
    const canCreate = await adminPool.query(`SELECT has_schema_privilege('mdm_worker', 'audit', 'CREATE') AS ok`);
    expect(canCreate.rows[0].ok).toBe(false);

    const { months } = await runAccessLogPartitionEnsure({ pool, asOf: FUTURE_AS_OF, logger: silentLogger() });
    expect(months).toEqual(FUTURE_MONTHS);
    const existing = await partitionNames();
    for (const month of FUTURE_MONTHS) expect(existing).toContain(`access_log_${month}`);
  });

  test('รันซ้ำได้ (idempotent) ผลเหมือนเดิมและไม่เกิด partition ซ้ำ', async () => {
    const before = (await partitionNames()).sort();
    const first = await runAccessLogPartitionEnsure({ pool, asOf: FUTURE_AS_OF, logger: silentLogger() });
    const second = await runAccessLogPartitionEnsure({ pool, asOf: FUTURE_AS_OF, logger: silentLogger() });
    expect(second.months).toEqual(first.months);
    expect((await partitionNames()).sort()).toEqual(before);
  });

  test('monthsAhead ปรับได้', async () => {
    const { months } = await runAccessLogPartitionEnsure({ pool, asOf: FUTURE_AS_OF, monthsAhead: 1, logger: silentLogger() });
    expect(months).toEqual(['2031_03', '2031_04']);
  });

    // แถวใน default ลบด้วย DELETE ไม่ได้ (append-only) - เก็บกวาดด้วย TRUNCATE ใน afterAll (ไม่พึ่งลำดับเทสต์)
  test('ถ้า access_log_default มีแถว -> log error (มีจำนวนแถว ไม่มีข้อมูลบุคคล) แต่ยังสร้างเดือนถัดไปให้ครบ ไม่ throw', async () => {
    const {
      rows: [{ person_id: personId }],
    } = await adminPool.query(`INSERT INTO mdm.person (pid_hash) VALUES ($1) RETURNING person_id`, [crypto.randomBytes(32).toString('hex')]);
    await adminPool.query(
      `INSERT INTO audit.access_log (accessed_at, subject_person_id, actor_type, endpoint, http_method)
       VALUES ('2001-01-15 00:00:00+00', $1, 'SERVICE', '/persons/x', 'GET')`,
      [personId]
    );

    const logger = silentLogger();
    const result = await runAccessLogPartitionEnsure({ pool, asOf: FUTURE_AS_OF, logger });

    expect(result.defaultPartitionRows).toBeGreaterThanOrEqual(1);
    expect(result.months).toEqual(FUTURE_MONTHS);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = logger.error.mock.calls[0][0];
    expect(message).toContain('access_log_default');
    expect(message).toContain(String(result.defaultPartitionRows));
    expect(message).not.toContain(personId);
  });
});
