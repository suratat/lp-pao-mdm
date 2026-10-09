const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');
const { migrate } = require('./helpers');

// migration 1700000000052 (ข้อยกเว้น append-only ครั้งเดียว: ตัด query string ใน audit.access_log.endpoint) - down ถอยถึง 052
// (down ของ 052 ไม่ทำอะไร) ใส่แถวแบบเก่าที่มี '?' (ข้อมูลสมมติ ไม่มีเลขบัตร) แล้ว up ให้ migration ทำงานกับข้อมูลนั้น

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function stepsBackToStrip() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pgmigrations WHERE name >= '1700000000052'`);
  return rows[0].n;
}

const PERSON = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
async function insertAccess(endpoint, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO audit.access_log (accessed_at, subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
        fields_returned, justification, request_id, response_status)
     VALUES (COALESCE($2::timestamptz, now()), NULL, 'SERVICE', 'strip-test', 'hr-console', $1, 'GET', '["basic.firstNameTh"]', $3, gen_random_uuid()::text, 200)
     RETURNING access_id, accessed_at`,
    [endpoint, extra.accessedAt || null, extra.justification || null]
  );
  return rows[0];
}
const fetchRow = async (id) =>
  (await pool.query(`SELECT access_id, accessed_at, endpoint, justification, fields_returned FROM audit.access_log WHERE access_id = $1`, [id])).rows[0];

describe('migration 052: ตัด query string ใน access_log.endpoint', () => {
  test('แถวมี ? ถูกตัด, แถวไม่มี ? ไม่เปลี่ยน, access_id/accessed_at/คอลัมน์อื่นไม่เปลี่ยน, trigger กลับมาเปิดทุก partition, UPDATE/DELETE หลัง migration ยังถูกปฏิเสธ', async () => {
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToStrip() });

    const search = await insertAccess('/api/v1/persons?q=%E0%B8%AA%E0%B8%A1&status=ACTIVE');
    const masked = await insertAccess(`/api/v1/persons/${PERSON}?pidFormat=masked`, { justification: 'เหตุผลทดสอบ' });
    const old = await insertAccess('/api/v1/persons?q=x', { accessedAt: '2026-09-15T01:00:00Z' }); // partition เดือนอื่น (หรือ default)
    const clean = await insertAccess(`/api/v1/persons/${PERSON}`);
    const before = { search: await fetchRow(search.access_id), masked: await fetchRow(masked.access_id), old: await fetchRow(old.access_id), clean: await fetchRow(clean.access_id) };

    await migrate(DATABASE_URL, 'up');

    const after = { search: await fetchRow(search.access_id), masked: await fetchRow(masked.access_id), old: await fetchRow(old.access_id), clean: await fetchRow(clean.access_id) };
    expect(after.search.endpoint).toBe('/api/v1/persons');
    expect(after.masked.endpoint).toBe(`/api/v1/persons/${PERSON}`);
    expect(after.old.endpoint).toBe('/api/v1/persons');
    expect(after.clean.endpoint).toBe(`/api/v1/persons/${PERSON}`);
    for (const k of Object.keys(before)) {
      // ทุกคอลัมน์ที่ไม่ใช่ endpoint ต้องเหมือนเดิม (accessed_at/access_id ไม่ขยับ)
      expect({ ...after[k], endpoint: null }).toEqual({ ...before[k], endpoint: null });
    }
    expect(after.clean).toEqual(before.clean);

    const { rows: left } = await pool.query(`SELECT count(*)::int AS n FROM audit.access_log WHERE endpoint LIKE '%?%'`);
    expect(left[0].n).toBe(0);

    const { rows: triggers } = await pool.query(
      `SELECT t.relid::regclass::text AS tbl, g.tgenabled FROM pg_partition_tree('audit.access_log'::regclass) t
       LEFT JOIN pg_trigger g ON g.tgrelid = t.relid AND g.tgname = 'access_log_append_only'`
    );
    expect(triggers.length).toBeGreaterThan(1); // ตารางแม่ + partition
    expect(triggers.every((r) => r.tgenabled === 'O')).toBe(true);

    await expect(pool.query(`UPDATE audit.access_log SET endpoint = 'x' WHERE access_id = $1`, [clean.access_id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit.access_log WHERE access_id = $1`, [clean.access_id])).rejects.toThrow(/append-only/);
  });

  test('รันบนตารางที่ไม่มีแถวมี ? ได้ (ไม่ fail) และ trigger ยังเปิด', async () => {
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToStrip() });
    await migrate(DATABASE_URL, 'up');
    const { rows } = await pool.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'audit.access_log'::regclass AND tgname = 'access_log_append_only'`);
    expect(rows[0].tgenabled).toBe('O');
  });

  test('role ที่ไม่ใช่เจ้าของตาราง -> migration ล้ม (RAISE EXCEPTION) และแถวไม่ถูกแก้', async () => {
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToStrip() });
    const row = await insertAccess('/api/v1/persons?q=owner-check');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE mdm_app'); // ไม่ใช่เจ้าของ
      const up = require('../migrations/1700000000052_access_log_strip_legacy_query').up;
      const sqls = [];
      up({ sql: (s) => sqls.push(s) });
      await expect(client.query(sqls[0])).rejects.toThrow(/ไม่ได้เป็นเจ้าของ/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await fetchRow(row.access_id)).endpoint).toBe('/api/v1/persons?q=owner-check');
    await migrate(DATABASE_URL, 'up');
    expect((await fetchRow(row.access_id)).endpoint).toBe('/api/v1/persons');
  });
});
