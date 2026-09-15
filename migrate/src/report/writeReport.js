const fs = require('node:fs/promises');
const path = require('node:path');
const { redact } = require('../util/redact');

// เขียนรายงานเป็น JSON เสมอ (ไม่มี pid ปนอยู่ในโครงสร้างข้อมูลตั้งแต่ต้นอยู่แล้ว - ทุกโมดูลใน
// migrate/src ส่งกลับเฉพาะ rowRef/code ไม่เคยส่ง pid_plaintext ออกมาในผลลัพธ์ที่ไปเขียนรายงาน
// หมายเหตุ: employeeNo = pid เสมอ (อบจ.ลำปางไม่มีเลขประจำตัวข้าราชการแยกต่างหาก) จึงไม่ใส่ employeeNo
// ในผลลัพธ์ที่ถูกเขียนรายงานเช่นกัน ดู reconcile.js)
// redact() ที่นี่เป็นชั้นป้องกันที่สอง เผื่อ error.message จากภายนอก (เช่น DB/HTTP) หลุดเลข 13 หลักเข้ามา
async function writeReport(outDir, filename, data) {
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, filename);
  const json = redact(JSON.stringify(data, null, 2));
  await fs.writeFile(filePath, json, 'utf8');
  return filePath;
}

module.exports = { writeReport };
