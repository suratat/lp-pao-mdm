// reason ระดับ batch ที่ migrate-cli ส่งให้ POST /sync/hr/employment-batch (API บังคับ และปฏิเสธ reason ที่เข้าข่ายเลขบัตรประชาชน:
// เลข 13 หลักติดกัน หรือคั่นด้วยขีด/ช่องว่างตัวเดียว - api/src/security/redact.js)
//
// ห้ามใส่ batchId (UUID) ดิบ: UUID มีตัวเลขจำนวนมากคั่นด้วยขีด เช่น 12345678-1234-4567-... อ่านเป็นเลข 13 หลักได้ ทำให้การนำเข้าจริงล้ม 422
// reason-contains-pid แบบสุ่ม (ราว 1 ใน 10 ของ UUID ที่สุ่ม) ใช้เฉพาะกลุ่มแรก 8 ตัวอักษรเลขฐานสิบหก: เลขติดกันได้ไม่เกิน 8 หลักและไม่มีตัวคั่น
// จึงไม่มีทางถึง 13 หลักไม่ว่า batchId จะเป็นค่าใด (พิสูจน์ได้ ไม่ใช่แค่ "โอกาสน้อย") ส่วนข้อความรอบๆ เป็นตัวอักษรล้วน
//
// ตามรอย batch ได้จากที่อื่น: stg_hr.import_batch (batch_id เต็ม) -> หาจากแถว log ด้วย
//   SELECT batch_id FROM stg_hr.import_batch WHERE batch_id::text LIKE '<8 ตัวใน reason>%'
// และ batchId เต็มอยู่ในผลลัพธ์ของ CLI/รายงานของ migrate เหมือนเดิม
const UUID_FIRST_GROUP = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// สำเนาของ PID_LIKE ใน api/src/security/redact.js (migrate ไม่ import ฝั่ง security ของ API) - เทสต์เทียบสองตัวนี้ให้ตรงกัน
const PID_LIKE = /\d(?:[ -]?\d){12}/;

function importReason(batchId) {
  const match = UUID_FIRST_GROUP.exec(String(batchId));
  if (!match) throw new Error('batchId ต้องเป็น UUID');
  const reason = `HR_IMPORT batch ${match[1].toLowerCase()}`;
  // ไม่ควรเกิดขึ้นได้ (ดูเหตุผลข้างบน) - กันไว้ให้ล้มที่ต้นทางด้วยข้อความชัดเจน แทนที่จะไปล้มกลางการนำเข้าด้วย 422 จาก API
  if (PID_LIKE.test(reason)) throw new Error('reason ที่สร้างเองเข้าข่ายเลขบัตรประชาชน (บั๊ก importReason)');
  return reason;
}

module.exports = { importReason, PID_LIKE };
