/* eslint-disable camelcase */

exports.shorthands = undefined;

// PR-A (DPO): audit.data_change_log เก็บ actor_sub มาตั้งแต่ migration 009 แต่ไม่มีโค้ดไหนเขียนค่านี้เลย (แก้ในโค้ดของ PR เดียวกัน
// ผ่าน api/src/services/changeLogWriter.js) migration นี้เพิ่มคอลัมน์ actor_client (azp ของ token ที่เรียก - เหมือน
// audit.reference_change_log) และ index สำหรับ filter ในหน้า DPO (GET /audit/change-logs)
//
// ADD COLUMN เป็น DDL ไม่ชน trigger append-only (trigger ทำงานเฉพาะ UPDATE/DELETE ระดับแถว) แถวเดิมจะเป็น NULL ทั้ง actor_sub
// และ actor_client แก้ย้อนหลังไม่ได้ (append-only) หน้า DPO แสดงเป็น "ไม่ทราบ"
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE audit.data_change_log ADD COLUMN actor_client varchar(255);`);

  pgm.createIndex({ schema: 'audit', name: 'data_change_log' }, ['actor_sub', 'changed_at'], {
    name: 'data_change_log_actor_changed_idx',
  });
  pgm.createIndex({ schema: 'audit', name: 'data_change_log' }, ['table_name', 'changed_at'], {
    name: 'data_change_log_table_changed_idx',
  });
  pgm.createIndex({ schema: 'audit', name: 'reference_change_log' }, ['actor_sub', 'changed_at'], {
    name: 'reference_change_log_actor_changed_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex({ schema: 'audit', name: 'reference_change_log' }, ['actor_sub', 'changed_at'], {
    name: 'reference_change_log_actor_changed_idx',
  });
  pgm.dropIndex({ schema: 'audit', name: 'data_change_log' }, ['table_name', 'changed_at'], {
    name: 'data_change_log_table_changed_idx',
  });
  pgm.dropIndex({ schema: 'audit', name: 'data_change_log' }, ['actor_sub', 'changed_at'], {
    name: 'data_change_log_actor_changed_idx',
  });
  pgm.sql(`ALTER TABLE audit.data_change_log DROP COLUMN actor_client;`);
};
