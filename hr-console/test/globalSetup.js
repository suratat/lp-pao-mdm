// HR Console ไม่มี DB ของตัวเอง (คุยกับ MDM API ผ่าน HTTP เท่านั้น) - เทสรัน instance จริงของ MDM API
// (api/src/app.js) เหมือนที่ portal/test ทำ จึงใช้ Postgres container + migrations ชุดเดียวกับ api/test
module.exports = require('../../api/test/globalSetup');
