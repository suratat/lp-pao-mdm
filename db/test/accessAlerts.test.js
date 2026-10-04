const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// migration 1700000000048: audit.access_alert / access_alert_action - สิทธิ์รายบทบาท, append-only, CHECK และ index ของ access_log
// ใช้ SET LOCAL ROLE จาก connection ของ migrator เพื่อทดสอบในสิทธิ์ของ role จริง

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

const insertAlert = (c, key = `db-test-${Math.random()}`) =>
  c.query(
    `INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, window_start, window_end, metric_count, threshold)
     VALUES ('BULK_VIEW', $1, 'HIGH', now(), now(), 31, 30) RETURNING alert_id`,
    [key]
  );

const insertAction = (c, alertId, action = 'ACK', note = null) =>
  c.query(`INSERT INTO audit.access_alert_action (alert_id, action, note, actor_sub) VALUES ($1, $2, $3, 'tester') RETURNING action_id`, [alertId, action, note]);

describe('audit.access_alert', () => {
  test('CHECK: rule_code / severity นอกรายการไม่ได้; dedupe_key ซ้ำไม่ได้', async () => {
    await asRole(null, async (c) => {
      await c.query('SAVEPOINT a');
      await expect(
        c.query(`INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, window_start, window_end, metric_count, threshold) VALUES ('NOPE', 'k1', 'HIGH', now(), now(), 1, 1)`)
      ).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await expect(
        c.query(`INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, window_start, window_end, metric_count, threshold) VALUES ('BULK_VIEW', 'k2', 'URGENT', now(), now(), 1, 1)`)
      ).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await insertAlert(c, 'dup');
      await expect(insertAlert(c, 'dup')).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  test('ON CONFLICT (dedupe_key) DO NOTHING ภายใต้สิทธิ์ mdm_worker: แถวแรกคืนค่า แถวซ้ำไม่คืน (ใช้ส่ง Telegram เฉพาะ alert ใหม่)', async () => {
    await asRole('mdm_worker', async (c) => {
      const sql = `INSERT INTO audit.access_alert (rule_code, dedupe_key, severity, window_start, window_end, metric_count, threshold)
                   VALUES ('OFF_HOURS', 'worker-dedupe', 'MEDIUM', now(), now(), 1, 1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING alert_id`;
      expect((await c.query(sql)).rows).toHaveLength(1);
      expect((await c.query(sql)).rows).toHaveLength(0);
    });
  });
});

describe('audit.access_alert_action', () => {
  test('CHECK: action นอกรายการไม่ได้; CLOSE ต้องมี note (ว่าง/ช่องว่างล้วนไม่ได้) ส่วน ACK ไม่ต้องมี', async () => {
    await asRole(null, async (c) => {
      const { rows } = await insertAlert(c);
      const id = rows[0].alert_id;
      await c.query('SAVEPOINT a');
      await expect(insertAction(c, id, 'REOPEN', 'x')).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await expect(insertAction(c, id, 'CLOSE', null)).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await expect(insertAction(c, id, 'CLOSE', '   ')).rejects.toThrow(/check/i);
      await c.query('ROLLBACK TO a');
      await expect(insertAction(c, id, 'ACK', null)).resolves.toBeDefined();
      await expect(insertAction(c, id, 'CLOSE', 'ตรวจแล้ว')).resolves.toBeDefined();
    });
  });

  test('FK ไป access_alert: alert_id ที่ไม่มีอยู่ไม่ได้', async () => {
    await asRole(null, async (c) => {
      await expect(insertAction(c, 2_000_000_000, 'ACK')).rejects.toThrow(/foreign key/i);
    });
  });
});

describe('append-only และสิทธิ์รายบทบาท', () => {
  test('trigger ปฏิเสธ UPDATE/DELETE แม้เป็นเจ้าของตาราง (ทั้งสองตาราง)', async () => {
    await asRole(null, async (c) => {
      const { rows } = await insertAlert(c);
      const id = rows[0].alert_id;
      await insertAction(c, id);
      for (const sql of [
        `UPDATE audit.access_alert SET severity = 'LOW' WHERE alert_id = ${id}`,
        `DELETE FROM audit.access_alert WHERE alert_id = ${id}`,
        `UPDATE audit.access_alert_action SET note = 'x' WHERE alert_id = ${id}`,
        `DELETE FROM audit.access_alert_action WHERE alert_id = ${id}`,
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await c.query('SAVEPOINT a');
        // eslint-disable-next-line no-await-in-loop
        await expect(c.query(sql)).rejects.toThrow(/append-only/);
        // eslint-disable-next-line no-await-in-loop
        await c.query('ROLLBACK TO a');
      }
    });
  });

  test('mdm_worker: INSERT/SELECT access_alert ได้ ไม่มี UPDATE/DELETE และแตะ access_alert_action ไม่ได้', async () => {
    await asRole('mdm_worker', async (c) => {
      await expect(insertAlert(c)).resolves.toBeDefined();
      await c.query('SAVEPOINT a');
      await expect(c.query(`UPDATE audit.access_alert SET severity = 'LOW'`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO a');
      await expect(c.query(`DELETE FROM audit.access_alert`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO a');
      await expect(c.query(`SELECT 1 FROM audit.access_alert_action`)).rejects.toThrow(/permission denied/);
    });
  });

  test('mdm_app: SELECT access_alert + INSERT/SELECT access_alert_action ได้ แต่เขียน access_alert เอง/UPDATE/DELETE ไม่ได้', async () => {
    await asRole('mdm_app', async (c) => {
      await expect(c.query('SELECT count(*) FROM audit.access_alert')).resolves.toBeDefined();
      await c.query('SAVEPOINT a');
      await expect(insertAlert(c)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO a');
      await expect(c.query(`UPDATE audit.access_alert_action SET note = 'x'`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK TO a');
      await expect(c.query(`DELETE FROM audit.access_alert_action`)).rejects.toThrow(/permission denied/);
    });
  });

  test('mdm_audit อ่านได้ทั้งสองตารางแต่เขียนไม่ได้; mdm_readonly อ่านไม่ได้', async () => {
    await asRole('mdm_audit', async (c) => {
      await expect(c.query('SELECT count(*) FROM audit.access_alert')).resolves.toBeDefined();
      await expect(c.query('SELECT count(*) FROM audit.access_alert_action')).resolves.toBeDefined();
      await c.query('SAVEPOINT a');
      await expect(insertAlert(c)).rejects.toThrow(/permission denied/);
    });
    await asRole('mdm_readonly', async (c) => {
      await expect(c.query('SELECT count(*) FROM audit.access_alert')).rejects.toThrow(/permission denied/);
    });
  });
});

describe('index ของ access_log สำหรับกฎของ worker', () => {
  test('มี index (keycloak_client_id, accessed_at) บนตารางแม่ และ partition ทุกตัวมี index ลูก', async () => {
    const { rows } = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'audit' AND indexname = 'access_log_client_accessed_idx'`);
    expect(rows[0].indexdef).toMatch(/\(keycloak_client_id, accessed_at\)/);
    const { rows: missing } = await pool.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'audit.access_log'::regclass
         AND NOT EXISTS (
           SELECT 1 FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
           JOIN pg_inherits ii ON ii.inhrelid = ic.oid
           WHERE x.indrelid = c.oid AND ii.inhparent = 'audit.access_log_client_accessed_idx'::regclass
         )`
    );
    expect(missing).toEqual([]);
  });
});
