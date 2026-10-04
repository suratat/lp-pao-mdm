/* eslint-disable camelcase */

exports.shorthands = undefined;

// audit.ensure_access_log_partition (migration 1700000000012) ไม่มีใครเรียกหลังติดตั้ง และ worker สร้าง partition เองไม่ได้
// (mdm_worker ไม่มีสิทธิ์ CREATE ใน schema audit และไม่ได้เป็นเจ้าของ audit.access_log) -> ตั้งแต่เดือนที่ไม่มี partition แถวใหม่
// ไหลลง access_log_default เงียบๆ และสร้าง partition เดือนนั้นทีหลังไม่ได้ (ชนกับแถวใน default)
//
// migration นี้:
//  1) ทำฟังก์ชันเป็น SECURITY DEFINER (รันด้วยสิทธิ์เจ้าของฟังก์ชัน = role ที่รัน migration เดียวกับเจ้าของ audit.access_log)
//     พร้อม SET search_path = pg_catalog, audit กัน search_path hijack (ฟังก์ชันอ้าง object แบบ schema-qualified อยู่แล้ว)
//  2) REVOKE EXECUTE จาก PUBLIC แล้ว GRANT ให้ mdm_worker เท่านั้น (group role NOLOGIN จาก migration 0002; LOGIN role จริง
//     mdm_worker_svc ใน infra/postgres/bootstrap-roles.sql เป็นสมาชิกและสืบทอดสิทธิ์นี้ - migration ไม่ผูกกับชื่อ LOGIN role
//     เพราะไม่ได้ถูกสร้างในทุก environment เช่น DB ทดสอบ)
//  3) สร้างล่วงหน้าเดือนปัจจุบัน + 3 เดือน (4 partition) - เรียกซ้ำได้ ไม่ error ถ้ามีอยู่แล้ว (CREATE TABLE IF NOT EXISTS)
//
// partition ใหม่ได้ trigger append-only (access_log_append_only จาก migration 0014) อัตโนมัติจากตารางแม่ (PostgreSQL 11+)
// ข้อควรระวัง: ฟังก์ชันอิงชื่อ partition (access_log_YYYY_MM) ถ้ามี partition ที่สร้างด้วยมือใช้ชื่ออื่นแต่ช่วงเวลาซ้ำกัน
// CREATE จะ error (overlap) - ต้องตรวจก่อน migrate
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit.ensure_access_log_partition(for_month date)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, audit
    AS $$
    DECLARE
      partition_start date := date_trunc('month', for_month)::date;
      partition_end date := (date_trunc('month', for_month) + interval '1 month')::date;
      partition_name text := 'access_log_' || to_char(partition_start, 'YYYY_MM');
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS audit.%I PARTITION OF audit.access_log FOR VALUES FROM (%L) TO (%L);',
        partition_name, partition_start, partition_end
      );
    END;
    $$;
  `);

  pgm.sql(`REVOKE ALL ON FUNCTION audit.ensure_access_log_partition(date) FROM PUBLIC;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION audit.ensure_access_log_partition(date) TO mdm_worker;`);

  pgm.sql(`
    SELECT audit.ensure_access_log_partition((date_trunc('month', now()) + make_interval(months => m))::date)
    FROM generate_series(0, 3) AS m;
  `);
};

// ย้อนกลับเฉพาะฟังก์ชัน/สิทธิ์ให้เหมือนเดิม (SECURITY INVOKER, EXECUTE ให้ PUBLIC) - ไม่ลบ partition ที่สร้างไปแล้ว
// เพราะอาจมีแถว audit อยู่ (ตาราง append-only)
exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit.ensure_access_log_partition(for_month date)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY INVOKER
    RESET ALL
    AS $$
    DECLARE
      partition_start date := date_trunc('month', for_month)::date;
      partition_end date := (date_trunc('month', for_month) + interval '1 month')::date;
      partition_name text := 'access_log_' || to_char(partition_start, 'YYYY_MM');
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS audit.%I PARTITION OF audit.access_log FOR VALUES FROM (%L) TO (%L);',
        partition_name, partition_start, partition_end
      );
    END;
    $$;
  `);
  pgm.sql(`REVOKE ALL ON FUNCTION audit.ensure_access_log_partition(date) FROM mdm_worker;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION audit.ensure_access_log_partition(date) TO PUBLIC;`);
};
