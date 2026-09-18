const { Pool } = require('pg');
const { DATABASE_URL, MIGRATOR_DATABASE_URL } = require('./config');
const { loadBatch } = require('../src/loader/loadBatch');
const { runQualityCheck } = require('../src/quality/rules');
const { buildCsv, validRow, defaultColumnMap, makeOrgUnit, makePosition } = require('./fixtures');

let pool;
let adminPool;
// orgUnitA/positionA คือหน่วยงาน+ตำแหน่ง "ปกติ" ที่ใช้เป็นค่าเริ่มต้นของแถวถูกต้องส่วนใหญ่ในไฟล์นี้
// orgUnitB สร้างแยกไว้เฉพาะเทส POSITION_ORG_UNIT_MISMATCH (ตำแหน่งของ A แต่ระบุสังกัดเป็น B)
let orgUnitA;
let positionA; // position_no (string) - ใช้เป็นค่าใน CSV
let positionAId; // position_id (uuid) ของ positionA - ใช้เทียบกับ resolved_position_id ที่ rules.js resolve ให้
let orgUnitB;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });

  orgUnitA = await makeOrgUnit(adminPool);
  positionA = await makePosition(adminPool, orgUnitA.orgUnitId);
  orgUnitB = await makeOrgUnit(adminPool);

  const { rows } = await adminPool.query(`SELECT position_id FROM mdm.position WHERE position_no = $1`, [positionA]);
  positionAId = rows[0].position_id;
});

// ค่าเริ่มต้นของแถวถูกต้องในไฟล์นี้ (แทน default เดิมของ validRow() ที่ผูกกับ org_unit/position ที่ seed
// จาก migration) - เทสที่ไม่ได้สนใจ org_unit/position โดยเฉพาะยังคงได้แถวที่ผ่านกฎคุณภาพทุกข้อ
function defaultRow(overrides = {}) {
  return validRow({ positionNo: positionA, orgUnitCode: orgUnitA.code, ...overrides });
}

afterAll(async () => {
  await pool.end();
  await adminPool.end();
});

async function loadAndCheck(rows) {
  const { batchId } = await loadBatch(pool, {
    csvContent: buildCsv(rows),
    columnMap: defaultColumnMap,
    sourceFilename: 'quality.csv',
    importedBy: 'tester',
  });
  const summary = await runQualityCheck(pool, batchId);
  const { rows: rawRows } = await adminPool.query(
    `SELECT row_ref, quality_status, quality_errors, resolved_org_unit_id, resolved_position_id
     FROM stg_hr.raw_row WHERE batch_id = $1 ORDER BY row_ref`,
    [batchId]
  );
  return { batchId, summary, rawRows };
}

function codesFor(rawRows, rowRef) {
  const row = rawRows.find((r) => r.row_ref === rowRef);
  return row.quality_errors.map((e) => e.code);
}

describe('runQualityCheck (§5.3 ระยะ 1: กฎคุณภาพ 5 ข้อ)', () => {
  test('แถวถูกต้องครบ -> OK พร้อม resolved_org_unit_id/resolved_position_id', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1' })]);
    expect(rawRows[0].quality_status).toBe('OK');
    expect(rawRows[0].resolved_org_unit_id).toBe(orgUnitA.orgUnitId);
    expect(rawRows[0].resolved_position_id).toBe(positionAId);
  });

  test('checksum เลขบัตรผิด -> PID_CHECKSUM_INVALID', async () => {
    const good = defaultRow();
    const badPid = `${good.pid.slice(0, 12)}${(Number(good.pid[12]) + 1) % 10}`;
    const { rawRows, summary } = await loadAndCheck([defaultRow({ rowRef: 'bad', pid: badPid })]);
    expect(codesFor(rawRows, 'bad')).toContain('PID_CHECKSUM_INVALID');
    expect(summary.error).toBe(1);
    // ยืนยันว่าเลขบัตร (ผิดหรือถูก) ไม่หลุดไปอยู่ใน error message (กฎข้อ 1 ของ CLAUDE.md)
    expect(JSON.stringify(rawRows)).not.toContain(badPid);
  });

  test('เลขบัตรซ้ำกันในไฟล์เดียวกัน -> DUPLICATE_PID ทั้งสองแถว (error เดียว ไม่ซ้ำสอง แม้ employeeNo = pid ด้วย)', async () => {
    const pid = require('../../api/src/security/pid').makeFakePid();
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'dup1', pid }),
      defaultRow({ rowRef: 'dup2', pid }),
    ]);
    expect(codesFor(rawRows, 'dup1')).toContain('DUPLICATE_PID');
    expect(codesFor(rawRows, 'dup2')).toContain('DUPLICATE_PID');
    // employeeNo = pid เสมอตอนนี้ (ไม่มีคอลัมน์ต้นทางแยก) - ยืนยันว่ากฎคุณภาพไม่ตรวจ "ซ้ำ" สองครั้งราวกับ
    // เป็นคนละฟิลด์ (DUPLICATE_PID ครั้งเดียวต่อแถว ไม่มี error code อื่นที่หมายถึง employee_no ซ้ำแยกต่างหาก)
    expect(codesFor(rawRows, 'dup1')).toEqual(['DUPLICATE_PID']);
    expect(codesFor(rawRows, 'dup2')).toEqual(['DUPLICATE_PID']);
  });

  test('รหัสสังกัดไม่พบใน mdm.org_unit -> ORG_UNIT_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', orgUnitCode: 'NO-SUCH-UNIT' })]);
    expect(codesFor(rawRows, 'r1')).toContain('ORG_UNIT_NOT_FOUND');
  });

  test('เลขที่ตำแหน่งไม่พบใน mdm.position -> POSITION_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', positionNo: 'POS-NOPE' })]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_NOT_FOUND');
  });

  test('พนักงานจ้าง/จ้างเหมาบริการรายบุคคล/อื่นๆ/ผู้ดำรงตำแหน่งทางการเมือง ไม่มีเลขที่ตำแหน่ง -> ไม่ error POSITION_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'general', personnelTypeRaw: 'พนักงานจ้างทั่วไป', positionNo: '' }),
      defaultRow({ rowRef: 'outsource', personnelTypeRaw: 'จ้างเหมาบริการ', positionNo: '' }),
      defaultRow({ rowRef: 'other', personnelTypeRaw: 'อื่นๆ', positionNo: '' }),
      defaultRow({ rowRef: 'political', personnelTypeRaw: 'ผู้ดำรงตำแหน่งทางการเมือง', positionNo: '' }),
    ]);
    expect(codesFor(rawRows, 'general')).not.toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'outsource')).not.toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'other')).not.toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'political')).not.toContain('POSITION_NOT_FOUND');
    const generalRow = rawRows.find((r) => r.row_ref === 'general');
    expect(generalRow.quality_status).toBe('OK');
    expect(generalRow.resolved_position_id).toBeNull();
    const otherRow = rawRows.find((r) => r.row_ref === 'other');
    expect(otherRow.quality_status).toBe('OK');
    expect(otherRow.resolved_position_id).toBeNull();
    const politicalRow = rawRows.find((r) => r.row_ref === 'political');
    expect(politicalRow.quality_status).toBe('OK');
    expect(politicalRow.resolved_position_id).toBeNull();
  });

  test('อื่นๆ/ผู้ดำรงตำแหน่งทางการเมือง ยังคงต้องมีรหัสสังกัด (org_unit_code) เหมือนกลุ่มอื่น -> ORG_UNIT_NOT_FOUND ถ้าไม่มี', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'other-no-org', personnelTypeRaw: 'อื่นๆ', positionNo: '', orgUnitCode: '' }),
      defaultRow({
        rowRef: 'political-no-org',
        personnelTypeRaw: 'ผู้ดำรงตำแหน่งทางการเมือง',
        positionNo: '',
        orgUnitCode: '',
      }),
    ]);
    expect(codesFor(rawRows, 'other-no-org')).toContain('ORG_UNIT_NOT_FOUND');
    expect(codesFor(rawRows, 'other-no-org')).not.toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'political-no-org')).toContain('ORG_UNIT_NOT_FOUND');
    expect(codesFor(rawRows, 'political-no-org')).not.toContain('POSITION_NOT_FOUND');
  });

  test('ข้าราชการ/ครู/ลูกจ้างประจำ/ถ่ายโอน ยังต้องมีเลขที่ตำแหน่งเหมือนเดิม -> POSITION_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'civil', personnelTypeRaw: 'ข้าราชการ อบจ.', positionNo: '' }),
    ]);
    expect(codesFor(rawRows, 'civil')).toContain('POSITION_NOT_FOUND');
  });

  test('ตำแหน่งมีจริงแต่สังกัดคนละหน่วยกับที่ระบุในแถว -> POSITION_ORG_UNIT_MISMATCH', async () => {
    // positionA สังกัด orgUnitA จริง แต่แถวนี้ระบุ orgUnitCode เป็น orgUnitB (คนละหน่วยงาน)
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'r1', positionNo: positionA, orgUnitCode: orgUnitB.code }),
    ]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_ORG_UNIT_MISMATCH');
  });

  test('ชื่อ/นามสกุลว่าง หรือมีตัวเลขปน -> NAME_FORMAT_INVALID', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'empty', expectedFirstNameTh: '' }),
      defaultRow({ rowRef: 'digit', expectedLastNameTh: 'สมชาย1' }),
    ]);
    expect(codesFor(rawRows, 'empty')).toContain('NAME_FORMAT_INVALID');
    expect(codesFor(rawRows, 'digit')).toContain('NAME_FORMAT_INVALID');
  });

  test('ประเภทบุคลากรไม่มีอยู่ใน personnel-type-map.json -> PERSONNEL_TYPE_NOT_MAPPED', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', personnelTypeRaw: 'ไม่รู้จัก' })]);
    expect(codesFor(rawRows, 'r1')).toContain('PERSONNEL_TYPE_NOT_MAPPED');
  });

  test('สถานะที่ไม่ใช่ปฏิบัติงาน -> EMPLOYMENT_STATUS_NOT_SUPPORTED (API ยังไม่รองรับฟิลด์นี้)', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', employmentStatusRaw: 'ลาออก' })]);
    expect(codesFor(rawRows, 'r1')).toContain('EMPLOYMENT_STATUS_NOT_SUPPORTED');
  });

  test('วันที่แปลงไม่ได้ -> DATE_FORMAT_INVALID', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', effectiveFromRaw: 'ไม่ใช่วันที่' })]);
    expect(codesFor(rawRows, 'r1')).toContain('DATE_FORMAT_INVALID');
  });

  test('batch status เปลี่ยนเป็น QUALITY_CHECKED หลังตรวจ', async () => {
    const { batchId } = await loadAndCheck([defaultRow()]);
    const { rows } = await adminPool.query(`SELECT status FROM stg_hr.import_batch WHERE batch_id = $1`, [batchId]);
    expect(rows[0].status).toBe('QUALITY_CHECKED');
  });
});
