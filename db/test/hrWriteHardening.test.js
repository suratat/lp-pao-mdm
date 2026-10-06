const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// migration 1700000000049 (emergency_contact.* ไม่เก็บค่าใน audit) และ 1700000000050 (employment.separation_reason varchar(500))

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

describe('migration 049: field_policy emergency_contact.*', () => {
  test('ทุกฟิลด์ของผู้ติดต่อฉุกเฉินตั้ง log_values_in_audit = false และฟิลด์อื่นไม่ถูกแตะ', async () => {
    const { rows } = await pool.query(`SELECT field_key, log_values_in_audit FROM mdm.field_policy WHERE field_key LIKE 'emergency_contact.%' ORDER BY field_key`);
    expect(rows).toEqual([
      { field_key: 'emergency_contact.full_name', log_values_in_audit: false },
      { field_key: 'emergency_contact.phone', log_values_in_audit: false },
      { field_key: 'emergency_contact.relationship', log_values_in_audit: false },
    ]);
    // ฟิลด์ข้อมูลติดต่อของเจ้าตัวเองยังเก็บค่า (ซ่อนเฉพาะตอนแสดงผล DPO)
    const { rows: contact } = await pool.query(`SELECT log_values_in_audit FROM mdm.field_policy WHERE field_key = 'contact.mobile_phone'`);
    expect(contact[0].log_values_in_audit).toBe(true);
  });
});

describe('migration 050: employment.separation_reason', () => {
  test('เก็บเหตุผลยาว 500 ตัวอักษรได้ (เท่ากับ maxLength ของ reason ใน OpenAPI) และ 501 ไม่ได้', async () => {
    const { rows } = await pool.query(
      `SELECT character_maximum_length FROM information_schema.columns WHERE table_schema = 'mdm' AND table_name = 'employment' AND column_name = 'separation_reason'`
    );
    expect(rows[0].character_maximum_length).toBe(500);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: org } = await client.query(`INSERT INTO mdm.org_unit (code, name_th, unit_level) VALUES ($1, 'หน่วยงานทดสอบ', 'DIVISION') RETURNING org_unit_id`, [`T-${crypto.randomUUID()}`]);
      const { rows: person } = await client.query(`INSERT INTO mdm.person (pid_hash, status, verification_status) VALUES ($1, 'ACTIVE', 'VERIFIED') RETURNING person_id`, [crypto.randomBytes(32).toString('hex')]);
      const insert = (reason) =>
        client.query(
          `INSERT INTO mdm.employment (person_id, employee_no, personnel_type, org_unit_id, effective_from, is_current, employment_status, separation_reason, updated_by)
           VALUES ($1, $2, 'OUTSOURCE_INDIVIDUAL', $3, '2024-01-01', false, 'RESIGNED', $4, 'test')`,
          [person[0].person_id, `E-${crypto.randomUUID()}`, org[0].org_unit_id, reason]
        );
      await expect(insert('ก'.repeat(500))).resolves.toBeDefined();
      await client.query('SAVEPOINT a');
      await expect(insert('ก'.repeat(501))).rejects.toThrow(/too long/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
