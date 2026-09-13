// ค่าเชื่อมต่อฐานข้อมูลสำหรับทดสอบเท่านั้น (ตรงกับ db/docker-compose.yml) ไม่ใช่ secret จริง
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://mdm_migrator:mdm_migrator_dev_only@localhost:55432/mdm_test';

module.exports = { DATABASE_URL };
