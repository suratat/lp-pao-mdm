const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// ยืนยันว่า migration 1700000000038 seed ตำแหน่งจริงของ อบจ.ลำปาง (~1,025 ตำแหน่ง) จาก
// migrate/data/position-seed-data.csv ถูกต้องครบ - อ่าน CSV ตัวจริงมาคำนวณค่าที่คาดหวังเอง (ไม่ hardcode
// ตัวเลขซ้ำในเทสนี้) เพื่อไม่ให้เทสหลุดจากไฟล์ต้นทางจริงถ้าไฟล์เปลี่ยนในอนาคต

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

let pool;
let csvRows;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
  csvRows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
});

afterAll(async () => {
  await pool.end();
});

test('จำนวนตำแหน่งทั้งหมดใน mdm.position เท่ากับจำนวนแถวใน CSV พอดี (รวมตำแหน่งที่ seed มาก่อนหน้าซึ่งซ้ำกับ CSV 1 แถว)', async () => {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM mdm.position`);
  expect(rows[0].n).toBe(csvRows.length);
});

test('แยกตาม org_unit ตรงกับ CSV ทุกหน่วยงาน (ข้อ 4)', async () => {
  const { rows } = await pool.query(
    `SELECT ou.code AS org_unit_code, count(*)::int AS n
     FROM mdm.position p
     JOIN mdm.org_unit ou ON ou.org_unit_id = p.org_unit_id
     GROUP BY ou.code`
  );
  const dbByOrgUnit = Object.fromEntries(rows.map((r) => [r.org_unit_code, r.n]));

  const expectedByOrgUnit = {};
  for (const r of csvRows) {
    expectedByOrgUnit[r.org_unit_code] = (expectedByOrgUnit[r.org_unit_code] ?? 0) + 1;
  }

  expect(dbByOrgUnit).toEqual(expectedByOrgUnit);
});

test('แยกตาม position_type ตรงกับ CSV ทุกประเภท (ข้อ 4)', async () => {
  const { rows } = await pool.query(
    `SELECT position_type, count(*)::int AS n FROM mdm.position GROUP BY position_type`
  );
  const dbByPositionType = Object.fromEntries(rows.map((r) => [r.position_type, r.n]));

  const expectedByPositionType = {};
  for (const r of csvRows) {
    expectedByPositionType[r.position_type_code] = (expectedByPositionType[r.position_type_code] ?? 0) + 1;
  }

  expect(dbByPositionType).toEqual(expectedByPositionType);
});

test('ไม่มี position_no ซ้ำกันใน mdm.position (UNIQUE ยังทำงานถูกต้องแม้ insert ทีละมาก ๆ)', async () => {
  const { rows } = await pool.query(
    `SELECT position_no, count(*)::int AS n FROM mdm.position GROUP BY position_no HAVING count(*) > 1`
  );
  expect(rows).toEqual([]);
});

test('ตำแหน่งที่ seed ไว้ก่อนหน้า (นักวิชาการคอมพิวเตอร์ YB) ไม่ถูก insert ซ้ำ - ยังมีอยู่แถวเดียว ค่าตรงกับ CSV (ข้อ 3)', async () => {
  const { rows } = await pool.query(
    `SELECT p.title_th, p.position_type, ou.code AS org_unit_code
     FROM mdm.position p
     JOIN mdm.org_unit ou ON ou.org_unit_id = p.org_unit_id
     WHERE p.position_no = $1`,
    ['52-1-07-3106-003']
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].title_th).toBe('นักวิชาการคอมพิวเตอร์');
  expect(rows[0].position_type).toBe('ACADEMIC');
  expect(rows[0].org_unit_code).toBe('YB');
});

test('คณะผู้บริหาร (EX-001 ถึง EX-009): เลขจำลอง 9 ตำแหน่ง สังกัด EX, position_type = POLITICAL', async () => {
  const { rows } = await pool.query(
    `SELECT p.position_no, p.title_th, ou.code AS org_unit_code
     FROM mdm.position p
     JOIN mdm.org_unit ou ON ou.org_unit_id = p.org_unit_id
     WHERE p.position_type = 'POLITICAL'
     ORDER BY p.position_no`
  );
  expect(rows).toHaveLength(9);
  expect(rows.map((r) => r.position_no)).toEqual([
    'EX-001',
    'EX-002',
    'EX-003',
    'EX-004',
    'EX-005',
    'EX-006',
    'EX-007',
    'EX-008',
    'EX-009',
  ]);
  for (const row of rows) {
    expect(row.org_unit_code).toBe('EX');
  }
});

test('ขรก.ถ่ายโอน รพ.สต.: position_no มีหาง " (ถ)" ต่อท้ายตามไฟล์เป๊ะ ทั้งหมดสังกัด SS (658 ตำแหน่ง)', async () => {
  const { rows } = await pool.query(
    `SELECT p.position_no, ou.code AS org_unit_code
     FROM mdm.position p
     JOIN mdm.org_unit ou ON ou.org_unit_id = p.org_unit_id
     WHERE p.position_no LIKE '% (ถ)'`
  );
  expect(rows).toHaveLength(658);
  for (const row of rows) {
    expect(row.org_unit_code).toBe('SS');
  }
});

test('ลูกจ้างประจำ: position_no เป็นตัวเลขล้วนไม่มี prefix (2 ตำแหน่ง)', async () => {
  const { rows } = await pool.query(
    `SELECT position_no, title_th, position_type FROM mdm.position WHERE position_no = ANY($1::varchar[]) ORDER BY position_no`,
    [['2', '50']]
  );
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.title_th).toBe('ลูกจ้างประจำ');
    expect(row.position_type).toBe('GENERAL');
  }
});
