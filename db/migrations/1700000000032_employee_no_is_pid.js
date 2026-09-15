/* eslint-disable camelcase */

exports.shorthands = undefined;

// T8: อบจ.ลำปางไม่มีเลขประจำตัวข้าราชการแยกต่างหาก (ยืนยันจากผู้ใช้ 2026-09-15) - migrate/ tool
// (toImportRow.js) กำหนด employment.employee_no = เลขบัตรประชาชน (pid) เสมอแล้ว ผลคือฟิลด์นี้ต้องถูก
// จัดชั้นความลับเทียบเท่า pid ทุกจุดตามกฎข้อ 1 ของ CLAUDE.md ("ห้าม pid ปรากฏ... ไม่ว่าทางไหน"):
// - classification INTERNAL -> RESTRICTED (เดิมเทียบเท่า personnel_type/org_unit_id ทั่วไป)
// - required_scope personnel:read:basic (scope ต่ำสุดของทุก consumer) -> personnel:read:pid
//   (อนุมัติเป็นราย client โดย DPO เท่านั้น - เดียวกับ pid_hash/pid_enc)
// - log_values_in_audit true -> false (เดิมจะเขียน plaintext pid ลง data_change_log.old_value/new_value)
// - mask_pattern: NULL เหมือน pid_hash/pid_enc (RESTRICTED อื่นๆ ไม่มี partial mask ให้แสดง)
//
// การเปลี่ยนแปลงคู่กัน (ทำพร้อมกันใน PR เดียว ไม่ใช่ migration นี้): docs/design/personnel-mdm-openapi.yaml
// (x-required-scope ของ employeeNo ใน PersonDetail.basic/Employment, ตัดออกจาก ThaidSyncResult.tokenClaims,
// ตัด employeeNo ออกจากการค้นหาด้วย query string), api/src/services/personService.js, syncService.js
exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE mdm.field_policy
     SET classification = 'RESTRICTED',
         required_scope = 'personnel:read:pid',
         log_values_in_audit = false,
         mask_pattern = NULL
     WHERE field_key = 'employment.employee_no'`
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE mdm.field_policy
     SET classification = 'INTERNAL',
         required_scope = 'personnel:read:basic',
         log_values_in_audit = true,
         mask_pattern = NULL
     WHERE field_key = 'employment.employee_no'`
  );
};
