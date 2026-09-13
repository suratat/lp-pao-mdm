const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

test('สร้าง schema ครบทั้ง 3 (mdm, audit, integration)', async () => {
  const { rows } = await pool.query(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name IN ('mdm', 'audit', 'integration') ORDER BY schema_name`
  );
  expect(rows.map((r) => r.schema_name)).toEqual(['audit', 'integration', 'mdm']);
});

test('สร้าง role ครบทั้ง 4 (mdm_app, mdm_worker, mdm_readonly, mdm_audit)', async () => {
  const { rows } = await pool.query(
    `SELECT rolname FROM pg_roles
     WHERE rolname IN ('mdm_app', 'mdm_worker', 'mdm_readonly', 'mdm_audit') ORDER BY rolname`
  );
  expect(rows.map((r) => r.rolname)).toEqual(['mdm_app', 'mdm_audit', 'mdm_readonly', 'mdm_worker']);
});

test('mdm_readonly เห็นคอลัมน์ทั่วไปของ person แต่ไม่เห็น pid_enc', async () => {
  const { rows } = await pool.query(
    `SELECT
       has_column_privilege('mdm_readonly', 'mdm.person', 'pid_enc', 'SELECT') AS can_see_pid_enc,
       has_column_privilege('mdm_readonly', 'mdm.person', 'status', 'SELECT') AS can_see_status`
  );
  expect(rows[0].can_see_pid_enc).toBe(false);
  expect(rows[0].can_see_status).toBe(true);
});

test('seed mdm.field_policy มีข้อมูลครบทุก scope หลัก', async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT required_scope FROM mdm.field_policy ORDER BY required_scope`
  );
  const scopes = rows.map((r) => r.required_scope);
  expect(scopes).toEqual(
    expect.arrayContaining([
      'personnel:read:basic',
      'personnel:read:contact',
      'personnel:read:identity',
      'personnel:read:employment',
      'personnel:read:photo',
      'personnel:read:pid',
    ])
  );
});

test('seed mdm.processing_purpose มี HR_ADMIN / PAYROLL / DIRECTORY_PUBLISH', async () => {
  const { rows } = await pool.query(`SELECT purpose_code FROM mdm.processing_purpose ORDER BY purpose_code`);
  expect(rows.map((r) => r.purpose_code)).toEqual(['DIRECTORY_PUBLISH', 'HR_ADMIN', 'PAYROLL']);
});

test('DIRECTORY_PUBLISH เป็น legal_basis=CONSENT และ requires_consent=true', async () => {
  const { rows } = await pool.query(
    `SELECT legal_basis, requires_consent FROM mdm.processing_purpose WHERE purpose_code = 'DIRECTORY_PUBLISH'`
  );
  expect(rows[0].legal_basis).toBe('CONSENT');
  expect(rows[0].requires_consent).toBe(true);
});

test('seed mdm.org_unit / mdm.position มีตัวอย่างครบ', async () => {
  const orgUnits = await pool.query(`SELECT count(*)::int AS n FROM mdm.org_unit`);
  const positions = await pool.query(`SELECT count(*)::int AS n FROM mdm.position`);
  expect(orgUnits.rows[0].n).toBeGreaterThanOrEqual(4);
  expect(positions.rows[0].n).toBeGreaterThanOrEqual(3);
});
