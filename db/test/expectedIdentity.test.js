const crypto = require('node:crypto');
const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// migration 1700000000051: mdm.person.expected_birth_date + field_policy + trigger mdm.guard_expected_identity (ชั้นป้องกันที่สองต่อการตรวจใน API)

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function inTx(fn, role = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const insertPerson = async (client, { status = 'PENDING_CLAIM', verifiedAt = null, claimedAt = null } = {}) =>
  (
    await client.query(
      `INSERT INTO mdm.person (pid_hash, status, verification_status, thaid_verified_at, claimed_at, expected_first_name_th, expected_last_name_th, expected_birth_date)
       VALUES ($1, $2, 'UNVERIFIED', $3, $4, 'เดิม', 'เดิม', '1990-01-01') RETURNING person_id`,
      [crypto.randomBytes(32).toString('hex'), status, verifiedAt, claimedAt]
    )
  ).rows[0].person_id;

const blocked = async (client, sql, params) => {
  await client.query('SAVEPOINT s');
  try {
    await client.query(sql, params);
  } catch (err) {
    await client.query('ROLLBACK TO s');
    return err;
  }
  await client.query('RELEASE s');
  return null;
};

describe('schema และ field_policy', () => {
  test('expected_birth_date เป็น date nullable; field_policy: วันเกิด CONFIDENTIAL, ชื่อ INTERNAL, scope personnel:manage:person, แก้ได้โดย HR', async () => {
    const { rows: col } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'mdm' AND table_name = 'person' AND column_name = 'expected_birth_date'`
    );
    expect(col).toEqual([{ data_type: 'date', is_nullable: 'YES' }]);
    const { rows } = await pool.query(
      `SELECT field_key, classification, required_scope, editable_by, log_values_in_audit FROM mdm.field_policy WHERE field_key LIKE 'person.expected_%' ORDER BY field_key`
    );
    expect(rows).toEqual([
      { field_key: 'person.expected_birth_date', classification: 'CONFIDENTIAL', required_scope: 'personnel:manage:person', editable_by: 'HR', log_values_in_audit: true },
      { field_key: 'person.expected_first_name_th', classification: 'INTERNAL', required_scope: 'personnel:manage:person', editable_by: 'HR', log_values_in_audit: true },
      { field_key: 'person.expected_last_name_th', classification: 'INTERNAL', required_scope: 'personnel:manage:person', editable_by: 'HR', log_values_in_audit: true },
    ]);
  });
});

describe('trigger person_expected_identity_guard', () => {
  const SETS = [
    ['expected_first_name_th', `UPDATE mdm.person SET expected_first_name_th = 'ใหม่' WHERE person_id = $1`],
    ['expected_last_name_th', `UPDATE mdm.person SET expected_last_name_th = 'ใหม่' WHERE person_id = $1`],
    ['expected_birth_date', `UPDATE mdm.person SET expected_birth_date = '2000-02-02' WHERE person_id = $1`],
    ['expected_birth_date -> NULL', `UPDATE mdm.person SET expected_birth_date = NULL WHERE person_id = $1`],
  ];

  test.each(SETS)('PENDING_CLAIM ที่ไม่เคยยืนยัน: แก้ %s ได้ (ทั้ง superuser และ mdm_app)', async (_name, sql) => {
    for (const role of [null, 'mdm_app']) {
      // eslint-disable-next-line no-await-in-loop
      await inTx(async (c) => {
        const id = await insertPerson(c);
        expect(await blocked(c, sql, [id])).toBeNull();
      }, role);
    }
  });

  test.each([
    ['thaid_verified_at ไม่เป็น NULL', { verifiedAt: new Date() }],
    ['claimed_at ไม่เป็น NULL', { claimedAt: new Date() }],
    ['status ACTIVE', { status: 'ACTIVE' }],
    ['status INACTIVE', { status: 'INACTIVE' }],
  ])('%s: แก้ expected_* ไม่ได้ (SQLSTATE MD001) แม้เป็น superuser/เจ้าของตาราง และเมื่อเป็น mdm_app', async (_label, state) => {
    for (const role of [null, 'mdm_app']) {
      // eslint-disable-next-line no-await-in-loop
      await inTx(async (c) => {
        const id = await insertPerson(c, state);
        for (const [, sql] of SETS) {
          // eslint-disable-next-line no-await-in-loop
          const err = await blocked(c, sql, [id]);
          expect(err?.code).toBe('MD001');
        }
        const { rows } = await c.query(`SELECT expected_first_name_th, expected_birth_date::text AS birth FROM mdm.person WHERE person_id = $1`, [id]);
        expect(rows[0]).toEqual({ expected_first_name_th: 'เดิม', birth: '1990-01-01' });
      }, role);
    }
  });

  test('ไม่ขวางสิ่งที่ต้องทำได้: ตั้งค่าเดิมซ้ำ, แก้คอลัมน์อื่นของคนที่ยืนยันแล้ว, การ claim (เปลี่ยนสถานะ+เวลายืนยันโดยไม่แตะ expected_*), INSERT พร้อม expected_*', async () => {
    await inTx(async (c) => {
      const verified = await insertPerson(c, { status: 'ACTIVE', verifiedAt: new Date(), claimedAt: new Date() });
      expect(await blocked(c, `UPDATE mdm.person SET expected_first_name_th = 'เดิม', expected_birth_date = '1990-01-01' WHERE person_id = $1`, [verified])).toBeNull();
      expect(await blocked(c, `UPDATE mdm.person SET version = version + 1, verification_status = 'STALE' WHERE person_id = $1`, [verified])).toBeNull();

      const pending = await insertPerson(c);
      expect(await blocked(c, `UPDATE mdm.person SET status = 'ACTIVE', claimed_at = now(), thaid_verified_at = now(), verification_status = 'VERIFIED', version = version + 1 WHERE person_id = $1`, [pending])).toBeNull();
      // หลัง claim แล้วแก้ไม่ได้
      expect((await blocked(c, `UPDATE mdm.person SET expected_first_name_th = 'ใหม่' WHERE person_id = $1`, [pending]))?.code).toBe('MD001');
    });
  });

  test('คำสั่งเดียวที่แก้ expected_* พร้อม claim บนแถวที่ยัง PENDING_CLAIM (ก่อนคำสั่ง) ผ่านได้: trigger ดูค่า OLD เท่านั้น', async () => {
    await inTx(async (c) => {
      const id = await insertPerson(c);
      expect(await blocked(c, `UPDATE mdm.person SET expected_first_name_th = 'ใหม่', status = 'ACTIVE', claimed_at = now() WHERE person_id = $1`, [id])).toBeNull();
    });
  });
});
