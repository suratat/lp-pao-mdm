// สร้าง partition รายเดือนของ audit.access_log ล่วงหน้า: เดือนปัจจุบัน + MONTHS_AHEAD เดือนถัดไป (ค่าเริ่มต้น 3 -> 4 partition)
// เรียก audit.ensure_access_log_partition (migration 1700000000044: SECURITY DEFINER, EXECUTE เฉพาะ mdm_worker) - เรียกซ้ำได้ทุกวัน
//
// ถ้าเดือนไหนไม่มี partition แถว access_log ใหม่จะลง access_log_default เงียบๆ และสร้าง partition เดือนนั้นทีหลังไม่ได้
// (ชนกับแถวใน default) จึงตรวจ default ก่อนเสมอ: มีแถว = log ระดับ error (ยังไม่มีช่องทางแจ้งเตือนอื่นใน worker - ใช้ console.error
// เหมือนที่ index.js ใช้ ข้อความมีแค่จำนวนแถว ไม่มีข้อมูลบุคคล) แล้วทำงานต่อ ไม่ throw เพราะการสร้างเดือนถัดไปยังต้องทำให้เสร็จ
//
// mdm_worker มี SELECT บนตารางแม่ audit.access_log เท่านั้น (ไม่มีสิทธิ์บน access_log_default ตรงๆ) จึงนับผ่านตารางแม่ด้วย tableoid
const DEFAULT_MONTHS_AHEAD = 3;

async function countRowsInDefaultPartition(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit.access_log WHERE tableoid = 'audit.access_log_default'::regclass`
  );
  return rows[0].n;
}

// asOf: เวลาอ้างอิงแทน now() (ใช้ในเทสต์) - null = เวลาปัจจุบันของ DB
async function runAccessLogPartitionEnsure({ pool, monthsAhead = DEFAULT_MONTHS_AHEAD, asOf = null, logger = console }) {
  const strayRows = await countRowsInDefaultPartition(pool);
  if (strayRows > 0) {
    logger.error(
      `audit.access_log_default มี ${strayRows} แถว: มีเดือนที่ไม่มี partition (job นี้ไม่ทำงานหรือหยุดไป) ต้องตรวจและย้ายแถวออกก่อนสร้าง partition เดือนนั้น`
    );
  }

  const { rows } = await pool.query(
    `SELECT to_char(m, 'YYYY_MM') AS month
     FROM (
       SELECT (date_trunc('month', COALESCE($1::timestamptz, now())) + make_interval(months => g))::date AS m
       FROM generate_series(0, $2::int) AS g
     ) months,
     LATERAL (SELECT audit.ensure_access_log_partition(months.m)) ensured
     ORDER BY m`,
    [asOf, monthsAhead]
  );

  return { months: rows.map((r) => r.month), defaultPartitionRows: strayRows };
}

module.exports = { runAccessLogPartitionEnsure, countRowsInDefaultPartition, DEFAULT_MONTHS_AHEAD };
