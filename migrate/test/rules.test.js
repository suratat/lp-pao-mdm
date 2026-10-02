const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL, MIGRATOR_DATABASE_URL } = require('./config');
const { loadBatch } = require('../src/loader/loadBatch');
const { runQualityCheck } = require('../src/quality/rules');
const { mapPersonnelType } = require('../src/quality/personnelTypeMap');
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

// ตำแหน่งทดสอบ "สั้น" สำหรับเทสต์ที่ต้องต่อท้าย "(ถ)" แล้วห้ามเกิน varchar(50) ของ mdm.position.position_no -
// ต่างจาก makePosition() ที่ยาวพอดี 48 ตัวอักษร (POS-MIGRATE-<uuid>) ต่อท้าย "  (ถ)" แล้วเกิน 50 ทันที (ไม่แก้
// makePosition() เพราะเทสต์อื่นในไฟล์นี้ผูกความยาวเดิมไว้อยู่) ใช้ prefix "TST-" + hex 8 ตัว = 12 ตัวอักษร
async function makeShortPosition(adminPool, orgUnitId) {
  const positionNo = `TST-${crypto.randomBytes(4).toString('hex')}`;
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบสั้น', 'GENERAL', $2) RETURNING position_id`,
    [positionNo, orgUnitId]
  );
  return { positionNo, positionId: rows[0].position_id };
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
      // 'พนักงานจ้าง' คือคีย์จริงใน personnel-type-map.json (ยืนยันจากไฟล์ HR ต้นทางจริง, commit 2e16d9b) - ไม่ใช่
      // 'พนักงานจ้างทั่วไป' ซึ่งเป็นป้ายบรรยายของ enum GENERAL_EMPLOYEE ใน OpenAPI (คนละอย่างกับ raw label ของ HR)
      defaultRow({ rowRef: 'general', personnelTypeRaw: 'พนักงานจ้าง', positionNo: '' }),
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

  // 'ข้าราชการองค์การบริหารส่วนจังหวัด' (ชื่อเต็ม) กับ 'ข้าราชการ อบจ.' (ชื่อย่อ) คือประเภทบุคลากรเดียวกัน - ยืนยันจากไฟล์ HR
  // จริงที่ฝ่ายบุคคลส่งมา ทั้งสองคีย์ต้อง map ไปที่ CIVIL_SERVANT เหมือนกัน (เพิ่มคีย์ใหม่เข้า personnel-type-map.json
  // โดยไม่แก้คีย์เดิม)
  test('"ข้าราชการองค์การบริหารส่วนจังหวัด" (ชื่อเต็ม) map เป็น CIVIL_SERVANT เหมือน "ข้าราชการ อบจ." (ชื่อย่อ)', () => {
    expect(mapPersonnelType('ข้าราชการองค์การบริหารส่วนจังหวัด')).toBe('CIVIL_SERVANT');
    expect(mapPersonnelType('ข้าราชการองค์การบริหารส่วนจังหวัด')).toBe(mapPersonnelType('ข้าราชการ อบจ.'));
  });

  test('แถวที่ personnelTypeRaw = "ข้าราชการองค์การบริหารส่วนจังหวัด" ผ่านกฎคุณภาพเหมือน "ข้าราชการ อบจ." (ต้องมีตำแหน่งเหมือนกัน)', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'full-name-with-pos', personnelTypeRaw: 'ข้าราชการองค์การบริหารส่วนจังหวัด' }),
      defaultRow({ rowRef: 'full-name-no-pos', personnelTypeRaw: 'ข้าราชการองค์การบริหารส่วนจังหวัด', positionNo: '' }),
    ]);
    // ไม่ error PERSONNEL_TYPE_NOT_MAPPED (เคย map ไม่เจอก่อนเพิ่มคีย์นี้) และผ่าน OK เหมือน 'ข้าราชการ อบจ.' ทุกประการ
    expect(codesFor(rawRows, 'full-name-with-pos')).not.toContain('PERSONNEL_TYPE_NOT_MAPPED');
    expect(rawRows.find((r) => r.row_ref === 'full-name-with-pos').quality_status).toBe('OK');
    // ไม่มีตำแหน่ง -> ยังคงต้อง POSITION_NOT_FOUND เหมือนกับประเภท REQUIRED อื่น (ไม่ได้ถูกจัดเป็นกลุ่ม optional ผิดๆ)
    expect(codesFor(rawRows, 'full-name-no-pos')).toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'full-name-no-pos')).not.toContain('PERSONNEL_TYPE_NOT_MAPPED');
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

// PR 2: wire api/src/services/positionNoMatch.js เข้า checkRow/loadLookups - แยก "พิมพ์เลขต่างแค่ format"
// (POSITION_NO_SIMILAR_EXISTS) ออกจาก "ไม่มีตำแหน่งนี้จริง" (POSITION_NOT_FOUND) ไม่ resolve ให้อัตโนมัติ
describe('runQualityCheck: POSITION_NO_SIMILAR_EXISTS / POSITION_NO_KEY_COLLISION (normalize เลขที่ตำแหน่ง)', () => {
  test('position_no ไม่ตรงตัว แต่ normalize แล้วตรงกับตำแหน่งที่มีอยู่ (เว้นวรรค 2 ช่องก่อน "(ถ)") -> POSITION_NO_SIMILAR_EXISTS ระบุเลขที่ตรง ไม่มี POSITION_NOT_FOUND ปน resolved_position_id เป็น null', async () => {
    const { positionNo: shortNo, positionId: shortId } = await makeShortPosition(adminPool, orgUnitA.orgUnitId);
    const similarInput = `${shortNo}  (ถ)`;
    expect(similarInput.length).toBeLessThanOrEqual(50); // กันล้มซ้ำแบบ "value too long for type character varying(50)"
    try {
      const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', positionNo: similarInput })]);
      expect(codesFor(rawRows, 'r1')).toContain('POSITION_NO_SIMILAR_EXISTS');
      expect(codesFor(rawRows, 'r1')).not.toContain('POSITION_NOT_FOUND');
      const row = rawRows.find((r) => r.row_ref === 'r1');
      const similarError = row.quality_errors.find((e) => e.code === 'POSITION_NO_SIMILAR_EXISTS');
      expect(similarError.message).toContain(shortNo);
      expect(row.resolved_position_id).toBeNull();
    } finally {
      await adminPool.query(`DELETE FROM mdm.position WHERE position_id = $1`, [shortId]);
    }
  });

  // กัน regression ของเทสต์เดิม (บรรทัด "เลขที่ตำแหน่งไม่พบใน mdm.position -> POSITION_NOT_FOUND" ด้านบน) หลังเพิ่ม
  // branch POSITION_NO_SIMILAR_EXISTS: ต้องยังคงเป็น POSITION_NOT_FOUND เท่านั้นเมื่อไม่ตรงใครเลยแม้ normalize แล้ว
  test('position_no ไม่ตรงใครเลยแม้ normalize แล้ว -> POSITION_NOT_FOUND เท่านั้น ไม่มี POSITION_NO_SIMILAR_EXISTS', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', positionNo: 'POS-NOPE' })]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'r1')).not.toContain('POSITION_NO_SIMILAR_EXISTS');
  });

  // ยืนยันแล้วว่า mdm.position มี UNIQUE INDEX บน position_no จริง (position_position_no_unique_index, migration
  // 1700000000006) - INSERT ตำแหน่งทดสอบของเทสต์นี้ต้องใช้ position_no ที่สุ่มไม่ซ้ำกับข้อมูลจริงที่ seed มา
  // (makeShortPosition ใช้ "TST-" + hex สุ่มจึงปลอดภัย) และลบออกด้วย position_id จาก RETURNING เท่านั้น ไม่ใช่ position_no
  test('มี 2 ตำแหน่ง active ใน mdm.position ที่ normalize แล้วชนกัน -> runQualityCheck throw code POSITION_NO_KEY_COLLISION ไม่ crash แบบไม่มีคำอธิบาย และ batch ไม่กลายเป็น QUALITY_CHECKED', async () => {
    const { positionNo: collisionBaseNo, positionId: collisionBaseId } = await makeShortPosition(
      adminPool,
      orgUnitA.orgUnitId
    );
    const collisionSimilarNo = `${collisionBaseNo}  (ถ)`;
    expect(collisionSimilarNo.length).toBeLessThanOrEqual(50); // กันล้มซ้ำแบบ "value too long for type character varying(50)"

    const { rows: similarRows } = await adminPool.query(
      `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
       VALUES ($1, 'ตำแหน่งทดสอบชนกัน', 'GENERAL', $2) RETURNING position_id`,
      [collisionSimilarNo, orgUnitA.orgUnitId]
    );
    const collisionSimilarId = similarRows[0].position_id;

    try {
      const { batchId } = await loadBatch(pool, {
        csvContent: buildCsv([defaultRow({ rowRef: 'r1' })]),
        columnMap: defaultColumnMap,
        sourceFilename: 'collision.csv',
        importedBy: 'tester',
      });

      let thrown;
      try {
        await runQualityCheck(pool, batchId);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe('POSITION_NO_KEY_COLLISION');

      const { rows } = await adminPool.query(`SELECT status FROM stg_hr.import_batch WHERE batch_id = $1`, [batchId]);
      expect(rows[0].status).not.toBe('QUALITY_CHECKED');
    } finally {
      // ต้องลบตำแหน่งทดสอบทั้งสองออกเสมอ (ด้วย position_id เท่านั้น) ไม่งั้นทุกเทสต์หลังจากนี้ในไฟล์นี้จะ throw
      // ตามไปด้วย (positionBySimilarKey สร้างจากตำแหน่ง active "ทั้งหมด" ไม่ใช่เฉพาะของเทสต์นี้)
      await adminPool.query(`DELETE FROM mdm.position WHERE position_id = ANY($1::uuid[])`, [
        [collisionBaseId, collisionSimilarId],
      ]);
    }
  });

  test('position_no ว่างสำหรับประเภทที่ไม่บังคับมีตำแหน่ง -> ไม่เกิด POSITION_NO_SIMILAR_EXISTS', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'r1', personnelTypeRaw: 'พนักงานจ้าง', positionNo: '' }),
    ]);
    expect(codesFor(rawRows, 'r1')).not.toContain('POSITION_NO_SIMILAR_EXISTS');
    expect(codesFor(rawRows, 'r1')).not.toContain('POSITION_NOT_FOUND');
  });

  // เคสจริงของระบบ (ยืนยันจากฐานข้อมูลจริง): mdm.position ที่ seed มาจากไฟล์จริงมีแถว "52-1-06-3601-007 (ถ)" อยู่แล้ว
  // (ไม่ใช่ข้อมูลที่เทสต์สร้างเอง) - ใช้แถวนี้ตรงๆ ห้าม INSERT ซ้ำ (จะชน UNIQUE INDEX ของ position_no) และห้าม DELETE
  // ข้อมูล seed จริงทิ้ง ถ้าแถวนี้หายไปจาก seed ในอนาคต ให้เทสต์ fail ชัดเจนแทนการสร้างใหม่เงียบๆ
  test('เคสจริงของระบบ: mdm.position (seed จริง) มี "52-1-06-3601-007 (ถ)" ไฟล์ส่ง "52-1-06-3601-007" เฉยๆ -> POSITION_NO_SIMILAR_EXISTS', async () => {
    const realPositionNo = '52-1-06-3601-007 (ถ)';
    const { rows: existing } = await adminPool.query(`SELECT position_id FROM mdm.position WHERE position_no = $1`, [
      realPositionNo,
    ]);
    if (existing.length === 0) {
      throw new Error(
        `ไม่พบตำแหน่ง seed จริง "${realPositionNo}" ใน mdm.position ของ DB ทดสอบ - เทสต์นี้อ้างอิงข้อมูลจริงจาก ` +
          'position-seed-data.csv โดยตรง ถ้าข้อมูล seed เปลี่ยน ต้องปรับเทสต์นี้ใหม่ ไม่ใช่สร้างตำแหน่งนี้ขึ้นเอง'
      );
    }

    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', positionNo: '52-1-06-3601-007' })]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_NO_SIMILAR_EXISTS');
    const row = rawRows.find((r) => r.row_ref === 'r1');
    const similarError = row.quality_errors.find((e) => e.code === 'POSITION_NO_SIMILAR_EXISTS');
    expect(similarError.message).toContain(realPositionNo);
  });

  // เช่นเดียวกับข้างบน: "2" เป็นตำแหน่ง seed จริง (ลูกจ้างประจำสังกัด SC) ไม่ใช่ตำแหน่งที่เทสต์สร้างเอง
  test('เลขที่ตำแหน่งล้วนไม่มีขีด ("2", seed จริง) ที่พบตรงตัว -> ผ่านปกติ resolved_position_id ไม่เป็น null ไม่ติด SIMILAR/NOT_FOUND', async () => {
    const { rows: existing } = await adminPool.query(`SELECT position_id FROM mdm.position WHERE position_no = '2'`);
    if (existing.length === 0) {
      throw new Error(
        'ไม่พบตำแหน่ง seed จริง position_no = "2" ใน mdm.position ของ DB ทดสอบ - เทสต์นี้อ้างอิงข้อมูลจริงจาก ' +
          'position-seed-data.csv โดยตรง ถ้าข้อมูล seed เปลี่ยน ต้องปรับเทสต์นี้ใหม่ ไม่ใช่สร้างตำแหน่งนี้ขึ้นเอง'
      );
    }
    const bareNumberPositionId = existing[0].position_id;

    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', positionNo: '2' })]);
    expect(codesFor(rawRows, 'r1')).not.toContain('POSITION_NOT_FOUND');
    expect(codesFor(rawRows, 'r1')).not.toContain('POSITION_NO_SIMILAR_EXISTS');
    const row = rawRows.find((r) => r.row_ref === 'r1');
    expect(row.resolved_position_id).toBe(bareNumberPositionId);
  });
});

// ชื่อตำแหน่ง/ลักษณะงาน (jobTitleText) สำหรับประเภทบุคลากรที่ไม่มีเลขที่ตำแหน่ง - กฎเดียวกับ api/src/services/jobTitleText.js
// (เรียกฟังก์ชันเดิมตรงๆ ไม่ duplicate logic) error code ต้องตรงกับที่ API ใช้ (PR #40/#44) เพื่อให้รายงานผลสอดคล้องกัน
describe('runQualityCheck: jobTitleText (ชื่อตำแหน่ง/ลักษณะงาน)', () => {
  test('ประเภทที่ไม่มีตำแหน่ง (พนักงานจ้าง) ใส่ jobTitleText ได้ -> OK ไม่มี error', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'r1', personnelTypeRaw: 'พนักงานจ้าง', positionNo: '', jobTitleText: 'พนักงานขับรถยนต์' }),
    ]);
    expect(rawRows[0].quality_status).toBe('OK');
    expect(codesFor(rawRows, 'r1')).toEqual([]);
  });

  test('ประเภท OTHER ไม่ใส่เลย / ใส่ตำแหน่งอย่างเดียว / ใส่ jobTitleText อย่างเดียว -> ผ่านทั้ง 3 แบบ', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'none', personnelTypeRaw: 'อื่นๆ', positionNo: '' }),
      defaultRow({ rowRef: 'pos-only', personnelTypeRaw: 'อื่นๆ', positionNo: positionA }),
      defaultRow({ rowRef: 'text-only', personnelTypeRaw: 'อื่นๆ', positionNo: '', jobTitleText: 'อาสาสมัครประจำศูนย์' }),
    ]);
    for (const rowRef of ['none', 'pos-only', 'text-only']) {
      expect(codesFor(rawRows, rowRef)).toEqual([]);
    }
  });

  test('ประเภทที่ต้องมีตำแหน่ง (ข้าราชการ) ส่ง jobTitleText มาด้วย -> JOB_TITLE_NOT_ALLOWED', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'r1', personnelTypeRaw: 'ข้าราชการ อบจ.', jobTitleText: 'ตำแหน่งพิเศษ' }),
    ]);
    expect(codesFor(rawRows, 'r1')).toContain('JOB_TITLE_NOT_ALLOWED');
  });

  test('ประเภท OTHER ส่งทั้งเลขที่ตำแหน่งและ jobTitleText พร้อมกัน -> POSITION_AND_JOB_TITLE_CONFLICT', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'r1', personnelTypeRaw: 'อื่นๆ', positionNo: positionA, jobTitleText: 'อาสาสมัคร' }),
    ]);
    expect(codesFor(rawRows, 'r1')).toContain('POSITION_AND_JOB_TITLE_CONFLICT');
  });

  test('jobTitleText มีเลขบัตรประชาชน 13 หลัก (ติดกัน/มีขีด) -> JOB_TITLE_CONTAINS_PID ไม่ echo ข้อความกลับ', async () => {
    const pid = require('../../api/src/security/pid').makeFakePid();
    const dashed = `${pid.slice(0, 1)}-${pid.slice(1, 5)}-${pid.slice(5, 10)}-${pid.slice(10, 12)}-${pid.slice(12)}`;
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'plain', personnelTypeRaw: 'พนักงานจ้าง', positionNo: '', jobTitleText: `ช่าง ${pid}` }),
      defaultRow({ rowRef: 'dashed', personnelTypeRaw: 'พนักงานจ้าง', positionNo: '', jobTitleText: dashed }),
    ]);
    expect(codesFor(rawRows, 'plain')).toContain('JOB_TITLE_CONTAINS_PID');
    expect(codesFor(rawRows, 'dashed')).toContain('JOB_TITLE_CONTAINS_PID');
    expect(JSON.stringify(rawRows)).not.toContain(pid);
    expect(JSON.stringify(rawRows)).not.toContain(dashed);
  });

  test('jobTitleText ยาวเกิน 255 ตัวอักษร -> JOB_TITLE_TOO_LONG', async () => {
    const { rawRows } = await loadAndCheck([
      defaultRow({ rowRef: 'r1', personnelTypeRaw: 'พนักงานจ้าง', positionNo: '', jobTitleText: 'ก'.repeat(256) }),
    ]);
    expect(codesFor(rawRows, 'r1')).toContain('JOB_TITLE_TOO_LONG');
  });

  test('jobTitleText ว่าง/ไม่ใส่สำหรับประเภทที่ต้องมีตำแหน่ง -> ไม่มี error เกี่ยวกับ jobTitleText (ปกติตามเดิม)', async () => {
    const { rawRows } = await loadAndCheck([defaultRow({ rowRef: 'r1', jobTitleText: '' })]);
    expect(codesFor(rawRows, 'r1')).toEqual([]);
  });
});
