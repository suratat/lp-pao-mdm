const { HttpProblem } = require('../security/httpProblem');
const { containsPidLike } = require('../security/redact');

// เหตุผลของการเขียนข้อมูลบุคคลโดย HR (บังคับทุกครั้ง) ถูกเก็บถาวรใน audit.data_change_log และผู้อื่นอ่านได้
// - ว่าง/ช่องว่างล้วน -> 422 reason-required, ยาวเกิน -> 422 reason-too-long, มีเลข 13 หลัก (ติดกันหรือมีขีด/ช่องว่างคั่น) -> 422
//   reason-contains-pid (ปฏิเสธ ไม่ใช่ปกปิดเงียบ ให้ผู้ใช้แก้ข้อความเอง) detail ของ error ห้ามมีค่าที่ส่งมา (กฎข้อ 1 ของ CLAUDE.md)
const REASON_MAX = 500;

function assertReason(raw, { field = 'reason' } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    throw new HttpProblem(422, `${field}-required`, 'ต้องระบุเหตุผล', `${field} ห้ามว่าง: ทุกการเขียนข้อมูลบุคคลต้องมีเหตุผล`);
  }
  if (text.length > REASON_MAX) {
    throw new HttpProblem(422, `${field}-too-long`, 'เหตุผลยาวเกินไป', `${field} ยาวได้ไม่เกิน ${REASON_MAX} ตัวอักษร`);
  }
  if (containsPidLike(text)) {
    throw new HttpProblem(422, `${field}-contains-pid`, 'เหตุผลมีเลขบัตรประชาชน', `${field} ห้ามมีเลข 13 หลัก`);
  }
  return text;
}

// referenceDocument (เลขที่คำสั่ง/หนังสือ) ไม่บังคับ แต่ถ้าใส่ต้องไม่มีเลข 13 หลัก และรวมต่อท้ายเหตุผลที่เก็บลง log
function composeReason(reason, referenceDocument) {
  const cleanReason = assertReason(reason);
  const doc = typeof referenceDocument === 'string' ? referenceDocument.trim() : '';
  if (!doc) return cleanReason;
  if (containsPidLike(doc)) {
    throw new HttpProblem(422, 'reference-document-contains-pid', 'เลขที่เอกสารมีเลขบัตรประชาชน', 'referenceDocument ห้ามมีเลข 13 หลัก');
  }
  return `${cleanReason} (อ้างอิง: ${doc})`;
}

module.exports = { assertReason, composeReason, REASON_MAX };
