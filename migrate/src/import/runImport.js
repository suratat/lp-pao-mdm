const crypto = require('node:crypto');
const { toImportRow, chunk } = require('../mapping/toImportRow');
const { redact } = require('../util/redact');

const MAX_ROWS_PER_REQUEST = 2000; // maxItems ของ EmploymentImportRow[] ใน personnel-mdm-openapi.yaml

async function fetchOkRows(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT row_ref, pid_plaintext, expected_first_name_th, expected_last_name_th, employee_no,
            personnel_type_raw, level_code, appointed_date_raw, effective_from_raw, email_work,
            resolved_org_unit_id, resolved_position_id
     FROM stg_hr.raw_row WHERE batch_id = $1 AND quality_status = 'OK' ORDER BY row_ref`,
    [batchId]
  );
  return rows;
}

// เรียก POST /sync/hr/employment-batch (T4) จริงผ่าน HTTP ตาม §5.3 ระยะ 3 - ไม่ import ฟังก์ชันของ api/
// ตรงๆ (ต่างจาก security/pid.js ซึ่งเป็น pure function ไม่มีสถานะ) เพราะการเขียนบุคคล/employment ต้องผ่าน
// เส้นทาง API เดียวเท่านั้นตามสถาปัตยกรรม แม้จะเป็นเครื่องมือภายในก็ตาม
async function runImport(
  pool,
  { apiBaseUrl, token, batchId, mode, createIfMissing = false, sourceSystem = 'LHR', fetchImpl = fetch }
) {
  const rows = await fetchOkRows(pool, batchId);
  const chunks = chunk(rows, MAX_ROWS_PER_REQUEST);

  const summary = { mode, total: 0, created: 0, updated: 0, unchanged: 0, errors: [] };

  for (const rowsChunk of chunks) {
    const body = {
      mode,
      createIfMissing,
      sourceSystem,
      rows: rowsChunk.map(toImportRow),
    };

    const res = await fetchImpl(`${apiBaseUrl}/sync/hr/employment-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`เรียก /sync/hr/employment-batch ไม่สำเร็จ (${res.status}): ${redact(text)}`);
    }

    const result = await res.json();
    summary.total += result.total;
    summary.created += result.created;
    summary.updated += result.updated;
    summary.unchanged += result.unchanged;
    summary.errors.push(...result.errors);
  }

  const errorsByRowRef = new Map(summary.errors.map((e) => [e.rowRef, e.code]));
  for (const row of rows) {
    const code = errorsByRowRef.get(row.row_ref) ?? null;
    await pool.query(`UPDATE stg_hr.raw_row SET import_result_code = $3 WHERE batch_id = $1 AND row_ref = $2`, [
      batchId,
      row.row_ref,
      code,
    ]);
  }

  if (mode === 'APPLY') {
    await pool.query(`UPDATE stg_hr.import_batch SET status = 'APPLIED' WHERE batch_id = $1`, [batchId]);
  } else {
    await pool.query(`UPDATE stg_hr.import_batch SET status = 'DRY_RUN_DONE' WHERE batch_id = $1`, [batchId]);
  }

  return summary;
}

module.exports = { runImport, MAX_ROWS_PER_REQUEST };
