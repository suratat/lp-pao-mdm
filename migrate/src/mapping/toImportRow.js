const { convertToIsoDate } = require('../quality/dateConvert');
const { mapPersonnelType } = require('../quality/personnelTypeMap');

// แปลงแถว stg_hr ที่ quality_status = 'OK' (resolved_org_unit_id/resolved_position_id ต้องไม่ null แล้ว
// จากขั้นตอน runQualityCheck) เป็น EmploymentImportRow ตาม personnel-mdm-openapi.yaml สำหรับส่งให้
// POST /sync/hr/employment-batch - คำนวณ personnelType/วันที่ซ้ำจาก pure function เดิม (ไม่เพิ่มคอลัมน์ DB)
//
// employeeNo: อบจ.ลำปางไม่มีเลขประจำตัวข้าราชการแยกต่างหาก จึงใช้เลขบัตรประชาชน (pid) เป็น employeeNo
// เสมอ ไม่มีคอลัมน์ต้นทางแยกให้อ่านอีกต่อไป (ดู column-map.json) - ผลคือ employment.employee_no ใน mdm
// ต้องถูกจัดการเป็นข้อมูลระดับเดียวกับ pid ทุกจุด (field_policy, openapi x-required-scope, tokenClaims)
function toImportRow(row) {
  const effectiveFrom = convertToIsoDate(row.effective_from_raw);
  const appointedDate = row.appointed_date_raw ? convertToIsoDate(row.appointed_date_raw) : null;

  return {
    rowRef: row.row_ref,
    pid: row.pid_plaintext,
    expectedFirstNameTh: row.expected_first_name_th,
    expectedLastNameTh: row.expected_last_name_th,
    employment: {
      employeeNo: row.pid_plaintext,
      personnelType: mapPersonnelType(row.personnel_type_raw),
      positionId: row.resolved_position_id ?? undefined,
      orgUnitId: row.resolved_org_unit_id,
      levelCode: row.level_code ?? undefined,
      appointedDate: appointedDate?.isoDate,
      effectiveFrom: effectiveFrom.isoDate,
      emailWork: row.email_work ?? undefined,
    },
  };
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

module.exports = { toImportRow, chunk };
