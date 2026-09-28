// ชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ) - ตรวจซ้ำที่ server ของ console ก่อนเรียก MDM API (ไม่เชื่อสถานะ/ค่าจากฟอร์ม)
// คัดลอกตรรกะจาก api/src/services/jobTitleText.js ไว้ที่นี่ เพราะ hr-console deploy แยกจาก API (เหมือน personnelTypes.js) - มี test เทียบสองฝั่ง
// (MDM API ตรวจอีกชั้นเสมอ และเป็นตัวตัดสินสุดท้าย)
const MAX_LENGTH = 255;

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
function toAsciiDigits(text) {
  return text.replace(/[๐-๙０-９]/g, (ch) => {
    const thai = THAI_DIGITS.indexOf(ch);
    return thai >= 0 ? String(thai) : String(ch.charCodeAt(0) - 0xff10);
  });
}
// เลข 13 หลักติดกันหรือคั่นด้วยขีด/เว้นวรรค/จุดตัวเดียวระหว่างหลัก (ไม่ตรวจ checksum - ปฏิเสธทุกอย่างที่ดูเหมือนเลขบัตร)
const PID_LIKE = /\d(?:[\s\-.]?\d){12}/;

// ตัด control (Cc) + format/bidi (Cf เช่น U+202E) ทิ้ง, รวมขึ้นบรรทัดใหม่/ช่องว่างเป็นช่องว่างเดียว, trim - ข้อความว่างหลังตัด = null
function normalizeJobTitleText(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw)
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

// คืน { text, error } - error เป็นข้อความภาษาไทยที่แสดงผู้ใช้ได้ (ไม่มีตัวข้อความที่ผู้ใช้กรอกอยู่ในนั้น เพราะอาจมีข้อมูลส่วนบุคคล)
function checkJobTitleText(raw) {
  const text = normalizeJobTitleText(raw);
  if (text === null) return { text: null };
  if ([...text].length > MAX_LENGTH) return { text, error: `ชื่อตำแหน่ง/ลักษณะงานยาวเกิน ${MAX_LENGTH} ตัวอักษร` };
  if (PID_LIKE.test(toAsciiDigits(text))) {
    return { text, error: 'ชื่อตำแหน่ง/ลักษณะงานห้ามมีเลขบัตรประชาชน 13 หลัก (ทั้งแบบติดกันและแบบมีขีด/เว้นวรรค)' };
  }
  return { text };
}

module.exports = { MAX_LENGTH, normalizeJobTitleText, checkJobTitleText };
