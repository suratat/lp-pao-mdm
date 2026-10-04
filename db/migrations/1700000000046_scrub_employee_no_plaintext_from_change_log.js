/* eslint-disable camelcase */

exports.shorthands = undefined;

// ข้อยกเว้นกฎ append-only ของ schema audit "ครั้งเดียว" (กฎข้อ 4 ของ CLAUDE.md)
//
// เหตุผล: employment.employee_no = เลขบัตรประชาชน (pid) เสมอ และ field_policy ตั้ง log_values_in_audit = false
// (migration 1700000000032) แต่โค้ดเขียน data_change_log เดิมไม่เคยอ่านค่านี้ จึงมี pid plaintext ค้างอยู่ใน
// old_value/new_value ซึ่งขัดกฎข้อ 1 (ห้าม pid ปรากฏนอก pid_hash/pid_enc) โค้ดใหม่ (changeLogWriter.js) หยุดการเขียนแล้ว
// migration นี้ล้างค่าที่เขียนไปแล้ว
//
// วันที่: 2026-10-04
// อนุมัติโดย: suratat (เจ้าของระบบ)
// จำนวนแถวที่คาดไว้: 2 (นับบน prod ก่อนเขียน migration นี้: field_name = 'employment.employee_no' ที่มีค่า 2 แถว,
//   reason ที่มีเลข 13 หลัก 0 แถว)
//
// ขอบเขต: SET old_value = NULL, new_value = NULL เฉพาะ field_name = 'employment.employee_no' เท่านั้น
// ปิด trigger data_change_log_append_only เฉพาะใน transaction ของ migration นี้ (node-pg-migrate ห่อทั้งไฟล์ด้วย transaction
// เดียว) แล้วเปิดคืนทันทีหลัง UPDATE - ต้องรันด้วย role เจ้าของตาราง (ALTER TABLE ... DISABLE TRIGGER ต้องเป็นเจ้าของ)
// จำนวนแถวที่ UPDATE ไม่ตรงกับที่นับได้ใน migration เดียวกัน = RAISE NOTICE (ไม่ fail)
//
// down: ย้อนไม่ได้ (ค่าเดิมถูกล้างถาวรโดยตั้งใจ) จึงไม่ทำอะไร
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      expected_rows bigint;
      updated_rows bigint;
    BEGIN
      SELECT count(*) INTO expected_rows
      FROM audit.data_change_log
      WHERE field_name = 'employment.employee_no' AND (old_value IS NOT NULL OR new_value IS NOT NULL);

      ALTER TABLE audit.data_change_log DISABLE TRIGGER data_change_log_append_only;

      UPDATE audit.data_change_log
      SET old_value = NULL, new_value = NULL
      WHERE field_name = 'employment.employee_no' AND (old_value IS NOT NULL OR new_value IS NOT NULL);
      GET DIAGNOSTICS updated_rows = ROW_COUNT;

      ALTER TABLE audit.data_change_log ENABLE TRIGGER data_change_log_append_only;

      RAISE NOTICE 'scrub employment.employee_no ใน data_change_log: นับได้ % แถว, UPDATE % แถว (ที่คาดไว้บน prod: 2)', expected_rows, updated_rows;
      IF expected_rows <> updated_rows THEN
        RAISE NOTICE 'จำนวนแถวที่ UPDATE (%) ไม่ตรงกับที่นับได้ก่อนหน้า (%)', updated_rows, expected_rows;
      END IF;
    END
    $$;
  `);
};

exports.down = () => {};
