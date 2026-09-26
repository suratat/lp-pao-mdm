const { HttpProblem } = require('../security/httpProblem');

// กฎ "เลขที่ตำแหน่ง (position) ตามประเภทบุคลากร" - ยืนยันโดยเจ้าของระบบ:
//   REQUIRED  ต้องมีตำแหน่ง: ข้าราชการ อบจ./ครู/ลูกจ้างประจำ/ถ่ายโอน รพ.สต.
//   FORBIDDEN ห้ามมีตำแหน่งเด็ดขาด: พนักงานจ้างทั้ง 3 ประเภท + จ้างเหมาบริการรายบุคคล + ผู้ดำรงตำแหน่งทางการเมือง
//   OPTIONAL  ไม่บังคับ: อื่นๆ (OTHER)
// (ตรวจกับ DB จริงแล้ว: ตำแหน่ง EX-xxx ของฝ่ายการเมืองไม่มีผู้ผูกอยู่ ไม่ต้อง grandfather)
//
// ต้องตรงกับ hr-console/src/personnelTypes.js (positionRule) - มี test เทียบสองฝั่งและเทียบกับ mdm.personnel_type
// ทุกโค้ดใน DB เพื่อกันลืมเมื่อมีประเภทใหม่ (ประเภทที่ไม่อยู่ในตารางนี้ = OPTIONAL)
const POSITION_RULES = Object.freeze({
  CIVIL_SERVANT: 'REQUIRED',
  TEACHER: 'REQUIRED',
  PERMANENT_EMPLOYEE: 'REQUIRED',
  TRANSFERRED_HEALTH: 'REQUIRED',
  CONTRACT_EMPLOYEE: 'FORBIDDEN',
  GENERAL_EMPLOYEE: 'FORBIDDEN',
  EXPERT_EMPLOYEE: 'FORBIDDEN',
  OUTSOURCE_INDIVIDUAL: 'FORBIDDEN',
  POLITICAL_APPOINTEE: 'FORBIDDEN',
  OTHER: 'OPTIONAL',
});

function positionRuleFor(personnelType) {
  return POSITION_RULES[personnelType] ?? 'OPTIONAL';
}

// ตรวจก่อนเขียน employment ทุกเส้นทาง (ไม่พึ่ง client) - โยน HttpProblem 422 ที่มี .code ด้วย เพื่อให้ผู้เรียกทั้งสองแบบใช้ได้
// (HTTP endpoint อ่านเป็น problem+json, batch import เก็บ err.code ลงรายการ errors ของแถวนั้น)
function assertPositionMatchesPersonnelType(personnelType, positionId) {
  const rule = positionRuleFor(personnelType);
  const hasPosition = positionId !== undefined && positionId !== null && positionId !== '';

  if (rule === 'FORBIDDEN' && hasPosition) {
    const err = new HttpProblem(
      422,
      'position-not-allowed',
      'ประเภทบุคลากรนี้ห้ามมีเลขที่ตำแหน่ง',
      `ประเภทบุคลากร ${personnelType} ต้องไม่ระบุ positionId (พนักงานจ้าง/จ้างเหมาบริการ/ผู้ดำรงตำแหน่งทางการเมืองไม่มีเลขที่ตำแหน่ง)`
    );
    err.code = 'POSITION_NOT_ALLOWED';
    throw err;
  }
  if (rule === 'REQUIRED' && !hasPosition) {
    const err = new HttpProblem(
      422,
      'position-required',
      'ประเภทบุคลากรนี้ต้องมีเลขที่ตำแหน่ง',
      `ประเภทบุคลากร ${personnelType} ต้องระบุ positionId`
    );
    err.code = 'POSITION_REQUIRED';
    throw err;
  }
}

module.exports = { POSITION_RULES, positionRuleFor, assertPositionMatchesPersonnelType };
