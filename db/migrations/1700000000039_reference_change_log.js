/* eslint-disable camelcase */

exports.shorthands = undefined;

// T10: audit.reference_change_log - บันทึกการเพิ่ม/แก้ master data (mdm.org_unit, mdm.position) ผ่าน
// POST/PUT /org-units, /positions
//
// ตั้งใจแยกจาก audit.data_change_log (ตัดสินใจโดยเจ้าของระบบ): data_change_log เป็นตารางที่ DPO ใช้ตรวจสอบ
// ข้อมูลบุคคลตาม PDPA (person_id NOT NULL) ไม่ผ่อน constraint เพื่อรองรับข้อมูลที่ไม่เกี่ยวกับบุคคล
// ถ้าต้องการให้ DPO ดูรวมกัน ให้ทำ view ในชั้น DPO console ภายหลัง
//
// append-only เหมือนตารางอื่นใน schema audit: trigger (ชั้นที่ 1) + REVOKE UPDATE/DELETE (ชั้นที่ 2)
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'audit', name: 'reference_change_log' },
    {
      log_id: { type: 'bigserial', primaryKey: true },
      table_name: { type: 'varchar(50)', notNull: true, check: "table_name IN ('org_unit', 'position')" },
      // ไม่มี FK เพราะอ้างได้สองตาราง และ log ต้องอยู่ได้แม้ record ต้นทางเปลี่ยนสถานะ
      record_id: { type: 'uuid', notNull: true },
      action: { type: 'varchar(10)', notNull: true, check: "action IN ('CREATE', 'UPDATE')" },
      field_name: { type: 'varchar(100)', notNull: true },
      old_value: { type: 'jsonb' },
      new_value: { type: 'jsonb' },
      actor_sub: { type: 'varchar(255)', notNull: true },
      actor_client: { type: 'varchar(255)' },
      changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'audit', name: 'reference_change_log' }, ['table_name', 'record_id']);
  pgm.createIndex({ schema: 'audit', name: 'reference_change_log' }, 'changed_at');

  pgm.sql(`
    CREATE TRIGGER reference_change_log_append_only
    BEFORE UPDATE OR DELETE ON audit.reference_change_log
    FOR EACH ROW EXECUTE FUNCTION audit.reject_update_delete();
  `);

  // ตารางใหม่ไม่ถูกครอบด้วย GRANT ... ON ALL TABLES ของ 0015_grants.js (มีผลเฉพาะตารางที่มีอยู่ตอนนั้น)
  pgm.sql(`GRANT SELECT, INSERT ON audit.reference_change_log TO mdm_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE ON audit.reference_change_log FROM mdm_app;`);
  pgm.sql(`GRANT USAGE ON SEQUENCE audit.reference_change_log_log_id_seq TO mdm_app;`);
  pgm.sql(`GRANT SELECT ON audit.reference_change_log TO mdm_audit;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON audit.reference_change_log FROM mdm_app, mdm_audit;`);
  pgm.sql(`DROP TRIGGER IF EXISTS reference_change_log_append_only ON audit.reference_change_log;`);
  pgm.dropTable({ schema: 'audit', name: 'reference_change_log' });
};
