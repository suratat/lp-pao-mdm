// เทียบผลหลัง APPLY กับไฟล์ต้นทาง (§5.3 ระยะ 3: "reconciliation: จำนวน/สังกัด/ตำแหน่งตรงกับระบบเดิม 100%")
// จับคู่ด้วย pid_plaintext (mdm.employment.employee_no = pid เสมอ เพราะ อบจ.ลำปางไม่มีเลขประจำตัวข้าราชการ
// แยกต่างหาก - ดู toImportRow.js) - ImportResult ไม่คืน person_id ต่อแถวจึงใช้เป็นคีย์เทียบไม่ได้
//
// ข้อจำกัด: pid_plaintext ถูก worker job stgHrPurge ล้างเป็น NULL หลัง 30 วัน (นโยบาย retention ตาม §5.4)
// ดังนั้น reconcile ต้องรันภายในช่วงเวลานั้น - แถวที่ pid_plaintext ถูกล้างไปแล้วจะ fail-fast ด้วย
// PID_PURGED_CANNOT_RECONCILE แทนที่จะรายงานผลผิด (ไม่เพิ่ม dependency ใหม่ เช่น Vault/pepper เข้า
// migrate/ tool เพื่อจับคู่ด้วย hash แทน - ตัดสินใจแล้วว่า reconcile ต้องทำให้เสร็จเร็วหลัง import
// ไม่ใช่ทิ้งไว้เป็นเดือน)
//
// ไม่ใส่ employeeNo/pid ลงใน mismatch object ที่นี่ (กฎข้อ 1 ของ CLAUDE.md) - มีแค่ rowRef ให้ฝ่ายบุคคล
// ไล่ดูไฟล์ต้นทางเอง
async function reconcileBatch(pool, batchId) {
  const { rows: sourceRows } = await pool.query(
    `SELECT row_ref, pid_plaintext, resolved_org_unit_id, resolved_position_id
     FROM stg_hr.raw_row WHERE batch_id = $1 AND quality_status = 'OK'`,
    [batchId]
  );

  const mismatches = [];
  let matched = 0;

  for (const row of sourceRows) {
    if (!row.pid_plaintext) {
      mismatches.push({
        rowRef: row.row_ref,
        issue: 'PID_PURGED_CANNOT_RECONCILE',
        message: 'เลขบัตรประชาชน (plaintext) ของแถวนี้ถูกล้างตามนโยบาย retention 30 วันแล้ว - reconcile ย้อนหลังไม่ได้ ต้องรันภายใน 30 วันหลัง import',
      });
      continue;
    }

    const { rows: current } = await pool.query(
      `SELECT org_unit_id, position_id FROM mdm.employment
       WHERE employee_no = $1 AND is_current`,
      [row.pid_plaintext]
    );

    if (current.length === 0) {
      mismatches.push({ rowRef: row.row_ref, issue: 'MISSING_IN_MDM' });
      continue;
    }

    const same =
      current[0].org_unit_id === row.resolved_org_unit_id && current[0].position_id === row.resolved_position_id;
    if (!same) {
      mismatches.push({ rowRef: row.row_ref, issue: 'ORG_UNIT_OR_POSITION_MISMATCH' });
    } else {
      matched++;
    }
  }

  // สรุปจำนวนแยกตามสังกัด เปรียบเทียบไฟล์ต้นทาง (stg_hr) กับ mdm ปัจจุบัน (เฉพาะแถวที่ยังจับคู่ได้)
  const { rows: sourceByOrgUnit } = await pool.query(
    `SELECT org_unit_code, count(*)::int AS n FROM stg_hr.raw_row
     WHERE batch_id = $1 AND quality_status = 'OK' GROUP BY org_unit_code ORDER BY org_unit_code`,
    [batchId]
  );
  const { rows: mdmByOrgUnit } = await pool.query(
    `SELECT ou.code AS org_unit_code, count(*)::int AS n
     FROM mdm.employment e JOIN mdm.org_unit ou ON ou.org_unit_id = e.org_unit_id
     WHERE e.is_current AND e.employee_no IN (
       SELECT pid_plaintext FROM stg_hr.raw_row
       WHERE batch_id = $1 AND quality_status = 'OK' AND pid_plaintext IS NOT NULL
     )
     GROUP BY ou.code ORDER BY ou.code`,
    [batchId]
  );

  return {
    batchId,
    totalSourceRows: sourceRows.length,
    matched,
    mismatches,
    countsByOrgUnit: { source: sourceByOrgUnit, mdm: mdmByOrgUnit },
    isFullyReconciled: mismatches.length === 0,
  };
}

module.exports = { reconcileBatch };
