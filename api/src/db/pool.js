const { Pool, types } = require('pg');

// pg แปลงคอลัมน์ type DATE (OID 1082) เป็น JS Date ที่เวลาเที่ยงคืนตาม "เวลาเครื่อง" โดยปริยาย - เมื่อแปลง
// กลับด้วย .toISOString() (ซึ่งเป็น UTC) ในเครื่องที่ timezone ไม่ใช่ UTC (เช่น +07:00 ของประเทศไทยที่ระบบนี้
// deploy จริง) จะได้วันที่คลาดเคลื่อนไป 1 วัน คืนเป็น string ตรงๆ แทน ไม่ต้องผ่าน Date object เลย เพราะ
// DATE เป็นปฏิทินล้วนๆ ไม่มีเวลา/timezone ในตัวมันเองอยู่แล้ว
types.setTypeParser(1082, (value) => value);

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
