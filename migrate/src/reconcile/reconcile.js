// เทียบผลหลัง APPLY กับไฟล์ต้นทาง (§5.3 ระยะ 3: "reconciliation: จำนวน/สังกัด/ตำแหน่งตรงกับระบบเดิม 100%")
// จับคู่ด้วย employee_no (คีย์เดียวที่ EmploymentImportRow รับประกันว่าถูกเขียนเป็น employment.employee_no
// ปัจจุบัน - ImportResult ไม่คืน person_id ต่อแถวจึงใช้เป็นคีย์เทียบไม่ได้)
async function reconcileBatch(pool, batchId) {
  const { rows: sourceRows } = await pool.query(
    `SELECT row_ref, employee_no, resolved_org_unit_id, resolved_position_id
     FROM stg_hr.raw_row WHERE batch_id = $1 AND quality_status = 'OK'`,
    [batchId]
  );

  const mismatches = [];
  let matched = 0;

  for (const row of sourceRows) {
    const { rows: current } = await pool.query(
      `SELECT org_unit_id, position_id FROM mdm.employment
       WHERE employee_no = $1 AND is_current`,
      [row.employee_no]
    );

    if (current.length === 0) {
      mismatches.push({ rowRef: row.row_ref, employeeNo: row.employee_no, issue: 'MISSING_IN_MDM' });
      continue;
    }

    const same =
      current[0].org_unit_id === row.resolved_org_unit_id && current[0].position_id === row.resolved_position_id;
    if (!same) {
      mismatches.push({ rowRef: row.row_ref, employeeNo: row.employee_no, issue: 'ORG_UNIT_OR_POSITION_MISMATCH' });
    } else {
      matched++;
    }
  }

  // สรุปจำนวนแยกตามสังกัด เปรียบเทียบไฟล์ต้นทาง (stg_hr) กับ mdm ปัจจุบัน
  const { rows: sourceByOrgUnit } = await pool.query(
    `SELECT org_unit_code, count(*)::int AS n FROM stg_hr.raw_row
     WHERE batch_id = $1 AND quality_status = 'OK' GROUP BY org_unit_code ORDER BY org_unit_code`,
    [batchId]
  );
  const { rows: mdmByOrgUnit } = await pool.query(
    `SELECT ou.code AS org_unit_code, count(*)::int AS n
     FROM mdm.employment e JOIN mdm.org_unit ou ON ou.org_unit_id = e.org_unit_id
     WHERE e.is_current AND e.employee_no IN (
       SELECT employee_no FROM stg_hr.raw_row WHERE batch_id = $1 AND quality_status = 'OK'
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
