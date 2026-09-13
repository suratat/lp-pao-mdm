const { Pool } = require('pg');

let pool = null;

// สร้าง Pool เดียวใช้ร่วมกันทั้งแอป เชื่อมด้วย role mdm_app (สิทธิ์ตาม db/migrations/..._grants.js ของ T1)
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
