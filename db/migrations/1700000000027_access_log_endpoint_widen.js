/* eslint-disable camelcase */

exports.shorthands = undefined;

// พบระหว่างพัฒนา T5: endpoint ที่ต้องส่ง justification ผ่าน query string (เช่น GET /persons/{id}/pid)
// ทำให้ req.originalUrl ที่บันทึกลง audit.access_log.endpoint ยาวเกิน varchar(255) ได้ง่าย (justification
// ยาวได้ถึง 500 ตัวอักษรตาม OpenAPI และภาษาไทย percent-encode แล้วยาวกว่าต้นฉบับ 9 เท่า) ไม่ใช่แค่ปัญหาของ
// test fixture - production จริงจะเจอ INSERT ล้มเหลวทุกครั้งที่ justification ยาวพอสมควร จึงขยายเป็น text
// (ไม่มี index บนคอลัมน์นี้โดยตรง กระทบแค่ storage ไม่กระทบ query pattern ที่ใช้อยู่)
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE audit.access_log ALTER COLUMN endpoint TYPE text;');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE audit.access_log ALTER COLUMN endpoint TYPE varchar(255);');
};
