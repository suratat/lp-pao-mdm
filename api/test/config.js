// ใช้ container/DB เดียวกับ T1 (db/docker-compose.yml + db/migrations) ไม่ทำ compose แยกซ้ำ
const MIGRATOR_DATABASE_URL = 'postgres://mdm_migrator:mdm_migrator_dev_only@localhost:55432/mdm_test';

// mdm_app ที่ T1 สร้างเป็น NOLOGIN role (กลุ่มสิทธิ์) - login user จริงเป็นงานจัดเตรียมของ T6 (infra)
// ที่นี่สร้าง login user ชั่วคราวสำหรับทดสอบเท่านั้น เป็นสมาชิกของ mdm_app (ดู globalSetup.js)
const DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://mdm_api_test:mdm_api_test_dev_only@localhost:55432/mdm_test';

module.exports = { MIGRATOR_DATABASE_URL, DATABASE_URL };
