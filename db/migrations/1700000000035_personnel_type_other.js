/* eslint-disable camelcase */

exports.shorthands = undefined;

// เพิ่มโค้ด personnel_type ใหม่ OTHER (อื่นๆ - บุคลากรที่ไม่เข้ากลุ่มใดใน 8 ประเภทที่มีอยู่ ไม่มีเลขที่
// ตำแหน่งทางการ เหมือนกลุ่มพนักงานจ้าง/จ้างเหมาบริการรายบุคคล) ตาม decision ของผู้ใช้ (2026-09-17)
// ไม่ต้องแก้ mdm.employment.position_id เพิ่มเติม (nullable อยู่แล้วทั้งคอลัมน์ตั้งแต่ migration
// 1700000000031_employment_optional_position.js - ไม่ได้ผูกกับ personnel_type รายตัว) การยกเว้นกฎ
// POSITION_NOT_FOUND สำหรับ OTHER อยู่ที่ migrate/src/quality/rules.js (POSITION_OPTIONAL_TYPES)
exports.up = (pgm) => {
  pgm.sql(`INSERT INTO mdm.personnel_type (code, name_th) VALUES ('OTHER', 'อื่นๆ');`);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM mdm.personnel_type WHERE code = 'OTHER';`);
};
