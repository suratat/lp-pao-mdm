/* eslint-disable camelcase */

exports.shorthands = undefined;

// ข้อยกเว้นกฎ append-only ของ schema audit "ครั้งเดียว" (กฎข้อ 4 ของ CLAUDE.md) - แบบเดียวกับ migration 1700000000046
//
// เหตุผล: แถวเก่าของ audit.access_log เก็บ req.originalUrl ลงคอลัมน์ endpoint ทั้งก้อน รวม query string (เช่น ?q=<ชื่อคน>,
// ?pidFormat=masked) ซึ่งไม่ควรถูกเก็บถาวร (กฎข้อ 1: ห้ามค่าอ่อนไหวใน URL/query string ที่ถูกบันทึก) โค้ดใหม่หยุดเขียน query string แล้วตั้งแต่ PR #87
// (access_log.endpoint = path เท่านั้น) migration นี้ตัด query string ของแถวที่เขียนไปก่อนหน้านั้น
//
// ผลนับบน prod ก่อนเขียน migration นี้ (2026-10-10, รันเป็น mdm_migrator):
//   - แถวที่ endpoint มี '?' = 2,848 แถว (partition 2026_09: 1, 2026_10: 2,847)
//   - แยกเป็น search (/persons?...) 2,716 / other 132 / pid-reveal (/persons/<uuid>/pid?justification=) 0
//   - แถวที่ endpoint ตรง [0-9]{13} = 0
//   - แถวล่าสุดที่มี '?' = 2026-10-09 15:02:48 UTC (ก่อน deploy #87)
//   - เจ้าของตารางแม่และทุก partition = mdm_migrator
//
// วันที่: 2026-10-10
// อนุมัติโดย suratat 2026-10-10
//
// ขอบเขต: UPDATE audit.access_log SET endpoint = split_part(endpoint, '?', 1) เฉพาะแถวที่ endpoint LIKE '%?%' - ไม่แตะคอลัมน์อื่น
// (accessed_at / access_id จึงไม่เปลี่ยน, ไม่ย้าย partition, pid_access_review ที่อ้าง (access_id, accessed_at) ไม่กระทบ)
//
// ความปลอดภัย (ทั้งหมดอยู่ใน transaction เดียว - node-pg-migrate ห่อทั้งไฟล์ - ถ้า RAISE EXCEPTION ทุกอย่างย้อนกลับ รวม trigger):
//   1) ต้องรันด้วย role ที่เป็นเจ้าของตารางแม่และ "ทุก partition" (DISABLE TRIGGER ต้องเป็นเจ้าของ) ไม่ใช่ -> RAISE EXCEPTION ก่อนแก้อะไร
//   2) ปิด trigger access_log_append_only (บนตารางแม่ ซึ่งลงไปทุก partition) ก่อนนับ: คำสั่งนี้ขอ lock ที่กัน INSERT เข้า access_log
//      จึงไม่มีแถวใหม่แทรกระหว่างนับกับแก้ (นับก่อนปิดก็ได้ผลเท่ากันแต่เสี่ยงจำนวนไม่ตรง - ถ้าไม่ตรงก็ย้อนกลับทั้งหมดอยู่ดี)
//   3) จำนวนที่ UPDATE ต้องเท่ากับจำนวนที่นับ ไม่เท่า -> RAISE EXCEPTION
//   4) เปิด trigger คืนแล้วตรวจว่า tgenabled = 'O' ทั้งตารางแม่และทุก partition ไม่ใช่ -> RAISE EXCEPTION
//   5) REVOKE UPDATE/DELETE ของ mdm_app/mdm_worker (migration 015) ไม่ถูกแตะ - migration นี้ใช้สิทธิ์เจ้าของตารางเท่านั้น
// RAISE NOTICE สรุปจำนวน (node-pg-migrate ไม่แสดง) -> ตรวจผลด้วย query ท้ายคำอธิบายใน PR / CLAUDE.md Status Log
//
// down: ย้อนไม่ได้ (query string ถูกล้างถาวรโดยตั้งใจ) จึงไม่ทำอะไร เหมือน 046 - ไม่ throw เพราะ migrate-roundtrip.test.js
// และ changeLogScrub.test.js down ทุก migration เพื่อสร้างสถานะทดสอบ
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      not_owned text;
      expected_rows bigint;
      updated_rows bigint;
      bad_triggers text;
    BEGIN
      SELECT string_agg(t.relid::regclass::text, ', ') INTO not_owned
      FROM pg_partition_tree('audit.access_log'::regclass) t
      JOIN pg_class c ON c.oid = t.relid
      WHERE pg_get_userbyid(c.relowner) <> current_user;
      IF not_owned IS NOT NULL THEN
        RAISE EXCEPTION 'current_user (%) ไม่ได้เป็นเจ้าของ: % - ต้องรัน migration นี้ด้วย role เจ้าของตารางแม่และทุก partition', current_user, not_owned;
      END IF;

      ALTER TABLE audit.access_log DISABLE TRIGGER access_log_append_only;

      SELECT count(*) INTO expected_rows FROM audit.access_log WHERE endpoint LIKE '%?%';

      UPDATE audit.access_log SET endpoint = split_part(endpoint, '?', 1) WHERE endpoint LIKE '%?%';
      GET DIAGNOSTICS updated_rows = ROW_COUNT;

      ALTER TABLE audit.access_log ENABLE TRIGGER access_log_append_only;

      IF updated_rows <> expected_rows THEN
        RAISE EXCEPTION 'จำนวนแถวที่ UPDATE (%) ไม่ตรงกับที่นับได้ (%) - ย้อนกลับทั้งหมด', updated_rows, expected_rows;
      END IF;

      SELECT string_agg(t.relid::regclass::text, ', ') INTO bad_triggers
      FROM pg_partition_tree('audit.access_log'::regclass) t
      LEFT JOIN pg_trigger g ON g.tgrelid = t.relid AND g.tgname = 'access_log_append_only'
      WHERE g.oid IS NULL OR g.tgenabled <> 'O';
      IF bad_triggers IS NOT NULL THEN
        RAISE EXCEPTION 'trigger access_log_append_only ไม่ได้เปิดที่: % - ย้อนกลับทั้งหมด', bad_triggers;
      END IF;

      RAISE NOTICE 'strip query string ใน access_log.endpoint: นับได้ % แถว, UPDATE % แถว (ที่คาดไว้บน prod: 2848)', expected_rows, updated_rows;
    END
    $$;
  `);
};

exports.down = () => {};
