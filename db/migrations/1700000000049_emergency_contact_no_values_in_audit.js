/* eslint-disable camelcase */

exports.shorthands = undefined;

// PR-D1: ผู้ติดต่อฉุกเฉินเป็นข้อมูลของบุคคลที่สาม (ชื่อ/เบอร์) และถูกลบ/แทนที่ได้ (migration 1700000000025 อนุญาต DELETE เพราะ "ไม่ต้องเก็บ audit
// trail ถาวร") - การลงค่าใน audit.data_change_log (append-only) จะเก็บข้อมูลของบุคคลที่สามถาวร จึงตั้งให้ writer เก็บเฉพาะชื่อฟิลด์ที่เปลี่ยน
// ไม่เก็บค่าเก่า/ใหม่ (changeLogWriter.js อ่าน log_values_in_audit ก่อนเขียนทุกครั้ง)
exports.up = async (pgm) => {
  await pgm.db.query(`UPDATE mdm.field_policy SET log_values_in_audit = false WHERE field_key LIKE 'emergency_contact.%'`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`UPDATE mdm.field_policy SET log_values_in_audit = true WHERE field_key LIKE 'emergency_contact.%'`);
};
