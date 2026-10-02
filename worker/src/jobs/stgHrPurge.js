// T8 §5.4: "ไม่เก็บ plaintext ใน stg_hr เกิน 30 วัน" - ล้างข้อมูลดิบของแถวที่เก่าเกินกำหนดใน statement เดียว:
//   pid_plaintext -> NULL และ source_data (แถวดิบทั้งแถวจาก CSV ที่มีเลขบัตรซ้ำอยู่) -> '{}'::jsonb
// (ไม่ลบทั้งแถว เพื่อให้ยังใช้อ้างอิง reconciliation ย้อนหลังได้ - ดู migrate/src/reconcile)
//
// เกณฑ์อายุใช้ loaded_at (NOT NULL ทุกแถว) ไม่ใช่ pid_loaded_at เพราะแถวที่ไม่มี pid ก็มี source_data ที่ต้องล้าง
// source_purged_at เป็น marker ว่าล้างแล้ว (รันซ้ำไม่นับซ้ำ) และใช้ partial index raw_row_source_unpurged_idx
//
// ไม่ล้างคอลัมน์ข้อมูลบุคคลอื่น (expected_first_name_th, expected_last_name_th, phone_raw, email_personal_raw ฯลฯ)
// และ quality_errors - รอ DPO สั่งในขั้นถัดไป
//
// mdm_worker (migration 1700000000030 + 1700000000043) มีสิทธิ์รายคอลัมน์เท่านั้น: SELECT (raw_row_id, pid_plaintext,
// pid_loaded_at, loaded_at, source_purged_at), UPDATE (pid_plaintext, source_data, source_purged_at) - อ่าน source_data
// ไม่ได้ และเขียน source_data ได้เฉพาะ '{}' (trigger raw_row_guard_worker_source_data)
const DEFAULT_RETENTION_DAYS = Number(process.env.STG_HR_PID_RETENTION_DAYS) || 30;

async function runStgHrPurge({ pool, retentionDays = DEFAULT_RETENTION_DAYS }) {
  const { rows } = await pool.query(
    `UPDATE stg_hr.raw_row
     SET pid_plaintext = NULL, source_data = '{}'::jsonb, source_purged_at = now()
     WHERE source_purged_at IS NULL
       AND loaded_at < now() - ($1 || ' days')::interval
     RETURNING raw_row_id`,
    [retentionDays]
  );

  return { purgedCount: rows.length };
}

module.exports = { runStgHrPurge, DEFAULT_RETENTION_DAYS };
