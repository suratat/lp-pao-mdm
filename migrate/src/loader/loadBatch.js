const { parseCsv } = require('../csv/parseCsv');

// โหลดไฟล์ CSV ที่ parse แล้วเข้า stg_hr เป็น batch ใหม่หนึ่งชุด (§5.3 ระยะ 1: "export ระบบเดิม -> schema stg_hr")
// pid_loaded_at ตั้งตอนนี้เท่านั้น (ใช้เป็นจุดเริ่มนับอายุ 30 วันสำหรับ worker job ล้าง plaintext)
async function loadBatch(pool, { csvContent, columnMap, sourceFilename, importedBy, now = () => new Date() }) {
  const rows = parseCsv(csvContent, columnMap);
  const loadedAt = now();

  const { rows: batchRows } = await pool.query(
    `INSERT INTO stg_hr.import_batch (source_system, source_filename, imported_by, status)
     VALUES ($1, $2, $3, 'LOADED') RETURNING batch_id`,
    [columnMap.sourceSystem, sourceFilename, importedBy]
  );
  const batchId = batchRows[0].batch_id;

  for (const { logical, raw } of rows) {
    await pool.query(
      `INSERT INTO stg_hr.raw_row (
         batch_id, row_ref, pid_plaintext, pid_loaded_at, expected_first_name_th, expected_last_name_th,
         employee_no, personnel_type_raw, position_no, org_unit_code, level_code,
         appointed_date_raw, effective_from_raw, employment_status_raw, email_work,
         external_system_code, external_value, phone_raw, email_personal_raw, source_data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        batchId,
        logical.rowRef,
        logical.pid,
        logical.pid ? loadedAt : null,
        logical.expectedFirstNameTh,
        logical.expectedLastNameTh,
        logical.employeeNo,
        logical.personnelTypeRaw,
        logical.positionNo,
        logical.orgUnitCode,
        logical.levelCode,
        logical.appointedDateRaw,
        logical.effectiveFromRaw,
        logical.employmentStatusRaw,
        logical.emailWork,
        columnMap.sourceSystem,
        logical.externalValue,
        logical.phoneRaw,
        logical.emailPersonalRaw,
        JSON.stringify(raw),
      ]
    );
  }

  return { batchId, rowCount: rows.length };
}

module.exports = { loadBatch };
