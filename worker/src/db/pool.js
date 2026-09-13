const { Pool, types } = require('pg');

// เหมือน api/src/db/pool.js: คอลัมน์ DATE ต้องไม่ผ่าน JS Date object (จะคลาดเคลื่อนตาม timezone
// เครื่อง - ระบบนี้ deploy จริงที่ +07:00) ให้เป็น string ตรงๆ เพราะ reverify-scan เทียบ
// id_card_expire_date กับ "อีก 60 วัน" ตรงๆ
types.setTypeParser(1082, (value) => value);

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, closePool };
