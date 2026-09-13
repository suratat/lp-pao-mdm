/* eslint-disable camelcase */

exports.shorthands = undefined;

// บังคับ append-only ด้วย trigger (ชั้นที่ 1) - §1.1, §1.6
// การ REVOKE UPDATE/DELETE จาก role แอป (ชั้นที่ 2) อยู่ใน 0015_grants.js
// ตั้งแต่ PostgreSQL 11 trigger ระดับแถวที่สร้างบนตาราง partition แม่ (audit.access_log)
// จะถูกนำไปใช้กับทุก partition ทั้งที่มีอยู่แล้วและที่จะสร้างในอนาคตโดยอัตโนมัติ
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit.reject_update_delete()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'ตาราง % เป็น append-only: ไม่อนุญาตให้ % ', TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  for (const table of ['thaid_sync_event', 'data_change_log', 'access_log']) {
    pgm.sql(`
      CREATE TRIGGER ${table}_append_only
      BEFORE UPDATE OR DELETE ON audit.${table}
      FOR EACH ROW EXECUTE FUNCTION audit.reject_update_delete();
    `);
  }
};

exports.down = (pgm) => {
  for (const table of ['thaid_sync_event', 'data_change_log', 'access_log']) {
    pgm.sql(`DROP TRIGGER IF EXISTS ${table}_append_only ON audit.${table};`);
  }
  pgm.sql('DROP FUNCTION IF EXISTS audit.reject_update_delete();');
};
