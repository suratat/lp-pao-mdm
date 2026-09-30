// ใช้ร่วมกันโดย employmentImportService, employmentService (PUT), provisioningService
// (reactivate, resolveClaimRequest PROVISION/LINK) - diff รายฟิลด์ + map error จาก constraint ของ DB
// เป็นรหัสที่ผู้เรียกอ่านเข้าใจได้ (แทน error ดิบของ Postgres)

const { assertPositionMatchesPersonnelType } = require('./personnelPositionRules');
const { validateJobTitleText, assertJobTitleMatchesPersonnelType } = require('./jobTitleText');
const { HttpProblem } = require('../security/httpProblem');

const FIELD_MAP = {
  employeeNo: { column: 'employee_no', fieldKey: 'employment.employee_no' },
  personnelType: { column: 'personnel_type', fieldKey: 'employment.personnel_type' },
  positionId: { column: 'position_id', fieldKey: 'employment.position_id' },
  orgUnitId: { column: 'org_unit_id', fieldKey: 'employment.org_unit_id' },
  levelCode: { column: 'level_code', fieldKey: 'employment.level_code' },
  appointedDate: { column: 'appointed_date', fieldKey: 'employment.appointed_date' },
  emailWork: { column: 'email_work', fieldKey: 'employment.email_work' },
  jobTitleText: { column: 'job_title_text', fieldKey: 'employment.job_title_text' },
};

function serviceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function diffEmploymentFields(current, incoming) {
  const changes = [];
  for (const [apiField, meta] of Object.entries(FIELD_MAP)) {
    const newValue = incoming[apiField] ?? null;
    const oldValue = current ? (current[meta.column] ?? null) : null;
    if (oldValue !== newValue) {
      changes.push({ fieldKey: meta.fieldKey, oldValue, newValue });
    }
  }
  return changes;
}

// คืน HttpProblem ที่มี .status/.type ให้ route handler (provisioningService/employmentService) ตอบ 4xx ได้ตรงๆ
// โดยไม่ต้องมี catch/remap เพิ่มที่ผู้เรียก - ยังคง .code (SCREAMING_SNAKE) ไว้บน object เดิมด้วย เพราะ
// employmentImportService.js:96 อ่าน err.code || 'UNKNOWN_ERROR' เพื่อรายงานเป็น error รายแถวของ batch import
function constraintProblem(status, type, title, code) {
  const problem = new HttpProblem(status, type, title);
  problem.code = code;
  return problem;
}

function mapEmploymentConstraintError(err) {
  if (err.code === '23503') {
    if (err.constraint?.includes('position')) {
      return constraintProblem(422, 'position-invalid', 'ไม่พบตำแหน่งที่ระบุ', 'POSITION_NOT_FOUND');
    }
    if (err.constraint?.includes('org_unit')) {
      return constraintProblem(422, 'org-unit-invalid', 'ไม่พบสังกัดที่ระบุ', 'ORG_UNIT_NOT_FOUND');
    }
    if (err.constraint?.includes('personnel_type')) {
      return constraintProblem(422, 'personnel-type-invalid', 'ประเภทบุคลากรไม่ถูกต้อง', 'PERSONNEL_TYPE_INVALID');
    }
  }
  if (err.code === '23P01') {
    return constraintProblem(409, 'position-occupied', 'ตำแหน่งนี้มีผู้ครองอยู่แล้วในช่วงเวลาที่ระบุ', 'DUPLICATE_POSITION');
  }
  if (err.code === '23505') {
    return constraintProblem(409, 'employee-no-conflict', 'เลขประจำตัวนี้ถูกใช้กับบุคลากรอื่นที่เป็น current อยู่แล้ว', 'DUPLICATE_EMPLOYEE_NO');
  }
  return err;
}

// ปิด record เดิม (ถ้ามี) เปิดใหม่ - คืน employment_id ใหม่ + รายการ field ที่เปลี่ยน (ว่างถ้าไม่มีอะไรเปลี่ยน)
// updatedBy: 'HR' (endpoint ปกติ) หรือ 'HR_IMPORT' (batch import) - ใช้ค่าเดียวกับ employment.updated_by
async function closeAndOpenEmployment(client, personId, rawIncoming, updatedBy = 'HR') {
  // ทางผ่านเดียวของทุกเส้นทางที่เขียน employment (provision, PUT employment, resolve claim, reactivate, import) -
  // ตรวจกฎตำแหน่งตามประเภทบุคลากรที่นี่ที่เดียว ก่อนแตะ DB (422 ถ้าผิดกฎ)
  assertPositionMatchesPersonnelType(rawIncoming.personnelType, rawIncoming.positionId);
  // ชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ): normalize (ตัด control/bidi, บรรทัดเดียว, trim) + ปฏิเสธเลขบัตร/ยาวเกิน + กฎตามประเภท
  // ใช้ค่าที่ normalize แล้วทั้งตอน diff และ INSERT (ข้อความว่าง = null = ไม่มีข้อความ)
  const jobTitleText = validateJobTitleText(rawIncoming.jobTitleText);
  assertJobTitleMatchesPersonnelType(rawIncoming.personnelType, rawIncoming.positionId, jobTitleText);
  const incoming = { ...rawIncoming, jobTitleText };

  const { rows } = await client.query(`SELECT * FROM mdm.employment WHERE person_id = $1 AND is_current = true`, [
    personId,
  ]);
  const current = rows[0] || null;
  const changes = diffEmploymentFields(current, incoming);

  if (changes.length === 0 && current) {
    return { employmentId: current.employment_id, changes: [] };
  }

  try {
    if (current) {
      await client.query(`UPDATE mdm.employment SET is_current = false, effective_to = $2 WHERE employment_id = $1`, [
        current.employment_id,
        incoming.effectiveFrom,
      ]);
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO mdm.employment
        (person_id, employee_no, personnel_type, position_id, org_unit_id, level_code, appointed_date,
         effective_from, is_current, employment_status, email_work, updated_by, job_title_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'ACTIVE', $9, $10, $11)
       RETURNING employment_id`,
      [
        personId,
        incoming.employeeNo,
        incoming.personnelType,
        incoming.positionId ?? null,
        incoming.orgUnitId,
        incoming.levelCode ?? null,
        incoming.appointedDate ?? null,
        incoming.effectiveFrom,
        incoming.emailWork ?? null,
        updatedBy,
        incoming.jobTitleText,
      ]
    );

    return { employmentId: inserted[0].employment_id, changes };
  } catch (err) {
    throw mapEmploymentConstraintError(err);
  }
}

module.exports = { serviceError, diffEmploymentFields, mapEmploymentConstraintError, closeAndOpenEmployment };
