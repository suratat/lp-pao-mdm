/* eslint-disable camelcase */

exports.shorthands = undefined;

// แคตตาล็อกฟิลด์ที่ขับเคลื่อน field-level filter และหน้า self-service - §1.2, §1.4
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'field_policy' },
    {
      field_key: { type: 'varchar(100)', primaryKey: true },
      table_name: { type: 'varchar(100)', notNull: true },
      column_name: { type: 'varchar(100)', notNull: true },
      source: {
        type: 'varchar(10)',
        notNull: true,
        check: "source IN ('THAID', 'SELF', 'HR', 'SYSTEM')",
      },
      classification: {
        type: 'varchar(20)',
        notNull: true,
        check: "classification IN ('INTERNAL', 'CONFIDENTIAL', 'SENSITIVE', 'RESTRICTED')",
      },
      required_scope: { type: 'varchar(100)', notNull: true },
      editable_by: {
        type: 'varchar(10)',
        notNull: true,
        default: 'NONE',
        check: "editable_by IN ('NONE', 'SELF', 'HR')",
      },
      log_values_in_audit: { type: 'boolean', notNull: true, default: true },
      mask_pattern: { type: 'varchar(50)' },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'field_policy' }, 'required_scope');
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'field_policy' });
};
