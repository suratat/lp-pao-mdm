const { Pool } = require('pg');
const { DATABASE_URL, MIGRATOR_DATABASE_URL } = require('./config');
const { loadBatch } = require('../src/loader/loadBatch');
const { runQualityCheck } = require('../src/quality/rules');
const { buildCsv, validRow, defaultColumnMap } = require('./fixtures');

let pool;
let adminPool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
});

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
    const { rawRows } = await loadAndCheck([validRow({ rowRef: 'r1' })]);
    expect(rawRows[0].quality_status).toBe('OK');
    expect(rawRows[0].resolved_org_unit_id).toBe('00000000-0000-0000-0000-000000000003');
    expect(rawRows[0].resolved_position_id).toBe('00000000-0000-0000-0000-000000000102');
  });

  test('checksum เลขบัตรผิด -> PID_CHECKSUM_INVALID', async () => {
    const good = validRow();
    const badPid = `${good.pid.slice(0, 12)}${(Number(good.pid[12]) + 1) % 10}`;
    const { rawRows, summary } = await loadAndCheck([validRow({ rowRef: 'bad', pid: badPid })]);
    expect(codesFor(rawRows, 'bad')).toContain('PID_CHECKSUM_INVALID');
    expect(summary.error).toBe(1);
    // ยืนยันว่าเลขบัตร (ผิดหรือถูก) ไม่หลุดไปอยู่ใน error message (กฎข้อ 1 ของ CLAUDE.md)
    expect(JSON.stringify(rawRows)).not.toContain(badPid);
  });

  test('เลขบัตรซ้ำกันในไฟล์เดียวกัน -> DUPLICATE_PID ทั้งสองแถว (error เดียว ไม่ซ้ำสอง แม้ employeeNo = pid ด้วย)', async () => {
    const pid = require('../../api/src/security/pid').makeFakePid();
    const { rawRows } = await loadAndCheck([
      validRow({ rowRef: 'dup1', pid }),
      validRow({ rowRef: 'dup2', pid }),
    ]);
    expect(codesFor(rawRows, 'dup1')).toContain('DUPLICATE_PID');
    expect(codesFor(rawRows, 'dup2')).toContain('DUPLICATE_PID');
    // employeeNo = pid เสมอตอนนี้ (ไม่มีคอลัมน์ต้นทางแยก) - ยืนยันว่ากฎคุณภาพไม่ตรวจ "ซ้ำ" สองครั้งราวกับ
    // เป็นคนละฟิลด์ (DUPLICATE_PID ครั้งเดียวต่อแถว ไม่มี error code อื่นที่หมายถึง employee_no ซ้ำแยกต่างหาก)
    expect(codesFor(rawRows, 'dup1')).toEqual(['DUPLICATE_PID']);
    expect(codesFor(rawRows, 'dup2')).toEqual(['DUPLICATE_PID']);
  });

  test('รหัสสังกัดไม่พบใน mdm.org_unit -> ORG_UNIT_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([validRow({ rowRef: 'r1', orgUnitCode: 'NO-SUCH-UNIT' })]);
    expect(codesFor(rawRows, 'r1')).toContain('ORG_UNIT_NOT_FOUND');
  });

  test('เลขที่ตำแหน่งไม่พบใน mdm.position -> POSITION_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([validRow({ rowRef: 'r1', positionNo: 'POS-NOPE' })]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_NOT_FOUND');
  });

  test('พนักงานจ้าง/จ้างเหมาบริการรายบุคคลไม่มีเลขที่ตำแหน่ง -> ไม่ error POSITION_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([
      validRow({ rowRef: 'general', personnelTypeRaw: 'พนักงานจ้างทั่วไป', positionNo: '' }),
      validRow({ rowRef: 'outsource', personnelTypeRaw: 'จ้างเหมาบริการ', positionNo: '' }),
    ]);
    expect(codesFor(rawRows, 'general')).not.toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'outsource')).not.toContain('POSITION_NOT_FOUND');
    const generalRow = rawRows.find((r) => r.row_ref === 'general');
    expect(generalRow.quality_status).toBe('OK');
    expect(generalRow.resolved_position_id).toBeNull();
  });

  test('ข้าราชการ/ครู/ลูกจ้างประจำ/ถ่ายโอน ยังต้องมีเลขที่ตำแหน่งเหมือนเดิม -> POSITION_NOT_FOUND', async () => {
    const { rawRows } = await loadAndCheck([
      validRow({ rowRef: 'civil', personnelTypeRaw: 'ข้าราชการ อบจ.', positionNo: '' }),
    ]);
    expect(codesFor(rawRows, 'civil')).toContain('POSITION_NOT_FOUND');
  });

  test('ตำแหน่งมีจริงแต่สังกัดคนละหน่วยกับที่ระบุในแถว -> POSITION_ORG_UNIT_MISMATCH', async () => {
    // POS-0001 สังกัด org_unit "PERSONNEL" (กองการเจ้าหน้าที่) ไม่ใช่ "PERSONNEL-ADMIN"
    const { rawRows } = await loadAndCheck([
      validRow({ rowRef: 'r1', positionNo: 'POS-0001', orgUnitCode: 'PERSONNEL-ADMIN' }),
    ]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_ORG_UNIT_MISMATCH');
  });

  test('ชื่อ/นามสกุลว่าง หรือมีตัวเลขปน -> NAME_FORMAT_INVALID', async () => {
    const { rawRows } = await loadAndCheck([
      validRow({ rowRef: 'empty', expectedFirstNameTh: '' }),
      validRow({ rowRef: 'digit', expectedLastNameTh: 'สมชาย1' }),
    ]);
    expect(codesFor(rawRows, 'empty')).toContain('NAME_FORMAT_INVALID');
    expect(codesFor(rawRows, 'digit')).toContain('NAME_FORMAT_INVALID');
  });

  test('ประเภทบุคลากรไม่มีอยู่ใน personnel-type-map.json -> PERSONNEL_TYPE_NOT_MAPPED', async () => {
    const { rawRows } = await loadAndCheck([validRow({ rowRef: 'r1', personnelTypeRaw: 'ไม่รู้จัก' })]);
    expect(codesFor(rawRows, 'r1')).toContain('PERSONNEL_TYPE_NOT_MAPPED');
  });

  test('สถานะที่ไม่ใช่ปฏิบัติงาน -> EMPLOYMENT_STATUS_NOT_SUPPORTED (API ยังไม่รองรับฟิลด์นี้)', async () => {
    const { rawRows } = await loadAndCheck([validRow({ rowRef: 'r1', employmentStatusRaw: 'ลาออก' })]);
    expect(codesFor(rawRows, 'r1')).toContain('EMPLOYMENT_STATUS_NOT_SUPPORTED');
  });

  test('วันที่แปลงไม่ได้ -> DATE_FORMAT_INVALID', async () => {
    const { rawRows } = await loadAndCheck([validRow({ rowRef: 'r1', effectiveFromRaw: 'ไม่ใช่วันที่' })]);
    expect(codesFor(rawRows, 'r1')).toContain('DATE_FORMAT_INVALID');
  });

  test('batch status เปลี่ยนเป็น QUALITY_CHECKED หลังตรวจ', async () => {
    const { batchId } = await loadAndCheck([validRow()]);
    const { rows } = await adminPool.query(`SELECT status FROM stg_hr.import_batch WHERE batch_id = $1`, [batchId]);
    expect(rows[0].status).toBe('QUALITY_CHECKED');
  });
});
