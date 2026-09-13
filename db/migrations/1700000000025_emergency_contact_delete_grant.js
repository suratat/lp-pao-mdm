/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา T5: PUT /me/emergency-contacts มีความหมายว่า "แทนที่ทั้งรายการ" (สูงสุด 3 รายการ)
// แต่ mdm_app ไม่มีสิทธิ์ DELETE บนตารางใดใน schema mdm เลย (T1 ให้ตามหลัก soft-delete สำหรับข้อมูลหลัก
// ของบุคคล) emergency_contact ไม่ใช่ข้อมูลหลักที่ต้องเก็บ audit trail ตลอดไปแบบ person/employment/identity
// - เป็น list ขนาดคงที่ที่ผู้ใช้แทนที่เองได้เต็มรูปแบบ จึงให้สิทธิ์ DELETE เฉพาะตารางนี้ตารางเดียว
exports.up = (pgm) => {
  pgm.sql(`GRANT DELETE ON mdm.emergency_contact TO mdm_app;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE DELETE ON mdm.emergency_contact FROM mdm_app;`);
};
