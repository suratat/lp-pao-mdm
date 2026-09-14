// Portal ไม่มี DB ของตัวเอง (คุยกับ MDM API ผ่าน HTTP เท่านั้น) - เทสของ Portal รัน instance จริงของ
// MDM API (api/src/app.js) เพื่อทดสอบ end-to-end แบบเดียวกับที่ Portal คุยกับ MDM API จริงในโปรดักชัน
// จึงใช้ Postgres container + migrations ชุดเดียวกับ api/test (ไม่สร้าง container ซ้ำ)
module.exports = require('../../api/test/globalSetup');
