// T10: กฎ validation ของฟอร์ม master data หน่วยงาน/ตำแหน่ง - ใช้ทั้งฝั่ง client (แนบเป็น attribute pattern/data-pattern
// ในหน้าฟอร์ม) และฝั่ง server ของ HR Console (ตรวจซ้ำก่อนเรียก MDM API) - MDM API ยังเป็นผู้ตัดสินสุดท้ายเสมอ

// ต้องตรงกับ components.schemas.PositionNo ใน docs/design/personnel-mdm-openapi.yaml
// 4 รูปแบบตามข้อมูลจริง: NN-N-NN-NNNN-NNN | NN-N-NN-NNNN-NNN (ถ) | EX-NNN | ตัวเลข 1-2 หลัก
const POSITION_NO_PATTERN = '^(\\d{2}-\\d-\\d{2}-\\d{4}-\\d{3}( {1,2}\\(ถ\\))?|EX-\\d{3}|\\d{1,2})$';
const POSITION_NO_MESSAGE =
  'รูปแบบเลขที่ตำแหน่งไม่ถูกต้อง (เช่น 52-1-07-3106-003, 52-1-07-3106-003 (ถ), EX-001 หรือตัวเลข 1-2 หลัก)';

// ต้องตรงกับ components.schemas.OrgUnitCreate.code (ใน HTML ใช้ \- เพื่อให้ใช้ได้ทั้งโหมด u และ v ของ pattern attribute)
const ORG_UNIT_CODE_PATTERN = '^[A-Za-z0-9_\\-]{1,50}$';
const ORG_UNIT_CODE_MESSAGE = 'รหัสหน่วยงานใช้ได้เฉพาะ A-Z a-z 0-9 _ - ความยาว 1-50 ตัวอักษร ห้ามเว้นวรรค';

const UNIT_LEVELS = [
  { value: 'DIVISION', label: 'สำนัก/กอง' },
  { value: 'SECTION', label: 'ฝ่าย' },
  { value: 'UNIT', label: 'งาน' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateRequiredText(errors, value, label, maxLength) {
  if (!value) errors.push(`กรุณากรอก${label}`);
  else if (value.length > maxLength) errors.push(`${label}ยาวเกิน ${maxLength} ตัวอักษร`);
}

// คืน { body, values, errors } - values ใช้เติมกลับลงฟอร์มเมื่อมี error; body ตรงกับ request body ของ MDM API
function parseOrgUnitForm(input, { mode }) {
  const errors = [];
  const values = {
    code: trimmed(input.code),
    nameTh: trimmed(input.nameTh),
    nameEn: trimmed(input.nameEn),
    unitLevel: trimmed(input.unitLevel),
    parentId: trimmed(input.parentId),
    isActive: input.isActive === 'false' ? 'false' : 'true',
  };

  if (mode === 'create') {
    if (!new RegExp(ORG_UNIT_CODE_PATTERN).test(values.code)) errors.push(ORG_UNIT_CODE_MESSAGE);
  }
  validateRequiredText(errors, values.nameTh, 'ชื่อหน่วยงาน (ไทย)', 255);
  if (values.nameEn.length > 255) errors.push('ชื่อหน่วยงาน (อังกฤษ) ยาวเกิน 255 ตัวอักษร');
  if (!UNIT_LEVELS.some((l) => l.value === values.unitLevel)) errors.push('กรุณาเลือกระดับหน่วยงาน');
  if (values.parentId && !UUID_RE.test(values.parentId)) errors.push('กรุณาเลือกหน่วยงานต้นสังกัดจากรายการ');

  const body = {
    nameTh: values.nameTh,
    nameEn: values.nameEn || null,
    unitLevel: values.unitLevel,
    parentId: values.parentId || null,
  };
  if (mode === 'create') body.code = values.code;
  else body.isActive = values.isActive === 'true';

  return { body, values, errors };
}

function parsePositionForm(input, { mode }) {
  const errors = [];
  const values = {
    positionNo: trimmed(input.positionNo),
    titleTh: trimmed(input.titleTh),
    lineOfWork: trimmed(input.lineOfWork),
    positionType: trimmed(input.positionType),
    orgUnitId: trimmed(input.orgUnitId),
    isActive: input.isActive === 'false' ? 'false' : 'true',
  };

  if (!new RegExp(POSITION_NO_PATTERN).test(values.positionNo)) errors.push(POSITION_NO_MESSAGE);
  validateRequiredText(errors, values.titleTh, 'ชื่อตำแหน่ง', 255);
  if (values.lineOfWork.length > 100) errors.push('สายงานยาวเกิน 100 ตัวอักษร');
  if (!values.positionType) errors.push('กรุณาเลือกหมวดตำแหน่งจากรายการ');
  if (!UUID_RE.test(values.orgUnitId)) errors.push('กรุณาเลือกหน่วยงานจากรายการ');

  const body = {
    positionNo: values.positionNo,
    titleTh: values.titleTh,
    lineOfWork: values.lineOfWork || null,
    positionType: values.positionType,
    orgUnitId: values.orgUnitId,
  };
  if (mode === 'edit') body.isActive = values.isActive === 'true';

  return { body, values, errors };
}

module.exports = {
  POSITION_NO_PATTERN,
  POSITION_NO_MESSAGE,
  ORG_UNIT_CODE_PATTERN,
  ORG_UNIT_CODE_MESSAGE,
  UNIT_LEVELS,
  UUID_RE,
  parseOrgUnitForm,
  parsePositionForm,
};
