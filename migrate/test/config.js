// ใช้ container/DB เดียวกับ T1 (db/docker-compose.yml + db/migrations) ไม่ทำ compose แยกซ้ำ
const MIGRATOR_DATABASE_URL = 'postgres://mdm_migrator:mdm_migrator_dev_only@localhost:55432/mdm_test';

// mdm_migrate (T8) เป็น NOLOGIN role - สร้าง login user ชั่วคราวสำหรับทดสอบเป็นสมาชิกของมัน
const DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://mdm_migrate_test:mdm_migrate_test_dev_only@localhost:55432/mdm_test';

module.exports = { MIGRATOR_DATABASE_URL, DATABASE_URL };
