/* eslint-disable camelcase */

exports.shorthands = undefined;

// ชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ) ของบุคลากรที่ไม่มีเลขที่ตำแหน่งตามอัตรากำลัง (พนักงานจ้าง/จ้างเหมาบริการรายบุคคล/
// ผู้ดำรงตำแหน่งทางการเมือง) และประเภท OTHER - เก็บเป็นคอลัมน์แยกบน mdm.employment ไม่ยัดลง position_id/position_no
// (position เป็น master data ที่อ้างด้วย FK) ผูกกับ history ของ employment โดยตรง: แก้ข้อความ = ปิดแถวเก่า/เปิดแถวใหม่
// (closeAndOpenEmployment) + data_change_log + outbox_event ใน transaction เดียว
//
// ไม่มี CHECK ระดับ DB สำหรับกฎ "ประเภทที่ต้องมีตำแหน่งห้ามมีข้อความนี้" / "OTHER เลือกอย่างใดอย่างหนึ่ง" เพราะกฎอ้างอิงประเภทบุคลากร
// ซึ่งเป็นตารางอ้างอิง (mdm.personnel_type) - บังคับที่ API (api/src/services/jobTitleText.js) ทางผ่านเดียวกับกฎเลขที่ตำแหน่ง
// การตัด control/bidi + ปฏิเสธเลขบัตร 13 หลักก็ทำที่ API เช่นกัน (DB ตรวจได้เฉพาะความยาว)
const FIELD_KEY = 'employment.job_title_text';

exports.up = async (pgm) => {
  pgm.addColumn({ schema: 'mdm', name: 'employment' }, { job_title_text: { type: 'varchar(255)' } });

  await pgm.db.query(
    `INSERT INTO mdm.field_policy
       (field_key, table_name, column_name, source, classification, required_scope, editable_by, log_values_in_audit, mask_pattern)
     VALUES ($1, 'employment', 'job_title_text', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, NULL)`,
    [FIELD_KEY]
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(`DELETE FROM mdm.field_policy WHERE field_key = $1`, [FIELD_KEY]);
  pgm.dropColumn({ schema: 'mdm', name: 'employment' }, 'job_title_text');
};
