// ตรวจเลขบัตรประชาชน 13 หลักที่หน้าจอ (checksum mod 11 ภาคผนวก ข) - คัดลอกจาก api/src/security/pid.js เพราะ hr-console deploy แยกจาก API
// (มี test เทียบสองฝั่ง; MDM API ตรวจซ้ำเสมอและเป็นตัวตัดสินสุดท้าย) ฟังก์ชันนี้ไม่ log/เก็บค่า และไม่มี error message ที่ใส่ตัวเลขที่รับมา
function isValidPid(pid) {
  if (typeof pid !== 'string' || !/^\d{13}$/.test(pid)) return false;
  const sum = [...pid.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (13 - i), 0);
  return (11 - (sum % 11)) % 10 === Number(pid[12]);
}

// ตัดช่องว่าง/ขีดที่ผู้ใช้พิมพ์คั่น (1-2345-67890-12-3) ก่อนตรวจ
function normalizePidInput(raw) {
  return typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : '';
}

// ข้อความอิสระ (ชื่อ เหตุผล ฯลฯ) ที่ดูเหมือนเลขบัตร: เลข 13 หลักติดกันหรือคั่นด้วยขีด/ช่องว่างตัวเดียว (ตรงกับ api/src/security/redact.js)
const PID_LIKE = /\d(?:[ -]?\d){12}/;
const looksLikePid = (text) => typeof text === 'string' && PID_LIKE.test(text);

module.exports = { isValidPid, normalizePidInput, looksLikePid, PID_LIKE };
