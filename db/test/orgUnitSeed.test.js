const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// ยืนยันว่า migration 1700000000033 seed โครงสร้างส่วนราชการจริงของ อบจ.ลำปาง ครบและถูกต้อง
// (แทนที่ข้อมูลตัวอย่างของ T8 แล้ว) - รายชื่อ/รหัสยืนยันจากผู้ใช้ตรง ๆ ไม่ใช่จากเอกสารออกแบบ

const CHILD_CODES = ['SP', 'SL', 'KL', 'SC', 'SS', 'YB', 'ED', 'TS', 'PD', 'PS'];
const ALL_CODES = ['HQ', ...CHILD_CODES];

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

test('seed ครบ 11 หน่วยงานจริง ไม่มีข้อมูลตัวอย่าง T8 เหลืออยู่', async () => {
  const { rows } = await pool.query(
    `SELECT code FROM mdm.org_unit WHERE code = ANY($1::varchar[])`,
    [ALL_CODES]
  );
  expect(rows.map((r) => r.code).sort()).toEqual([...ALL_CODES].sort());

  const sample = await pool.query(
    `SELECT code FROM mdm.org_unit
     WHERE code = ANY($1::varchar[])`,
    [['STRATEGY', 'PERSONNEL', 'PERSONNEL-ADMIN', 'PERSONNEL-ADMIN-REG']]
  );
  expect(sample.rows).toHaveLength(0);
});

test('HQ เป็น parent ของอีก 10 หน่วยงาน และไม่มี parent ของตัวเอง', async () => {
  const { rows } = await pool.query(
    `SELECT org_unit_id, code, parent_id FROM mdm.org_unit WHERE code = ANY($1::varchar[])`,
    [ALL_CODES]
  );
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));

  expect(byCode.HQ.parent_id).toBeNull();
  for (const code of CHILD_CODES) {
    expect(byCode[code].parent_id).toBe(byCode.HQ.org_unit_id);
  }
});

test('ทุกหน่วยงานเป็น unit_level=DIVISION, is_active=true, valid_from=2026-09-15', async () => {
  // cast valid_from เป็น text ใน SQL แทนการอ่านเป็น JS Date แล้วเรียก .toISOString() - pg parse คอลัมน์
  // date เป็นเที่ยงคืนตาม timezone ท้องถิ่นของเครื่อง ไม่ใช่ UTC, toISOString() แปลงกลับเป็น UTC จึงอาจ
  // เลื่อนวันผิดถ้าเครื่องอยู่ timezone ที่ UTC- (พบจริงตอนรัน test นี้)
  const { rows } = await pool.query(
    `SELECT unit_level, is_active, valid_from::text AS valid_from FROM mdm.org_unit WHERE code = ANY($1::varchar[])`,
    [ALL_CODES]
  );
  expect(rows).toHaveLength(11);
  for (const row of rows) {
    expect(row.unit_level).toBe('DIVISION');
    expect(row.is_active).toBe(true);
    expect(row.valid_from).toBe('2026-09-15');
  }
});
