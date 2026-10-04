const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');
const { migrate } = require('./helpers');
const { makeFakePid } = require('../../api/src/security/pid');

// migration 1700000000045 (actor_client + index) และ 1700000000046 (ข้อยกเว้น append-only ครั้งเดียว: ล้าง pid plaintext
// ออกจาก data_change_log) - down ย้อนกลับถึง 046 (รวม migration ที่เพิ่มทีหลัง) เพื่อจำลองสถานะ "ก่อน scrub" แล้วใส่แถวที่
// มี pid plaintext (ข้อมูลสมมติจาก makeFakePid) จากนั้น up อีกครั้งให้ migration ทำงานกับข้อมูลนั้น

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

// จำนวน migration ที่ต้อง down เพื่อให้ 046 ถูกย้อนด้วย (046 + ทุกตัวที่ใหม่กว่า) - ไม่ผูกกับว่า 046 เป็นตัวล่าสุดหรือไม่
async function stepsBackToScrub() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pgmigrations WHERE name >= '1700000000046'`);
  return rows[0].n;
}

async function insertPerson() {
  const { rows } = await pool.query(
    `INSERT INTO mdm.person (pid_hash, status, verification_status) VALUES ($1, 'ACTIVE', 'VERIFIED') RETURNING person_id`,
    [crypto.randomBytes(32).toString('hex')]
  );
  return rows[0].person_id;
}

async function insertLog(personId, fieldName, oldValue, newValue) {
  const { rows } = await pool.query(
    `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, reason)
     VALUES ($1, 'employment', $2, $3, $4, 'HR', 'ข้อมูลทดสอบ scrub') RETURNING log_id`,
    [personId, fieldName, oldValue === null ? null : JSON.stringify(oldValue), newValue === null ? null : JSON.stringify(newValue)]
  );
  return rows[0].log_id;
}

describe('migration 046: scrub employment.employee_no plaintext', () => {
  test('ล้าง old/new ของ employment.employee_no เท่านั้น และ trigger append-only กลับมาทำงาน', async () => {
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToScrub() });

    const personId = await insertPerson();
    const pidA = makeFakePid();
    const pidB = makeFakePid();
    const withBoth = await insertLog(personId, 'employment.employee_no', pidA, pidB);
    const newOnly = await insertLog(personId, 'employment.employee_no', null, pidA);
    const alreadyNull = await insertLog(personId, 'employment.employee_no', null, null);
    const otherField = await insertLog(personId, 'employment.personnel_type', 'CIVIL_SERVANT', 'PERMANENT_EMPLOYEE');
    const otherTable = await insertLog(personId, 'status', 'ACTIVE', 'INACTIVE');

    await migrate(DATABASE_URL, 'up');

    const { rows: remaining } = await pool.query(
      `SELECT count(*)::int AS n FROM audit.data_change_log
       WHERE field_name = 'employment.employee_no' AND (old_value IS NOT NULL OR new_value IS NOT NULL)`
    );
    expect(remaining[0].n).toBe(0);

    const fetch = async (id) =>
      (await pool.query(`SELECT old_value, new_value, reason FROM audit.data_change_log WHERE log_id = $1`, [id])).rows[0];
    for (const id of [withBoth, newOnly, alreadyNull]) {
      expect(await fetch(id)).toMatchObject({ old_value: null, new_value: null, reason: 'ข้อมูลทดสอบ scrub' });
    }
    expect(await fetch(otherField)).toMatchObject({ old_value: 'CIVIL_SERVANT', new_value: 'PERMANENT_EMPLOYEE' });
    expect(await fetch(otherTable)).toMatchObject({ old_value: 'ACTIVE', new_value: 'INACTIVE' });

    const { rows: trigger } = await pool.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'audit.data_change_log'::regclass AND tgname = 'data_change_log_append_only'`
    );
    expect(trigger).toHaveLength(1);
    expect(trigger[0].tgenabled).toBe('O'); // O = enabled (ตามค่าเริ่มต้นของ origin)
    await expect(pool.query(`UPDATE audit.data_change_log SET reason = 'x' WHERE log_id = $1`, [otherField])).rejects.toThrow(
      /append-only/
    );
    await expect(pool.query(`DELETE FROM audit.data_change_log WHERE log_id = $1`, [otherField])).rejects.toThrow(/append-only/);
  });

  test('รันบนตารางที่ไม่มีแถวตรงเงื่อนไขได้ (ไม่ fail) และเปิด trigger คืน', async () => {
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToScrub() });
    await migrate(DATABASE_URL, 'up');
    const { rows } = await pool.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'audit.data_change_log'::regclass AND tgname = 'data_change_log_append_only'`
    );
    expect(rows[0].tgenabled).toBe('O');
  });
});

describe('migration 045: actor_client และ index สำหรับ filter หน้า DPO', () => {
  test('data_change_log.actor_client เป็น varchar(255) nullable', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns
       WHERE table_schema = 'audit' AND table_name = 'data_change_log' AND column_name = 'actor_client'`
    );
    expect(rows).toEqual([{ data_type: 'character varying', character_maximum_length: 255, is_nullable: 'YES' }]);
  });

  test('มี index (actor_sub, changed_at), (table_name, changed_at) และของ reference_change_log', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'audit'
       AND indexname IN ('data_change_log_actor_changed_idx', 'data_change_log_table_changed_idx', 'reference_change_log_actor_changed_idx')`
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'data_change_log_actor_changed_idx',
      'data_change_log_table_changed_idx',
      'reference_change_log_actor_changed_idx',
    ]);
  });

  test('ADD COLUMN ไม่ทำให้ INSERT ของ mdm_app (มีสิทธิ์ INSERT ทั้งตาราง) พัง', async () => {
    const client = await pool.connect();
    try {
      const personId = await insertPerson();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE mdm_app');
      await client.query(
        `INSERT INTO audit.data_change_log (person_id, table_name, field_name, changed_by, actor_sub, actor_client)
         VALUES ($1, 'person', 'status', 'HR', 'tester', 'hr-console')`,
        [personId]
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
