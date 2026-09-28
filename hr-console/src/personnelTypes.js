// ตรงกับ enum PersonnelType ใน docs/design/personnel-mdm-openapi.yaml - คัดลอกมาไว้ที่นี่เพราะ
// HR Console ไม่มี scope personnel:read:basic สำหรับเรียก endpoint reference อื่นมาสร้าง dropdown แบบ
// dynamic ได้ (ดู hr-console/README.md) และ enum นี้เปลี่ยนไม่บ่อย (แก้คู่กับ openapi.yaml ถ้าจำเป็น)
// positionRule = กฎเลขที่ตำแหน่งตามประเภทบุคลากร (เจ้าของระบบยืนยัน): REQUIRED ต้องมี | FORBIDDEN ห้ามมี | OPTIONAL ไม่บังคับ
// ต้องตรงกับ api/src/services/personnelPositionRules.js (MDM API บังคับซ้ำเสมอ) - มี test เทียบสองฝั่งกันลืมแก้คู่กัน
const PERSONNEL_TYPES = [
  { value: 'CIVIL_SERVANT', label: 'ข้าราชการองค์การบริหารส่วนจังหวัด', positionRule: 'REQUIRED' },
  { value: 'TEACHER', label: 'ข้าราชการครูและบุคลากรทางการศึกษา', positionRule: 'REQUIRED' },
  { value: 'PERMANENT_EMPLOYEE', label: 'ลูกจ้างประจำ', positionRule: 'REQUIRED' },
  { value: 'CONTRACT_EMPLOYEE', label: 'พนักงานจ้างตามภารกิจ', positionRule: 'FORBIDDEN' },
  { value: 'GENERAL_EMPLOYEE', label: 'พนักงานจ้างทั่วไป', positionRule: 'FORBIDDEN' },
  { value: 'EXPERT_EMPLOYEE', label: 'พนักงานจ้างผู้เชี่ยวชาญพิเศษ', positionRule: 'FORBIDDEN' },
  { value: 'TRANSFERRED_HEALTH', label: 'บุคลากรถ่ายโอน (รพ.สต.)', positionRule: 'REQUIRED' },
  { value: 'OUTSOURCE_INDIVIDUAL', label: 'จ้างเหมาบริการ (รายบุคคล)', positionRule: 'FORBIDDEN' },
  { value: 'OTHER', label: 'อื่นๆ', positionRule: 'OPTIONAL' },
  { value: 'POLITICAL_APPOINTEE', label: 'ผู้ดำรงตำแหน่งทางการเมือง', positionRule: 'FORBIDDEN' },
];

// ประเภทที่ไม่รู้จัก = OPTIONAL (ให้ MDM API ตัดสินเอง)
function positionRuleFor(value) {
  return PERSONNEL_TYPES.find((t) => t.value === value)?.positionRule ?? 'OPTIONAL';
}

module.exports = { PERSONNEL_TYPES, positionRuleFor };
