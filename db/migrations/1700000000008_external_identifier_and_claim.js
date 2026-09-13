/* eslint-disable camelcase */

exports.shorthands = undefined;

// รหัสอ้างอิงในระบบอื่น (mdm.external_identifier) และคำขอ claim ที่รอ HR ตัดสิน (mdm.claim_request) - §1.2, §1.4
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'external_identifier' },
    {
      ext_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'CASCADE',
      },
      system_code: {
        type: 'varchar(30)',
        notNull: true,
        check: "system_code IN ('LEGACY_HR', 'LHR', 'KEYCLOAK', 'PAYROLL', 'EOFFICE')",
      },
      external_value: { type: 'varchar(200)', notNull: true },
      is_primary: { type: 'boolean', notNull: true, default: false },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'external_identifier' }, 'person_id');
  pgm.createIndex(
    { schema: 'mdm', name: 'external_identifier' },
    ['system_code', 'external_value'],
    { unique: true }
  );

  pgm.createTable(
    { schema: 'mdm', name: 'claim_request' },
    {
      claim_request_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      pid_hash: { type: 'varchar(64)', notNull: true }, // ไม่เก็บ pid จริง
      display_name: { type: 'varchar(255)' },
      status: {
        type: 'varchar(20)',
        notNull: true,
        default: 'PENDING_HR',
        check: "status IN ('PENDING_HR', 'LINKED', 'REJECTED')",
      },
      resolved_person_id: {
        type: 'uuid',
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'SET NULL',
      },
      resolved_by: { type: 'varchar(100)' },
      resolved_at: { type: 'timestamptz' },
      attempt_count: { type: 'integer', notNull: true, default: 1 },
      first_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  // ใช้เป็นคีย์ของ UPSERT ตอน sync (ยิง MDM->>DB: UPSERT claim_request ตาม seq-01)
  pgm.createIndex({ schema: 'mdm', name: 'claim_request' }, 'pid_hash', { unique: true });
  pgm.createIndex({ schema: 'mdm', name: 'claim_request' }, 'status');
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'claim_request' });
  pgm.dropTable({ schema: 'mdm', name: 'external_identifier' });
};
