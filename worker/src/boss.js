const PgBoss = require('pg-boss');

// pg-boss เก็บคิว/schedule ของตัวเองในสคีมา pgboss (เตรียมสิทธิ์ไว้แล้วใน
// db/migrations/..._pgboss_schema.js) เชื่อมด้วย role mdm_worker เดียวกับที่ใช้อ่าน/เขียนข้อมูลธุรกิจ
async function createBoss(connectionString) {
  const boss = new PgBoss({ connectionString });
  await boss.start();
  return boss;
}

module.exports = { createBoss };
