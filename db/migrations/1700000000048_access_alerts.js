/* eslint-disable camelcase */

exports.shorthands = undefined;

// PR-C (DPO): แจ้งเตือนพฤติกรรมการเข้าถึงข้อมูลผิดปกติ (worker job access-anomaly-scan)
//
// สองตาราง append-only (กฎข้อ 4: schema audit ห้าม UPDATE/DELETE) สถานะ OPEN/ACK/CLOSED ไม่เก็บเป็นคอลัมน์ที่แก้ได้ -
// คำนวณจาก action ล่าสุดของ alert นั้นตอนอ่าน: ไม่มี action = OPEN, ACK = ACK, CLOSE = CLOSED
//  - audit.access_alert        ข้อเท็จจริงที่ตรวจพบ (เขียนโดย worker เท่านั้น) กันซ้ำด้วย dedupe_key UNIQUE (INSERT ... ON CONFLICT DO NOTHING)
//  - audit.access_alert_action การรับทราบ/ปิดเรื่องโดย DPO (เขียนผ่าน API เท่านั้น) CLOSE ต้องมี note
// details ของ alert เก็บเฉพาะตัวเลข/พารามิเตอร์ของกฎ ไม่มี pid, ไม่มีชื่อบุคคล และไม่มี personId ของผู้ถูกเข้าถึง (DPO ไล่ดูได้จาก
// access log ด้วย actor + ช่วงเวลา window_start..window_end)
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'audit', name: 'access_alert' },
    {
      alert_id: { type: 'bigserial', primaryKey: true },
      rule_code: { type: 'varchar(40)', notNull: true, check: "rule_code IN ('BULK_VIEW', 'OFF_HOURS', 'PID_REVEAL_FREQUENT')" },
      // ตัวกันซ้ำ: กฎ + client + actor + ช่วง (bucket ตามหน้าต่างเวลา หรือวันที่ตามเวลาไทยสำหรับ OFF_HOURS)
      dedupe_key: { type: 'varchar(300)', notNull: true, unique: true },
      severity: { type: 'varchar(10)', notNull: true, check: "severity IN ('LOW', 'MEDIUM', 'HIGH')" },
      actor_sub: { type: 'varchar(255)' },
      actor_client: { type: 'varchar(255)' },
      window_start: { type: 'timestamptz', notNull: true },
      window_end: { type: 'timestamptz', notNull: true },
      metric_count: { type: 'integer', notNull: true },
      threshold: { type: 'integer', notNull: true },
      details: { type: 'jsonb', notNull: true, default: pgm.func(`'{}'::jsonb`) },
      detected_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'audit', name: 'access_alert' }, [{ name: 'detected_at', sort: 'DESC' }], { name: 'access_alert_detected_idx' });

  pgm.createTable(
    { schema: 'audit', name: 'access_alert_action' },
    {
      action_id: { type: 'bigserial', primaryKey: true },
      alert_id: { type: 'bigint', notNull: true, references: { schema: 'audit', name: 'access_alert' }, onDelete: 'RESTRICT' },
      action: { type: 'varchar(10)', notNull: true, check: "action IN ('ACK', 'CLOSE')" },
      note: { type: 'text' },
      actor_sub: { type: 'varchar(255)', notNull: true },
      actor_client: { type: 'varchar(255)' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        // ปิดเรื่องต้องบอกเหตุผล (ไม่ใช่แค่กดปิด)
        check: "action <> 'CLOSE' OR length(btrim(coalesce(note, ''))) > 0",
      },
    }
  );
  pgm.createIndex({ schema: 'audit', name: 'access_alert_action' }, ['alert_id', { name: 'action_id', sort: 'DESC' }], {
    name: 'access_alert_action_alert_idx',
  });

  for (const table of ['access_alert', 'access_alert_action']) {
    pgm.sql(`
      CREATE TRIGGER ${table}_append_only
      BEFORE UPDATE OR DELETE ON audit.${table}
      FOR EACH ROW EXECUTE FUNCTION audit.reject_update_delete();
    `);
  }

  // กฎของ worker กรองด้วย keycloak_client_id (รายชื่อ client ที่เฝ้า) + ช่วง accessed_at เสมอ - ตารางแม่ partitioned: index ที่สร้างบนตารางแม่
  // ถูกสร้างบนทุก partition (รวมที่สร้างทีหลัง) CREATE INDEX CONCURRENTLY ใช้กับตารางแม่ไม่ได้ ตารางยังเล็กอยู่จึงยอมล็อกสั้นๆ ตอน migrate
  pgm.sql(`CREATE INDEX access_log_client_accessed_idx ON audit.access_log (keycloak_client_id, accessed_at);`);

  // ตารางใหม่ไม่ถูกครอบด้วย GRANT ... ON ALL TABLES ของ 0015_grants.js (มีผลเฉพาะตารางที่มีอยู่ตอนนั้น)
  // worker: เขียน alert (INSERT ... ON CONFLICT DO NOTHING RETURNING ต้องมี SELECT ด้วย) ไม่แตะ action
  pgm.sql(`GRANT SELECT, INSERT ON audit.access_alert TO mdm_worker;`);
  pgm.sql(`GRANT USAGE ON SEQUENCE audit.access_alert_alert_id_seq TO mdm_worker;`);
  // API: อ่าน alert + เขียน action (รับทราบ/ปิดเรื่อง)
  pgm.sql(`GRANT SELECT ON audit.access_alert TO mdm_app;`);
  pgm.sql(`GRANT SELECT, INSERT ON audit.access_alert_action TO mdm_app;`);
  pgm.sql(`GRANT USAGE ON SEQUENCE audit.access_alert_action_action_id_seq TO mdm_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE ON audit.access_alert, audit.access_alert_action FROM mdm_app, mdm_worker;`);
  pgm.sql(`GRANT SELECT ON audit.access_alert, audit.access_alert_action TO mdm_audit;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS audit.access_log_client_accessed_idx;`);
  pgm.sql(`REVOKE ALL ON audit.access_alert, audit.access_alert_action FROM mdm_app, mdm_worker, mdm_audit;`);
  pgm.dropTable({ schema: 'audit', name: 'access_alert_action' });
  pgm.dropTable({ schema: 'audit', name: 'access_alert' });
};
