const { Pool } = require('pg');
const { MIGRATOR_DATABASE_URL, DATABASE_URL } = require('./config');

// adminPool: ใช้เตรียม fixture เท่านั้น (เช่น insert webhook_subscription ซึ่ง mdm_worker ไม่มีสิทธิ์
// เขียนโดยเจตนา - เป็นงานของ POST /webhooks/subscriptions ใน T5) workerPool: connection จริงที่ใช้
// เรียกฟังก์ชัน job ภายใต้การทดสอบ เพื่อยืนยันว่าทำงานได้จริงภายใต้สิทธิ์ mdm_worker เท่านั้น
function createPools() {
  return {
    adminPool: new Pool({ connectionString: MIGRATOR_DATABASE_URL }),
    workerPool: new Pool({ connectionString: DATABASE_URL }),
  };
}

module.exports = { createPools };
