const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// migration 1700000000040: mdm.employment.job_title_text (ชื่อตำแหน่ง/ลักษณะงานแบบข้อความอิสระ) + แถว field_policy
let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

test('คอลัมน์ job_title_text เป็น varchar(255) nullable ไม่มี default', async () => {
  const { rows } = await pool.query(
    `SELECT data_type, character_maximum_length, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'mdm' AND table_name = 'employment' AND column_name = 'job_title_text'`
  );
  expect(rows).toEqual([{ data_type: 'character varying', character_maximum_length: 255, is_nullable: 'YES', column_default: null }]);
});

test('field_policy: employment.job_title_text = HR, INTERNAL, personnel:read:basic, editable_by HR, log ค่าใน audit', async () => {
  const { rows } = await pool.query(`SELECT * FROM mdm.field_policy WHERE field_key = 'employment.job_title_text'`);
  expect(rows).toEqual([
    expect.objectContaining({ table_name: 'employment', column_name: 'job_title_text', source: 'HR', classification: 'INTERNAL', required_scope: 'personnel:read:basic', editable_by: 'HR', log_values_in_audit: true, mask_pattern: null }),
  ]);
});

describe('การเก็บข้อความ', () => {
  let orgUnitId;
  let personId;

  beforeAll(async () => {
    orgUnitId = (await pool.query(`SELECT org_unit_id FROM mdm.org_unit LIMIT 1`)).rows[0].org_unit_id;
    personId = crypto.randomUUID();
    await pool.query(`INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, version) VALUES ($1, $2, 'ACTIVE', 'VERIFIED', 1)`, [
      personId,
      crypto.randomBytes(32).toString('hex'),
    ]);
  });

  const insert = (text) =>
    pool.query(
      `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, org_unit_id, effective_from, is_current, employment_status, updated_by, job_title_text)
       VALUES ($1, $2, 'GENERAL_EMPLOYEE', $3, CURRENT_DATE, false, 'ACTIVE', 'test', $4)`,
      [personId, `EMP-JTDB-${crypto.randomUUID()}`, orgUnitId, text]
    );

  test('เก็บได้ 255 ตัวอักษร, 256 ตัวอักษรถูกปฏิเสธ, NULL ได้', async () => {
    await insert('ก'.repeat(255));
    await insert(null);
    await expect(insert('ก'.repeat(256))).rejects.toThrow(/value too long/);
  });

  test('ไม่ผูกกับ position: แถวที่มีข้อความและ position_id เป็น NULL อยู่ร่วมกับหลายแถวได้', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM mdm.employment WHERE person_id = $1 AND position_id IS NULL AND job_title_text IS NOT NULL`, [personId]);
    expect(rows[0].n).toBe(1);
  });
});
