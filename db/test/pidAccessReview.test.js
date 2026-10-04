const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// migration 1700000000047: audit.pid_access_review - append-only (trigger + สิทธิ์), CHECK, ไม่มี FK, สิทธิ์รายบทบาท
// ใช้ SET LOCAL ROLE จาก connection ของ migrator เพื่อทดสอบในสิทธิ์ของ role จริง (แนวเดียวกับ stgHrWorkerGrants.test.js)

let pool;

beforeAll(() => {
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
});

async function asRole(role, fn) {
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

const insertReview = (client, { status = 'REVIEWED', note = null } = {}) =>
  client.query(
    `INSERT INTO audit.pid_access_review (access_id, accessed_at, status, note, reviewer_sub)
     VALUES (1, now(), $1, $2, 'tester') RETURNING review_id`,
    [status, note]
  );

describe('audit.pid_access_review', () => {
  test('CHECK: status นอกรายการ และ NEEDS_EXPLANATION ที่ไม่มี note ถูกปฏิเสธ', async () => {
    await asRole(null, async (c) => {
      await c.query('SAVEPOINT a');
      await expect(insertReview(c, { status: 'PENDING' })).rejects.toThrow(/check/i); // PENDING ไม่เก็บเป็นแถว
      await c.query('ROLLBACK TO a');
      await expect(insertReview(c, { status: 'NEEDS_EXPLANATION', note: '  ' })).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await expect(insertReview(c, { status: 'NEEDS_EXPLANATION' })).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await expect(insertReview(c, { status: 'NEEDS_EXPLANATION', note: 'ชี้แจง' })).resolves.toBeDefined();
      await expect(insertReview(c, { status: 'REVIEWED' })).resolves.toBeDefined();
    });
  });

  test('append-only: UPDATE/DELETE ถูก trigger ปฏิเสธแม้เป็นเจ้าของตาราง', async () => {
    await asRole(null, async (c) => {
      const { rows } = await insertReview(c);
      await c.query('SAVEPOINT a');
      await expect(c.query(`UPDATE audit.pid_access_review SET note = 'x' WHERE review_id = $1`, [rows[0].review_id])).rejects.toThrow(
        /append-only/
      );
      await c.query('ROLLBACK TO a');
      await expect(c.query(`DELETE FROM audit.pid_access_review WHERE review_id = $1`, [rows[0].review_id])).rejects.toThrow(
        /append-only/
      );
    });
  });

  test('สิทธิ์: mdm_app SELECT/INSERT ได้ UPDATE/DELETE ไม่ได้; mdm_audit SELECT ได้ INSERT ไม่ได้; mdm_worker/mdm_readonly เข้าไม่ได้', async () => {
    await asRole('mdm_app', async (c) => {
      await expect(insertReview(c)).resolves.toBeDefined();
      await expect(c.query('SELECT count(*) FROM audit.pid_access_review')).resolves.toBeDefined();
      await c.query('SAVEPOINT a');
      await expect(c.query(`UPDATE audit.pid_access_review SET note = 'x'`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO a');
      await expect(c.query(`DELETE FROM audit.pid_access_review`)).rejects.toThrow(/permission denied/);
    });
    await asRole('mdm_audit', async (c) => {
      await expect(c.query('SELECT count(*) FROM audit.pid_access_review')).resolves.toBeDefined();
      await c.query('SAVEPOINT a');
      await expect(insertReview(c)).rejects.toThrow(/permission denied/);
    });
    for (const role of ['mdm_worker', 'mdm_readonly']) {
      // eslint-disable-next-line no-await-in-loop
      await asRole(role, async (c) => {
        await expect(c.query('SELECT count(*) FROM audit.pid_access_review')).rejects.toThrow(/permission denied/);
      });
    }
  });

  test('ไม่มี foreign key (อ้าง access_log ด้วย (access_id, accessed_at) โดยไม่ผูก partition) และมี index สำหรับ lateral join', async () => {
    const { rows: fks } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'audit.pid_access_review'::regclass AND contype = 'f'`
    );
    expect(fks[0].n).toBe(0);
    const { rows: idx } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'audit' AND indexname = 'pid_access_review_access_idx'`
    );
    expect(idx[0].indexdef).toMatch(/\(access_id, accessed_at, review_id DESC\)/);
  });
});
