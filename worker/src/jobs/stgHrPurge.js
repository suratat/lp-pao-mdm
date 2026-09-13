// T8 §5.4: "ไม่เก็บ plaintext ใน stg_hr เกิน 30 วัน" - ล้างเฉพาะคอลัมน์ pid_plaintext เป็น NULL
// (ไม่ลบทั้งแถว เพื่อให้ยังใช้อ้างอิง employee_no/reconciliation ย้อนหลังได้ - ดู migrate/src/reconcile)
// mdm_worker (T1/T8 grant) มีสิทธิ์แค่ SELECT/UPDATE คอลัมน์ pid_plaintext, pid_loaded_at ของตารางนี้เท่านั้น
const DEFAULT_RETENTION_DAYS = Number(process.env.STG_HR_PID_RETENTION_DAYS) || 30;

async function runStgHrPurge({ pool, retentionDays = DEFAULT_RETENTION_DAYS }) {
  const { rows } = await pool.query(
    `UPDATE stg_hr.raw_row
     SET pid_plaintext = NULL
     WHERE pid_plaintext IS NOT NULL
       AND pid_loaded_at < now() - ($1 || ' days')::interval
     RETURNING raw_row_id`,
    [retentionDays]
  );

  return { purgedCount: rows.length };
}

module.exports = { runStgHrPurge, DEFAULT_RETENTION_DAYS };
