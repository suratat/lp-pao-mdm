/* eslint-disable camelcase */

exports.shorthands = undefined;

// seed mdm.field_policy จากตาราง §0.4 (เจ้าของข้อมูล/ชั้นความลับ) และ §2.2 (scope -> กลุ่มฟิลด์)
// field_key รูปแบบ "<กลุ่มโดเมน>.<คอลัมน์>" ตามตัวอย่างใน ER ("identity.birth_date")
const ROWS = [
  // --- personnel:read:basic ---
  ['person.person_id', 'person', 'person_id', 'SYSTEM', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.title_th', 'person_identity', 'title_th', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.first_name_th', 'person_identity', 'first_name_th', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.middle_name_th', 'person_identity', 'middle_name_th', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.last_name_th', 'person_identity', 'last_name_th', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.title_en', 'person_identity', 'title_en', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.first_name_en', 'person_identity', 'first_name_en', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['identity.last_name_en', 'person_identity', 'last_name_en', 'THAID', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['employment.employee_no', 'employment', 'employee_no', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, null],
  ['employment.personnel_type', 'employment', 'personnel_type', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, null],
  ['employment.position_id', 'employment', 'position_id', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, null],
  ['employment.org_unit_id', 'employment', 'org_unit_id', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, null],
  ['employment.level_code', 'employment', 'level_code', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, null],
  ['employment.email_work', 'employment', 'email_work', 'HR', 'INTERNAL', 'personnel:read:basic', 'HR', true, null],
  ['person.status', 'person', 'status', 'SYSTEM', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['person.verification_status', 'person', 'verification_status', 'SYSTEM', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],
  ['person.version', 'person', 'version', 'SYSTEM', 'INTERNAL', 'personnel:read:basic', 'NONE', true, null],

  // --- personnel:read:contact ---
  ['contact.mobile_phone', 'person_contact', 'mobile_phone', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, '08x-xxx-1234'],
  ['contact.phone_alt', 'person_contact', 'phone_alt', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, '08x-xxx-1234'],
  ['contact.email_personal', 'person_contact', 'email_personal', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['contact.line_id', 'person_contact', 'line_id', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['contact.cur_address_text', 'person_contact', 'cur_address_text', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['contact.cur_subdistrict_code', 'person_contact', 'cur_subdistrict_code', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['contact.cur_district_code', 'person_contact', 'cur_district_code', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['contact.cur_province_code', 'person_contact', 'cur_province_code', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['contact.cur_postcode', 'person_contact', 'cur_postcode', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['emergency_contact.full_name', 'emergency_contact', 'full_name', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['emergency_contact.relationship', 'emergency_contact', 'relationship', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, null],
  ['emergency_contact.phone', 'emergency_contact', 'phone', 'SELF', 'CONFIDENTIAL', 'personnel:read:contact', 'SELF', true, '08x-xxx-1234'],

  // --- personnel:read:identity ---
  ['identity.birth_date', 'person_identity', 'birth_date', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.gender', 'person_identity', 'gender', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.reg_address_text', 'person_identity', 'reg_address_text', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.reg_subdistrict_code', 'person_identity', 'reg_subdistrict_code', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.reg_district_code', 'person_identity', 'reg_district_code', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.reg_province_code', 'person_identity', 'reg_province_code', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.id_card_issue_date', 'person_identity', 'id_card_issue_date', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.id_card_expire_date', 'person_identity', 'id_card_expire_date', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.ial', 'person_identity', 'ial', 'THAID', 'CONFIDENTIAL', 'personnel:read:identity', 'NONE', true, null],
  ['identity.synced_at', 'person_identity', 'synced_at', 'SYSTEM', 'INTERNAL', 'personnel:read:identity', 'NONE', true, null],

  // --- personnel:read:employment ---
  ['employment.appointed_date', 'employment', 'appointed_date', 'HR', 'CONFIDENTIAL', 'personnel:read:employment', 'HR', true, null],
  ['employment.separation_date', 'employment', 'separation_date', 'HR', 'CONFIDENTIAL', 'personnel:read:employment', 'HR', true, null],
  ['employment.separation_reason', 'employment', 'separation_reason', 'HR', 'CONFIDENTIAL', 'personnel:read:employment', 'HR', true, null],

  // --- personnel:read:photo ---
  ['photo.image_enc', 'person_photo', 'image_enc', 'THAID', 'CONFIDENTIAL', 'personnel:read:photo', 'NONE', false, null],

  // --- personnel:read:pid / personnel:lookup:pid (ภาคผนวก ข) ---
  ['person.pid_hash', 'person', 'pid_hash', 'THAID', 'RESTRICTED', 'personnel:read:pid', 'NONE', false, null],
  ['person.pid_enc', 'person', 'pid_enc', 'THAID', 'RESTRICTED', 'personnel:read:pid', 'NONE', false, null],
];

exports.up = async (pgm) => {
  for (const row of ROWS) {
    await pgm.db.query(
      `INSERT INTO mdm.field_policy
        (field_key, table_name, column_name, source, classification, required_scope, editable_by, log_values_in_audit, mask_pattern)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      row
    );
  }
};

exports.down = async (pgm) => {
  const keys = ROWS.map(([field_key]) => field_key);
  await pgm.db.query(`DELETE FROM mdm.field_policy WHERE field_key = ANY($1::text[])`, [keys]);
};
