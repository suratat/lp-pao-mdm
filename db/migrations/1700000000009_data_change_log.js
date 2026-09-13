/* eslint-disable camelcase */

exports.shorthands = undefined;

// audit.data_change_log - ฟิลด์ใดเปลี่ยนจากอะไรเป็นอะไร เมื่อไหร่ โดยใคร/แหล่งใด (§1.2, §1.4)
// append-only บังคับใช้ใน migration 0014_audit_append_only.js
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'audit', name: 'data_change_log' },
    {
      log_id: { type: 'bigserial', primaryKey: true },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'RESTRICT',
      },
      sync_event_id: {
        type: 'uuid',
        references: { schema: 'audit', name: 'thaid_sync_event' },
        onDelete: 'SET NULL',
      },
      table_name: { type: 'varchar(100)', notNull: true },
      field_name: { type: 'varchar(100)', notNull: true },
      old_value: { type: 'jsonb' },
      new_value: { type: 'jsonb' },
      changed_by: {
        type: 'varchar(20)',
        notNull: true,
        check: "changed_by IN ('THAID_SYNC', 'SELF', 'HR', 'HR_IMPORT', 'ADMIN')",
      },
      actor_sub: { type: 'varchar(255)' },
      reason: { type: 'text' },
      changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'audit', name: 'data_change_log' }, 'person_id');
  pgm.createIndex({ schema: 'audit', name: 'data_change_log' }, 'sync_event_id');
  pgm.createIndex({ schema: 'audit', name: 'data_change_log' }, 'changed_at');
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'audit', name: 'data_change_log' });
};
