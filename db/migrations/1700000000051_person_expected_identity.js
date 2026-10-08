/* eslint-disable camelcase */

exports.shorthands = undefined;

// PR-D2: ข้อมูลระบุตัวตนที่ "HR กรอกไว้ล่วงหน้า" ของคนที่ยังไม่เคยยืนยัน ThaID เก็บบน mdm.person (expected_*) ไม่แตะ mdm.person_identity
// (กฎข้อ 2 ของ CLAUDE.md: person_identity เขียนได้จาก POST /sync/thaid เท่านั้น และ handleClaim INSERT แถวนั้นตอน claim ครั้งแรก)
// ThaID เป็นหลักเสมอ: ค่าที่ ThaID ส่งมาเขียนลง person_identity ตอน claim โดยไม่ดูค่า expected_* (ไม่ตรงกันก็เก็บเฉยๆ ไม่แจ้งเตือน)
//
//  1) เพิ่ม expected_birth_date (ชื่อ-นามสกุลที่ HR คาดไว้มี expected_first_name_th / expected_last_name_th อยู่แล้วตั้งแต่ T1)
//  2) field_policy ของ expected_* (วันเกิด = CONFIDENTIAL เหมือน identity.birth_date; ชื่อ = INTERNAL เหมือน identity.*_name_th) required_scope เป็น
//     scope ใหม่ personnel:manage:person (ไม่ผูกกับ field ใน response ของ Person จึงไม่มีผลต่อการ mask ที่มีอยู่)
//  3) trigger กัน UPDATE expected_* เมื่อ "เคยยืนยันแล้ว" (thaid_verified_at หรือ claimed_at ไม่เป็น NULL หรือ status ไม่ใช่ PENDING_CLAIM) -
//     ชั้นป้องกันที่สองต่อจากการตรวจใน API (409 identity-locked): ต่อให้โค้ดอื่นหรือการแข่งกับ /sync/thaid หลุดมา DB ก็ไม่ยอม
//     ทำงานเฉพาะเมื่อค่า expected_* "เปลี่ยนจริง" (UPDATE ฟิลด์อื่นของ person เช่น status/version ตอน claim ไม่ชน) ไม่มีผลกับ INSERT
//     SQLSTATE 'MD001' (กำหนดเอง) ให้ API แยกออกจาก error อื่นได้
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE mdm.person ADD COLUMN expected_birth_date date;`);

  pgm.sql(`
    INSERT INTO mdm.field_policy
      (field_key, table_name, column_name, source, classification, required_scope, editable_by, log_values_in_audit, mask_pattern)
    VALUES
      ('person.expected_first_name_th', 'person', 'expected_first_name_th', 'HR', 'INTERNAL', 'personnel:manage:person', 'HR', true, NULL),
      ('person.expected_last_name_th', 'person', 'expected_last_name_th', 'HR', 'INTERNAL', 'personnel:manage:person', 'HR', true, NULL),
      ('person.expected_birth_date', 'person', 'expected_birth_date', 'HR', 'CONFIDENTIAL', 'personnel:manage:person', 'HR', true, NULL);
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION mdm.guard_expected_identity()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.thaid_verified_at IS NOT NULL OR OLD.claimed_at IS NOT NULL OR OLD.status <> 'PENDING_CLAIM' THEN
        RAISE EXCEPTION 'แก้ข้อมูลระบุตัวตนที่ HR คาดไว้ไม่ได้: บุคคลนี้เคยยืนยันตัวตนผ่าน ThaID แล้ว (หรือไม่ได้อยู่ในสถานะ PENDING_CLAIM)'
          USING ERRCODE = 'MD001';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER person_expected_identity_guard
    BEFORE UPDATE OF expected_first_name_th, expected_last_name_th, expected_birth_date ON mdm.person
    FOR EACH ROW
    WHEN (
      OLD.expected_first_name_th IS DISTINCT FROM NEW.expected_first_name_th
      OR OLD.expected_last_name_th IS DISTINCT FROM NEW.expected_last_name_th
      OR OLD.expected_birth_date IS DISTINCT FROM NEW.expected_birth_date
    )
    EXECUTE FUNCTION mdm.guard_expected_identity();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS person_expected_identity_guard ON mdm.person;`);
  pgm.sql(`DROP FUNCTION IF EXISTS mdm.guard_expected_identity();`);
  pgm.sql(`DELETE FROM mdm.field_policy WHERE field_key IN ('person.expected_first_name_th', 'person.expected_last_name_th', 'person.expected_birth_date');`);
  pgm.sql(`ALTER TABLE mdm.person DROP COLUMN expected_birth_date;`);
};
