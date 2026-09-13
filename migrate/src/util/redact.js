// CLAUDE.md กฎข้อ 1: ห้าม pid ปรากฏใน log/error message/รายงาน - ใช้ก่อน console.log/เขียนไฟล์รายงานใดๆ
// ที่อาจมีข้อความอิสระ (เช่น error.message จาก DB/HTTP) ปนอยู่ ไม่ครอบคลุมคีย์ที่รู้ว่าเป็น pid ตรงๆ
// อยู่แล้ว (เช่นนั้นไม่ใส่ในรายงานตั้งแต่ต้น ดู report/writeReport.js)
const PID_PATTERN = /\d{13}/g;

function redact(text) {
  if (typeof text !== 'string') return text;
  return text.replace(PID_PATTERN, '[REDACTED_PID]');
}

module.exports = { redact };
