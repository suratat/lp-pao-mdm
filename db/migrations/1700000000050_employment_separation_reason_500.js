/* eslint-disable camelcase */

exports.shorthands = undefined;

// PR-D1: POST /persons/{id}/deactivate เก็บ reason (maxLength 500 ตาม OpenAPI) ลง employment.separation_reason ซึ่งเป็น varchar(255) -
// เหตุผลยาว 256-500 ตัวอักษรทำให้ INSERT/UPDATE ล้มเป็น 500 (พบตอนเขียนเทสต์ขอบ 500 ตัวอักษร) ขยายเป็น varchar(500) ให้ตรงกับสัญญา API
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE mdm.employment ALTER COLUMN separation_reason TYPE varchar(500);`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE mdm.employment ALTER COLUMN separation_reason TYPE varchar(255);`);
};
