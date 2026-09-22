// ตรงกับ enum PersonnelType ใน docs/design/personnel-mdm-openapi.yaml - คัดลอกมาไว้ที่นี่เพราะ
// HR Console ไม่มี scope personnel:read:basic สำหรับเรียก endpoint reference อื่นมาสร้าง dropdown แบบ
// dynamic ได้ (ดู hr-console/README.md) และ enum นี้เปลี่ยนไม่บ่อย (แก้คู่กับ openapi.yaml ถ้าจำเป็น)
const PERSONNEL_TYPES = [
  { value: 'CIVIL_SERVANT', label: 'ข้าราชการองค์การบริหารส่วนจังหวัด' },
  { value: 'TEACHER', label: 'ข้าราชการครูและบุคลากรทางการศึกษา' },
  { value: 'PERMANENT_EMPLOYEE', label: 'ลูกจ้างประจำ' },
  { value: 'CONTRACT_EMPLOYEE', label: 'พนักงานจ้างตามภารกิจ' },
  { value: 'GENERAL_EMPLOYEE', label: 'พนักงานจ้างทั่วไป' },
  { value: 'EXPERT_EMPLOYEE', label: 'พนักงานจ้างผู้เชี่ยวชาญพิเศษ' },
  { value: 'TRANSFERRED_HEALTH', label: 'บุคลากรถ่ายโอน (รพ.สต.)' },
  { value: 'OUTSOURCE_INDIVIDUAL', label: 'จ้างเหมาบริการ (รายบุคคล)' },
  { value: 'OTHER', label: 'อื่นๆ' },
  { value: 'POLITICAL_APPOINTEE', label: 'ผู้ดำรงตำแหน่งทางการเมือง' },
];

module.exports = { PERSONNEL_TYPES };
