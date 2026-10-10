const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');
const { migrate } = require('./helpers');

// migration 1700000000053 (ข้อยกเว้นกฎข้อ 2 และ 4 ครั้งเดียว: ล้างค่าวันเกิดเดิมใน mdm.person.expected_birth_date,
// mdm.person_identity.birth_date และ audit.data_change_log) - down ถอยถึง 053 (down ของ 053 ไม่ทำอะไร) ใส่ข้อมูลสมมติแบบเก่าที่มีวันเกิด
// แล้ว up ให้ migration ทำงานกับข้อมูลนั้น

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function stepsBackToScrub() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pgmigrations WHERE name >= '1700000000053'`);
  return rows[0].n;
}

const BIRTH_A = '1990-05-17';
const BIRTH_B = '1985-01-02';
const BIRTH_C = '1980-03-04';
const BIRTH_D = '1975-06-07';
const ALL_BIRTHS = [BIRTH_A, BIRTH_B, BIRTH_C, BIRTH_D, '1979-12-31'];

async function insertPerson({ verified = false, expectedBirth = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO mdm.person (pid_hash, status, verification_status, thaid_verified_at, claimed_at, expected_birth_date)
     VALUES ($1, $2, $3, $4, $4, $5) RETURNING person_id`,
    [crypto.randomBytes(32).toString('hex'), verified ? 'ACTIVE' : 'PENDING_CLAIM', verified ? 'VERIFIED' : 'UNVERIFIED', verified ? new Date() : null, expectedBirth]
  );
  return rows[0].person_id;
}
const insertIdentity = (personId, birth) =>
  pool.query(`INSERT INTO mdm.person_identity (person_id, first_name_th, last_name_th, birth_date) VALUES ($1, 'ทดสอบ', 'ล้างวันเกิด', $2)`, [personId, birth]);
async function insertLog(personId, fieldName, oldValue, newValue, tableName = 'person') {
  const { rows } = await pool.query(
    `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, actor_sub, reason)
     VALUES ($1, $2, $3, $4, $5, 'HR', 'scrub-test', 'ข้อมูลทดสอบ scrub วันเกิด') RETURNING log_id`,
    [personId, tableName, fieldName, oldValue === null ? null : JSON.stringify(oldValue), newValue === null ? null : JSON.stringify(newValue)]
  );
  return rows[0].log_id;
}
const logRow = async (id) =>
  (await pool.query(`SELECT person_id, table_name, field_name, old_value, new_value, changed_by, actor_sub, reason, changed_at FROM audit.data_change_log WHERE log_id = $1`, [id])).rows[0];
const logTotal = async () => Number((await pool.query(`SELECT count(*) FROM audit.data_change_log`)).rows[0].count);
const outboxTotal = async () => Number((await pool.query(`SELECT count(*) FROM integration.outbox_event`)).rows[0].count);
const personState = async (id) =>
  (await pool.query(`SELECT version, updated_at, status, expected_first_name_th, expected_birth_date::text AS birth FROM mdm.person WHERE person_id = $1`, [id])).rows[0];
const triggerState = async (rel, name) =>
  (await pool.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [rel, name])).rows.map((r) => r.tgenabled);

async function seed() {
  const pending = await insertPerson({ expectedBirth: BIRTH_A });
  const verified = await insertPerson({ verified: true, expectedBirth: BIRTH_B }); // guard จะกัน UPDATE expected_* ของคนนี้ถ้าไม่ปิดชั่วคราว
  const clean = await insertPerson();
  await insertIdentity(verified, BIRTH_C);
  await insertIdentity(clean, BIRTH_D);
  await pool.query(`UPDATE mdm.person SET expected_first_name_th = 'ชื่อที่ต้องไม่ถูกแตะ' WHERE person_id = $1`, [pending]);
  const logs = {
    expectedNewOnly: await insertLog(pending, 'person.expected_birth_date', null, BIRTH_A),
    expectedBoth: await insertLog(verified, 'person.expected_birth_date', BIRTH_B, '1986-02-03'),
    identityBoth: await insertLog(verified, 'identity.birth_date', '1979-12-31', BIRTH_C, 'person_identity'),
    identityNewOnly: await insertLog(clean, 'identity.birth_date', null, BIRTH_D, 'person_identity'),
    alreadyNull: await insertLog(clean, 'identity.birth_date', null, null, 'person_identity'),
    otherExpected: await insertLog(pending, 'person.expected_first_name_th', 'เดิม', 'ชื่อที่ต้องไม่ถูกแตะ'),
    otherIdentity: await insertLog(verified, 'identity.last_name_th', 'เก่า', 'ล้างวันเกิด', 'person_identity'),
  };
  return { pending, verified, clean, logs };
}

describe('migration 053: ล้างค่าวันเกิดเดิม (ข้อยกเว้นครั้งเดียว)', () => {
  test('ล้างค่าทั้งสามตาราง คงแถว/คอลัมน์อื่น ไม่ bump version/updated_at ไม่เกิด outbox/log เพิ่ม trigger กลับมาเปิด และรันซ้ำไม่เกิดผล', async () => {
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToScrub() });
    const { pending, verified, clean, logs } = await seed();

    const before = { pending: await personState(pending), verified: await personState(verified), clean: await personState(clean) };
    const logsBefore = {};
    for (const [k, id] of Object.entries(logs)) logsBefore[k] = await logRow(id);
    const logTotalBefore = await logTotal();
    const outboxBefore = await outboxTotal();
    expect(before.pending.birth).toBe(BIRTH_A);
    expect(before.verified.birth).toBe(BIRTH_B);

    // ยืนยันว่า guard กัน UPDATE นี้จริงถ้าไม่ปิดชั่วคราว (เหตุผลที่ migration ต้องปิดมัน)
    await expect(pool.query(`UPDATE mdm.person SET expected_birth_date = NULL WHERE person_id = $1`, [verified])).rejects.toThrow();

    await migrate(DATABASE_URL, 'up');

    // 1) ค่าถูกล้างหมด
    expect((await pool.query(`SELECT count(*)::int AS n FROM mdm.person WHERE expected_birth_date IS NOT NULL`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM mdm.person_identity WHERE birth_date IS NOT NULL`)).rows[0].n).toBe(0);
    expect(
      (await pool.query(
        `SELECT count(*)::int AS n FROM audit.data_change_log
         WHERE field_name IN ('person.expected_birth_date', 'identity.birth_date') AND (old_value IS NOT NULL OR new_value IS NOT NULL)`
      )).rows[0].n
    ).toBe(0);

    // 2) แถวไม่หาย; แถว change_log ที่ล้างคงคอลัมน์อื่นครบ; ฟิลด์อื่นไม่ถูกแตะ
    expect(await logTotal()).toBe(logTotalBefore);
    for (const k of ['expectedNewOnly', 'expectedBoth', 'identityBoth', 'identityNewOnly', 'alreadyNull']) {
      expect(await logRow(logs[k])).toEqual({ ...logsBefore[k], old_value: null, new_value: null });
    }
    for (const k of ['otherExpected', 'otherIdentity']) expect(await logRow(logs[k])).toEqual(logsBefore[k]);
    expect(JSON.stringify((await pool.query(`SELECT old_value, new_value FROM audit.data_change_log WHERE log_id = ANY($1)`, [Object.values(logs)])).rows)).not.toMatch(
      new RegExp(ALL_BIRTHS.join('|'))
    );

    // 3) person: version/updated_at/ชื่อ/สถานะไม่เปลี่ยน มีแต่ expected_birth_date เป็น NULL; ไม่มี outbox event ใหม่
    for (const [key, id] of [['pending', pending], ['verified', verified], ['clean', clean]]) {
      expect(await personState(id)).toEqual({ ...before[key], birth: null });
    }
    expect(await outboxTotal()).toBe(outboxBefore);
    // person_identity: แถวยังอยู่ ฟิลด์อื่นไม่เปลี่ยน
    expect((await pool.query(`SELECT first_name_th, last_name_th, birth_date FROM mdm.person_identity WHERE person_id = ANY($1) ORDER BY person_id`, [[verified, clean]])).rows).toEqual(
      [{ first_name_th: 'ทดสอบ', last_name_th: 'ล้างวันเกิด', birth_date: null }, { first_name_th: 'ทดสอบ', last_name_th: 'ล้างวันเกิด', birth_date: null }]
    );

    // 4) trigger ที่ปิดชั่วคราวกลับมาเปิด และยังทำงาน
    expect(await triggerState('mdm.person', 'person_expected_identity_guard')).toEqual(['O']);
    expect(await triggerState('audit.data_change_log', 'data_change_log_append_only')).toEqual(['O']);
    await expect(pool.query(`UPDATE mdm.person SET expected_birth_date = '2000-01-01' WHERE person_id = $1`, [verified])).rejects.toThrow();
    await expect(pool.query(`UPDATE audit.data_change_log SET reason = 'x' WHERE log_id = $1`, [logs.otherExpected])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit.data_change_log WHERE log_id = $1`, [logs.otherExpected])).rejects.toThrow(/append-only/);

    // 5) รันซ้ำไม่เกิดผล
    const snapshot = async () => ({
      total: await logTotal(),
      outbox: await outboxTotal(),
      people: (await pool.query(`SELECT person_id, version, updated_at, expected_birth_date::text AS b FROM mdm.person WHERE person_id = ANY($1) ORDER BY person_id`, [[pending, verified, clean]])).rows,
      logs: (await pool.query(`SELECT log_id, old_value, new_value, reason FROM audit.data_change_log WHERE log_id = ANY($1) ORDER BY log_id`, [Object.values(logs)])).rows,
    });
    const afterFirst = await snapshot();
    await migrate(DATABASE_URL, 'down', { count: await stepsBackToScrub() });
    await migrate(DATABASE_URL, 'up');
    expect(await snapshot()).toEqual(afterFirst);
    expect(await triggerState('mdm.person', 'person_expected_identity_guard')).toEqual(['O']);
    expect(await triggerState('audit.data_change_log', 'data_change_log_append_only')).toEqual(['O']);
  });

  test('คอลัมน์/แถว field_policy ยังอยู่ (ไม่ drop) เพื่อให้ประวัติเก่าที่เหลือยังถูกปกปิดค่า', async () => {
    const cols = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_schema, table_name, column_name) IN (('mdm','person','expected_birth_date'), ('mdm','person_identity','birth_date'))
       ORDER BY table_name`
    );
    expect(cols.rows).toEqual([{ table_name: 'person', column_name: 'expected_birth_date' }, { table_name: 'person_identity', column_name: 'birth_date' }]);
    const policy = await pool.query(`SELECT field_key FROM mdm.field_policy WHERE field_key IN ('person.expected_birth_date', 'identity.birth_date') ORDER BY field_key`);
    expect(policy.rows.map((r) => r.field_key)).toEqual(['identity.birth_date', 'person.expected_birth_date']);
  });
});
