/* eslint-disable camelcase */

exports.shorthands = undefined;

// สิทธิ์ระดับตาราง/คอลัมน์ตาม §1.1, §1.6:
// - mdm_app / mdm_worker: SELECT/INSERT/UPDATE บน mdm.* (ไม่มี DELETE, soft delete เท่านั้น)
// - audit.*: SELECT/INSERT เท่านั้น (append-only) ทั้งสอง role, REVOKE UPDATE/DELETE ซ้ำเป็นชั้นป้องกันที่ 2
//   (ชั้นที่ 1 คือ trigger ใน 0014_audit_append_only.js)
// - integration.*: worker มีสิทธิ์ UPDATE เฉพาะ outbox_event.published_at และเต็มบน webhook_delivery
// - mdm_readonly: SELECT บน mdm.* แต่ไม่เห็น person.pid_enc (column privilege)
// - mdm_audit: SELECT บน audit.* เท่านั้น
exports.up = (pgm) => {
  // --- mdm_app ---
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mdm TO mdm_app;`);
  pgm.sql(`GRANT SELECT, INSERT ON audit.thaid_sync_event, audit.data_change_log, audit.access_log TO mdm_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE ON audit.thaid_sync_event, audit.data_change_log, audit.access_log FROM mdm_app;`);
  pgm.sql(`GRANT SELECT, INSERT ON integration.outbox_event TO mdm_app;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON integration.webhook_subscription TO mdm_app;`);
  pgm.sql(`GRANT SELECT, UPDATE ON integration.webhook_delivery TO mdm_app;`);
  pgm.sql(`GRANT USAGE ON audit.data_change_log_log_id_seq, audit.access_log_access_id_seq, integration.outbox_event_sequence_seq TO mdm_app;`);

  // --- mdm_worker ---
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mdm TO mdm_worker;`);
  pgm.sql(`GRANT SELECT, INSERT ON audit.data_change_log TO mdm_worker;`); // HR import เขียน changed_by=HR_IMPORT
  pgm.sql(`GRANT SELECT ON audit.thaid_sync_event, audit.access_log TO mdm_worker;`);
  pgm.sql(`REVOKE UPDATE, DELETE ON audit.data_change_log FROM mdm_worker;`);
  pgm.sql(`GRANT SELECT ON integration.outbox_event, integration.webhook_subscription TO mdm_worker;`);
  pgm.sql(`GRANT UPDATE (published_at) ON integration.outbox_event TO mdm_worker;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON integration.webhook_delivery TO mdm_worker;`);
  pgm.sql(`GRANT USAGE ON audit.data_change_log_log_id_seq TO mdm_worker;`);

  // --- mdm_readonly (รายงาน, ไม่เห็น pid_enc) ---
  // หมายเหตุ: สิทธิ์ระดับตารางและระดับคอลัมน์ใน PostgreSQL เป็นแบบ "รวมกัน" (additive) -
  // การ REVOKE เฉพาะคอลัมน์ pid_enc หลัง GRANT ทั้งตารางจะไม่มีผล เพราะสิทธิ์ระดับตารางยังครอบคลุมอยู่
  // ต้อง REVOKE สิทธิ์ระดับตารางของ mdm.person ออกก่อน แล้ว GRANT กลับเฉพาะรายคอลัมน์ (ยกเว้น pid_enc)
  pgm.sql(`GRANT SELECT ON ALL TABLES IN SCHEMA mdm TO mdm_readonly;`);
  pgm.sql(`REVOKE SELECT ON mdm.person FROM mdm_readonly;`);
  pgm.sql(`
    GRANT SELECT (
      person_id, pid_hash, key_id, status, verification_status, thaid_verified_at, claimed_at,
      reverify_requested_at, reverify_due_at, expected_first_name_th, expected_last_name_th,
      deleted_at, version, created_at, updated_at
    ) ON mdm.person TO mdm_readonly;
  `);

  // --- mdm_audit (อ่าน audit เท่านั้น) ---
  pgm.sql(`GRANT SELECT ON ALL TABLES IN SCHEMA audit TO mdm_audit;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM mdm_audit;`);

  pgm.sql(`
    REVOKE SELECT (
      person_id, pid_hash, key_id, status, verification_status, thaid_verified_at, claimed_at,
      reverify_requested_at, reverify_due_at, expected_first_name_th, expected_last_name_th,
      deleted_at, version, created_at, updated_at
    ) ON mdm.person FROM mdm_readonly;
  `);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA mdm FROM mdm_readonly;`);

  pgm.sql(`REVOKE ALL ON integration.webhook_delivery FROM mdm_worker;`);
  pgm.sql(`REVOKE ALL ON integration.outbox_event, integration.webhook_subscription FROM mdm_worker;`);
  pgm.sql(`REVOKE ALL ON audit.thaid_sync_event, audit.data_change_log, audit.access_log FROM mdm_worker;`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA mdm FROM mdm_worker;`);
  pgm.sql(`REVOKE USAGE ON audit.data_change_log_log_id_seq FROM mdm_worker;`);

  pgm.sql(`REVOKE ALL ON integration.webhook_delivery FROM mdm_app;`);
  pgm.sql(`REVOKE ALL ON integration.webhook_subscription FROM mdm_app;`);
  pgm.sql(`REVOKE ALL ON integration.outbox_event FROM mdm_app;`);
  pgm.sql(`REVOKE ALL ON audit.thaid_sync_event, audit.data_change_log, audit.access_log FROM mdm_app;`);
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA mdm FROM mdm_app;`);
  pgm.sql(`REVOKE USAGE ON audit.data_change_log_log_id_seq, audit.access_log_access_id_seq, integration.outbox_event_sequence_seq FROM mdm_app;`);
};
