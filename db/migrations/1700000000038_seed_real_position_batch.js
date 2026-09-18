/* eslint-disable camelcase */

const fs = require('node:fs');
const path = require('node:path');

exports.shorthands = undefined;

// Seed ตำแหน่งจริงของ อบจ.ลำปาง (~1,025 ตำแหน่ง) เข้า mdm.position จากไฟล์
// migrate/data/position-seed-data.csv (คอลัมน์: sheet, position_no, title_th, org_unit_code,
// position_type_code) - ยืนยันจากผู้ใช้ตรง ๆ ครอบคลุม 4 กลุ่ม: ข้าราชการ (356), ขรก.ถ่ายโอน รพ.สต.
// (658, position_no มีหาง " (ถ)" ต่อท้ายเก็บตามไฟล์เป๊ะ ทั้งหมดสังกัด SS), ลูกจ้างประจำ (2, position_no
// เป็นตัวเลขล้วนไม่มี prefix), คณะผู้บริหาร (9)
//
// *** คณะผู้บริหาร (EX-001 ถึง EX-009): position_no เป็นเลขจำลอง ไม่ใช่เลขที่ตำแหน่งทางการจริง ***
// ฝ่ายการเมือง (นายก/รองนายก/เลขานุการนายก/ที่ปรึกษานายก/ผู้ช่วยผู้บริหาร) เป็นฝ่ายการเมือง ไม่ใช่
// ข้าราชการประจำ จึงไม่มีเลขที่ตำแหน่งตามกรอบอัตรากำลังจริง - EX-xxx ใส่ไว้เพียงเพื่อเติมคอลัมน์
// position_no ที่เป็น NOT NULL + UNIQUE ของ mdm.position เท่านั้น ห้ามใช้เป็นเลขอ้างอิงจริงกับหน่วยงาน
// ภายนอกหรือเอกสารราชการใด ๆ
//
// ไฟล์ CSV นี้ไม่มี comma/quote ปนอยู่ในฟิลด์ใด (ตรวจตรงกับข้อมูลจริงก่อนเขียน migration นี้) - แยกฟิลด์
// ด้วย split(',') ธรรมดาก็พอ ไม่ต้องเพิ่ม dependency csv-parse ที่ root workspace (มีอยู่แล้วเฉพาะใน
// migrate/ - เป็น workspace แยก ไม่ได้แชร์ node_modules กับ db/migrations ที่รันจาก root)
//
// พบว่า CSV เต็มมีแถว position_no = 52-1-07-3106-003 (นักวิชาการคอมพิวเตอร์, YB, ACADEMIC) ซ้ำกับที่
// seed ไปแล้วใน 1700000000034_seed_first_real_position.js (เนื้อหาตรงกันทุกฟิลด์ - เป็น pilot record
// เดียวกัน ไม่ใช่ตำแหน่งคนละตำแหน่งที่บังเอิญเลขชนกัน) - migration นี้ข้าม insert แถวนี้ (ของเดิมยังอยู่)
// และ down() ก็ต้องไม่ลบมันด้วย (เป็นของ migration 034 ไม่ใช่ของ migration นี้) ถ้าพบ position_no อื่น
// ที่ซ้ำนอกเหนือจากนี้ ให้ throw ทันที (ไม่ข้ามเงียบ ๆ) เพราะเป็นสิ่งที่ไม่คาดคิด ต้องตรวจสอบก่อน
//
// ก่อนรัน migration นี้บน staging/production จริง ให้รัน
// db/preflight/1700000000038_check_position_seed_data.sql ก่อนเสมอ (read-only ตรวจแบบเดียวกับที่
// migration นี้ตรวจเองด้านล่าง แต่ให้เจ้าของระบบเห็นผลก่อน deploy จริง)
const KNOWN_DUPLICATE_POSITION_NOS = new Set(['52-1-07-3106-003']);

const CSV_PATH = path.join(__dirname, '..', '..', 'migrate', 'data', 'position-seed-data.csv');

function parseCsv(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [header, ...dataLines] = lines;
  const columns = header.split(',').map((c) => c.trim());
  return dataLines.map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    columns.forEach((col, i) => {
      row[col] = values[i] ?? '';
    });
    return row;
  });
}

exports.up = async (pgm) => {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));

  // --- dry-run (ข้อ 2): ตรวจว่า org_unit_code / position_type_code ทุกค่าที่ CSV ใช้ lookup เจอจริง
  // ก่อน insert แถวใด ๆ - ถ้าพบค่าที่ไม่มีอยู่จริง ให้ throw ทันที (migration ทั้งไฟล์ rollback อัตโนมัติ
  // เพราะ node-pg-migrate รันแต่ละ migration ใน transaction เดียว ไม่มีแถวใดถูก insert ค้างไว้บางส่วน)
  const orgUnitCodes = [...new Set(rows.map((r) => r.org_unit_code))];
  const positionTypeCodes = [...new Set(rows.map((r) => r.position_type_code))];

  const { rows: orgUnitRows } = await pgm.db.query(
    `SELECT org_unit_id, code FROM mdm.org_unit WHERE code = ANY($1::varchar[])`,
    [orgUnitCodes]
  );
  const orgUnitIdByCode = new Map(orgUnitRows.map((r) => [r.code, r.org_unit_id]));
  const missingOrgUnitCodes = orgUnitCodes.filter((c) => !orgUnitIdByCode.has(c));
  if (missingOrgUnitCodes.length > 0) {
    throw new Error(`พบ org_unit_code ใน CSV ที่ไม่มีอยู่จริงใน mdm.org_unit: ${missingOrgUnitCodes.join(', ')}`);
  }

  const { rows: positionTypeRows } = await pgm.db.query(
    `SELECT code FROM mdm.position_type WHERE code = ANY($1::varchar[])`,
    [positionTypeCodes]
  );
  const knownPositionTypeCodes = new Set(positionTypeRows.map((r) => r.code));
  const missingPositionTypeCodes = positionTypeCodes.filter((c) => !knownPositionTypeCodes.has(c));
  if (missingPositionTypeCodes.length > 0) {
    throw new Error(
      `พบ position_type_code ใน CSV ที่ไม่มีอยู่จริงใน mdm.position_type: ${missingPositionTypeCodes.join(', ')}`
    );
  }

  // --- ข้อ 3: ยืนยันไม่มี position_no ซ้ำกับตำแหน่งที่ seed ไว้ก่อนหน้าทั้งหมด (นักวิชาการคอมพิวเตอร์ YB
  // เป็นข้อยกเว้นที่รู้อยู่แล้ว - ดู comment ด้านบน) ---
  const csvPositionNos = rows.map((r) => r.position_no);
  const { rows: existingRows } = await pgm.db.query(
    `SELECT position_no FROM mdm.position WHERE position_no = ANY($1::varchar[])`,
    [csvPositionNos]
  );
  const existingPositionNos = new Set(existingRows.map((r) => r.position_no));
  const unexpectedDuplicates = [...existingPositionNos].filter((no) => !KNOWN_DUPLICATE_POSITION_NOS.has(no));
  if (unexpectedDuplicates.length > 0) {
    throw new Error(
      `พบ position_no ซ้ำที่ไม่คาดคิด (นอกเหนือจาก ${[...KNOWN_DUPLICATE_POSITION_NOS].join(
        ', '
      )} ที่รู้อยู่แล้วว่าเป็น pilot record เดียวกัน): ${unexpectedDuplicates.join(', ')}`
    );
  }

  const rowsToInsert = rows.filter((r) => !existingPositionNos.has(r.position_no));

  // --- insert จริง (ข้อ 1) ---
  for (const row of rowsToInsert) {
    await pgm.db.query(
      `INSERT INTO mdm.position (position_no, title_th, line_of_work, position_type, org_unit_id, is_active)
       VALUES ($1, $2, NULL, $3, $4, true)`,
      [row.position_no, row.title_th, row.position_type_code, orgUnitIdByCode.get(row.org_unit_code)]
    );
  }

  // --- รายงานสรุป (ข้อ 4) ---
  const byOrgUnit = {};
  const byPositionType = {};
  for (const row of rowsToInsert) {
    byOrgUnit[row.org_unit_code] = (byOrgUnit[row.org_unit_code] ?? 0) + 1;
    byPositionType[row.position_type_code] = (byPositionType[row.position_type_code] ?? 0) + 1;
  }
  console.log(
    `[1700000000038] เพิ่มตำแหน่งสำเร็จ ${rowsToInsert.length} ตำแหน่ง (ข้าม ${existingPositionNos.size} ตำแหน่งที่มีอยู่ก่อนแล้ว: ${[
      ...existingPositionNos,
    ].join(', ')})`
  );
  console.log('[1700000000038] แยกตาม org_unit:', byOrgUnit);
  console.log('[1700000000038] แยกตาม position_type:', byPositionType);
};

exports.down = async (pgm) => {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  // ไม่ลบ position_no ที่รู้อยู่แล้วว่าเป็นของ migration 1700000000034 (ไม่ใช่ของ migration นี้)
  const positionNosToDelete = rows.map((r) => r.position_no).filter((no) => !KNOWN_DUPLICATE_POSITION_NOS.has(no));

  await pgm.db.query(`DELETE FROM mdm.position WHERE position_no = ANY($1::varchar[])`, [positionNosToDelete]);
};
