const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// ยืนยันว่า migration 1700000000034 seed ตำแหน่งจริงแรก (นักวิชาการคอมพิวเตอร์ สังกัด YB) ถูกต้อง
// และไม่กระทบ org_unit 11 หน่วยงานที่ seed ไว้ก่อนหน้าใน 1700000000033 - ยืนยันข้อมูลจากผู้ใช้ตรง ๆ

const POSITION_NO = '52-1-07-3106-003';
const ORG_UNIT_CODE = 'YB';
const ALL_ORG_UNIT_CODES = ['HQ', 'SP', 'SL', 'KL', 'SC', 'SS', 'YB', 'ED', 'TS', 'PD', 'PS'];

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

test('seed ตำแหน่ง นักวิชาการคอมพิวเตอร์ ถูกต้องครบ ผูกกับ org_unit YB จริง', async () => {
  const { rows } = await pool.query(
    `SELECT p.position_no, p.title_th, p.line_of_work, p.position_type, p.is_active, p.org_unit_id, ou.code AS org_unit_code
     FROM mdm.position p
     JOIN mdm.org_unit ou ON ou.org_unit_id = p.org_unit_id
     WHERE p.position_no = $1`,
    [POSITION_NO]
  );

  expect(rows).toHaveLength(1);
  const position = rows[0];
  expect(position.title_th).toBe('นักวิชาการคอมพิวเตอร์');
  expect(position.line_of_work).toBeNull();
  expect(position.position_type).toBe('ACADEMIC');
  expect(position.is_active).toBe(true);
  expect(position.org_unit_code).toBe(ORG_UNIT_CODE);
});

test('org_unit_id ของตำแหน่งนี้ตรงกับ org_unit_id จริงของ code YB (ไม่ใช่แค่ code ตรงกันโดยบังเอิญ)', async () => {
  const { rows: orgUnitRows } = await pool.query(`SELECT org_unit_id FROM mdm.org_unit WHERE code = $1`, [
    ORG_UNIT_CODE,
  ]);
  expect(orgUnitRows).toHaveLength(1);

  const { rows: positionRows } = await pool.query(
    `SELECT org_unit_id FROM mdm.position WHERE position_no = $1`,
    [POSITION_NO]
  );
  expect(positionRows).toHaveLength(1);
  expect(positionRows[0].org_unit_id).toBe(orgUnitRows[0].org_unit_id);
});

test('org_unit 11 หน่วยงานจาก migration ก่อนหน้ายังอยู่ครบ ไม่ถูกกระทบจาก migration นี้', async () => {
  const { rows } = await pool.query(`SELECT code FROM mdm.org_unit WHERE code = ANY($1::varchar[])`, [
    ALL_ORG_UNIT_CODES,
  ]);
  expect(rows.map((r) => r.code).sort()).toEqual([...ALL_ORG_UNIT_CODES].sort());
});
