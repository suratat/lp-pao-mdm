const path = require('node:path');
const { isValidPid } = require(path.join(__dirname, '..', '..', '..', 'api', 'src', 'security', 'pid'));
const { convertToIsoDate } = require('./dateConvert');
const { mapPersonnelType } = require('./personnelTypeMap');

// รหัสสถานะที่ API (/sync/hr/employment-batch) รองรับตอนนี้เท่านั้น - EmploymentUpsert (openapi) ไม่มีฟิลด์
// employmentStatus เลย จึงนำเข้าได้เฉพาะคนที่ "ปฏิบัติงาน" (ACTIVE) ผ่าน endpoint นี้ คนที่พ้นสภาพก่อน
// migrate (§5.4: "นำเข้าเป็น INACTIVE เฉพาะที่จำเป็น") ยังไม่มีช่องทางนำเข้าอัตโนมัติ - ส่งกลับให้ฝ่ายบุคคล
// จัดการด้วยมือแทนการเดา schema ที่ยังไม่ประกาศ (ดูสรุปงาน T8: "สิ่งที่ยังไม่ครอบคลุม")
const ACTIVE_STATUS_LABELS = new Set(['ปฏิบัติงาน', 'ACTIVE']);

// กลุ่มบุคลากรที่ไม่มีเลขที่ตำแหน่งตามโครงสร้างอัตรากำลัง (พนักงานจ้างทุกประเภท + จ้างเหมาบริการรายบุคคล +
// อื่นๆ) - ต่างจาก CIVIL_SERVANT/TEACHER/PERMANENT_EMPLOYEE/TRANSFERRED_HEALTH ที่ยังต้องมีตำแหน่งเสมอ
// สังกัด (org_unit_code) ยังคงบังคับต้องมีเหมือนกลุ่มอื่นทุกกลุ่ม (ดูกฎ ORG_UNIT_NOT_FOUND ด้านล่าง - ไม่ได้
// ถูกยกเว้นสำหรับกลุ่มนี้)
const POSITION_OPTIONAL_TYPES = new Set([
  'CONTRACT_EMPLOYEE',
  'GENERAL_EMPLOYEE',
  'EXPERT_EMPLOYEE',
  'OUTSOURCE_INDIVIDUAL',
  'OTHER',
]);

function err(code, message) {
  return { code, message };
}

// ตรวจกฎคุณภาพ 5 ข้อตาม §5.3 ระยะ 1 กับแถวเดียว (ไม่รวมกฎ "ซ้ำ" ซึ่งต้องเทียบทั้ง batch - ดู checkBatch)
// orgUnitLookup/positionLookup: Map<code, { id, orgUnitId? }> ที่ query จาก mdm ไว้ล่วงหน้าทั้ง batch
function checkRow(row, { orgUnitLookup, positionLookup }) {
  const errors = [];

  // 1) checksum เลขบัตร
  if (!row.pid_plaintext || !isValidPid(row.pid_plaintext)) {
    errors.push(err('PID_CHECKSUM_INVALID', 'เลขบัตรประชาชนไม่ผ่านการตรวจ checksum (mod 11) หรือไม่มีค่า'));
  }

  // 4) รูปแบบชื่อ
  for (const [field, label] of [
    ['expected_first_name_th', 'ชื่อ'],
    ['expected_last_name_th', 'นามสกุล'],
  ]) {
    const value = row[field];
    if (!value || value.trim() === '') {
      errors.push(err('NAME_FORMAT_INVALID', `${label}ว่างเปล่า`));
    } else if (/\d/.test(value)) {
      errors.push(err('NAME_FORMAT_INVALID', `${label}มีตัวเลขปน ("${'*'.repeat(value.length)}")`));
    }
  }

  // ประเภทบุคลากร (ไม่ได้อยู่ใน 5 กฎของ §5.3 ตรงๆ แต่จำเป็นก่อนแปลงเป็น EmploymentImportRow - นับรวมเป็นกฎ
  // "สังกัด/ตำแหน่งที่ map ไม่ได้" ในความหมายกว้าง คือ "อ้างอิงที่ map เข้า enum ของ MDM ไม่ได้")
  // คำนวณก่อนตรวจตำแหน่งด้านล่าง เพราะกลุ่ม POSITION_OPTIONAL_TYPES ต้องใช้ค่านี้ตัดสินว่าจะข้ามกฎ
  // POSITION_NOT_FOUND หรือไม่
  const personnelType = mapPersonnelType(row.personnel_type_raw);
  if (!row.personnel_type_raw) {
    errors.push(err('PERSONNEL_TYPE_NOT_MAPPED', 'ไม่มีประเภทบุคลากรในแถวนี้'));
  } else if (!personnelType) {
    errors.push(err('PERSONNEL_TYPE_NOT_MAPPED', `ไม่พบ mapping ของ "${row.personnel_type_raw}" ใน personnel-type-map.json`));
  }

  // 3) สังกัด/ตำแหน่งที่ map ไม่ได้
  let resolvedOrgUnitId = null;
  let resolvedPositionId = null;
  const orgUnit = row.org_unit_code ? orgUnitLookup.get(row.org_unit_code) : null;
  if (!row.org_unit_code) {
    errors.push(err('ORG_UNIT_NOT_FOUND', 'ไม่มีรหัสสังกัดในแถวนี้'));
  } else if (!orgUnit) {
    errors.push(err('ORG_UNIT_NOT_FOUND', `ไม่พบสังกัดรหัส ${row.org_unit_code} ใน mdm.org_unit`));
  } else {
    resolvedOrgUnitId = orgUnit.orgUnitId;
  }

  const position = row.position_no ? positionLookup.get(row.position_no) : null;
  if (!row.position_no) {
    // พนักงานจ้าง/จ้างเหมาบริการรายบุคคล ไม่มีเลขที่ตำแหน่งตามโครงสร้างอัตรากำลัง - ไม่ถือเป็นข้อผิดพลาด
    if (!POSITION_OPTIONAL_TYPES.has(personnelType)) {
      errors.push(err('POSITION_NOT_FOUND', 'ไม่มีเลขที่ตำแหน่งในแถวนี้'));
    }
  } else if (!position) {
    errors.push(err('POSITION_NOT_FOUND', `ไม่พบตำแหน่งเลขที่ ${row.position_no} ใน mdm.position`));
  } else {
    resolvedPositionId = position.positionId;
    if (orgUnit && position.orgUnitId !== orgUnit.orgUnitId) {
      errors.push(
        err('POSITION_ORG_UNIT_MISMATCH', `ตำแหน่งเลขที่ ${row.position_no} ไม่ได้สังกัดรหัส ${row.org_unit_code} ใน mdm`)
      );
    }
  }

  if (row.employment_status_raw && !ACTIVE_STATUS_LABELS.has(row.employment_status_raw.trim())) {
    errors.push(
      err(
        'EMPLOYMENT_STATUS_NOT_SUPPORTED',
        `สถานะ "${row.employment_status_raw}" ไม่รองรับผ่าน API นำเข้าปัจจุบัน (รองรับเฉพาะปฏิบัติงาน) - ให้ฝ่ายบุคคลจัดการด้วยมือ`
      )
    );
  }

  // 5) วันที่ พ.ศ./ค.ศ.
  const effectiveFrom = convertToIsoDate(row.effective_from_raw);
  if (effectiveFrom.error) {
    errors.push(err(effectiveFrom.error, `แปลงวันที่ดำรงตำแหน่งปัจจุบันไม่ได้: "${row.effective_from_raw ?? ''}"`));
  }

  let appointedDate = null;
  if (row.appointed_date_raw) {
    const converted = convertToIsoDate(row.appointed_date_raw);
    if (converted.error) {
      errors.push(err(converted.error, `แปลงวันบรรจุไม่ได้: "${row.appointed_date_raw}"`));
    } else {
      appointedDate = converted.isoDate;
    }
  }

  return {
    errors,
    resolvedOrgUnitId,
    resolvedPositionId,
    personnelType,
    effectiveFromIso: effectiveFrom.isoDate ?? null,
    appointedDateIso: appointedDate,
  };
}

// 2) ซ้ำ - pid เดียวกันปรากฏมากกว่า 1 แถวในไฟล์เดียวกัน (ทุกแถวที่ซ้ำถูกตีว่า ERROR ให้ฝ่ายบุคคลตรวจทั้งหมด)
function findDuplicatePids(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row.pid_plaintext) continue;
    counts.set(row.pid_plaintext, (counts.get(row.pid_plaintext) ?? 0) + 1);
  }
  const duplicated = new Set();
  for (const [pid, count] of counts) {
    if (count > 1) duplicated.add(pid);
  }
  return duplicated;
}

async function loadLookups(pool) {
  const [orgUnits, positions] = await Promise.all([
    pool.query(`SELECT org_unit_id, code FROM mdm.org_unit WHERE is_active`),
    pool.query(`SELECT position_id, position_no, org_unit_id FROM mdm.position WHERE is_active`),
  ]);

  const orgUnitLookup = new Map(orgUnits.rows.map((r) => [r.code, { orgUnitId: r.org_unit_id }]));
  const positionLookup = new Map(
    positions.rows.map((r) => [r.position_no, { positionId: r.position_id, orgUnitId: r.org_unit_id }])
  );
  return { orgUnitLookup, positionLookup };
}

// ตรวจคุณภาพทั้ง batch แล้วเขียนผลกลับ stg_hr.raw_row (quality_status, quality_errors, resolved_*_id)
// คืนสรุปจำนวนสำหรับ quality-report.json (ดู report/writeReport.js)
async function runQualityCheck(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT raw_row_id, row_ref, pid_plaintext, expected_first_name_th, expected_last_name_th,
            personnel_type_raw, position_no, org_unit_code, employment_status_raw,
            appointed_date_raw, effective_from_raw
     FROM stg_hr.raw_row WHERE batch_id = $1 ORDER BY row_ref`,
    [batchId]
  );

  const { orgUnitLookup, positionLookup } = await loadLookups(pool);
  const duplicatedPids = findDuplicatePids(rows);

  let okCount = 0;
  let errorCount = 0;
  const errorsByCode = {};

  for (const row of rows) {
    const result = checkRow(row, { orgUnitLookup, positionLookup });
    const errors = [...result.errors];
    if (row.pid_plaintext && duplicatedPids.has(row.pid_plaintext)) {
      errors.push(err('DUPLICATE_PID', 'เลขบัตรประชาชนซ้ำกับแถวอื่นในไฟล์เดียวกัน'));
    }

    const qualityStatus = errors.length === 0 ? 'OK' : 'ERROR';
    if (qualityStatus === 'OK') okCount++;
    else {
      errorCount++;
      for (const e of errors) errorsByCode[e.code] = (errorsByCode[e.code] ?? 0) + 1;
    }

    await pool.query(
      `UPDATE stg_hr.raw_row
       SET quality_status = $2, quality_errors = $3::jsonb, resolved_org_unit_id = $4, resolved_position_id = $5
       WHERE raw_row_id = $1`,
      [row.raw_row_id, qualityStatus, JSON.stringify(errors), result.resolvedOrgUnitId, result.resolvedPositionId]
    );
  }

  await pool.query(`UPDATE stg_hr.import_batch SET status = 'QUALITY_CHECKED' WHERE batch_id = $1`, [batchId]);

  return { total: rows.length, ok: okCount, error: errorCount, errorsByCode };
}

module.exports = { runQualityCheck, checkRow, findDuplicatePids };
