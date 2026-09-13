/* eslint-disable camelcase */

exports.shorthands = undefined;

// ทะเบียนเวอร์ชันคีย์ (คีย์จริงอยู่ใน Vault Transit) - §1.4, ภาคผนวก ข
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'encryption_key' },
    {
      key_id: { type: 'varchar(200)', primaryKey: true },
      purpose: {
        type: 'varchar(30)',
        notNull: true,
        check: "purpose IN ('PID_ENC', 'PID_HMAC_PEPPER', 'WEBHOOK_SECRET', 'PHOTO_ENC')",
      },
      provider: {
        type: 'varchar(20)',
        notNull: true,
        check: "provider IN ('VAULT_TRANSIT', 'LOCAL_KEK')",
      },
      key_version: { type: 'integer', notNull: true },
      status: {
        type: 'varchar(10)',
        notNull: true,
        default: 'ACTIVE',
        check: "status IN ('ACTIVE', 'ROTATING', 'RETIRED')",
      },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      retired_at: { type: 'timestamptz' },
    }
  );
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'encryption_key' });
};
