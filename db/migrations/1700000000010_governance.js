/* eslint-disable camelcase */

exports.shorthands = undefined;

// PDPA governance: วัตถุประสงค์การประมวลผล, ความยินยอม, ทะเบียนระบบปลายทาง - §1.3, §1.4
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'processing_purpose' },
    {
      purpose_code: { type: 'varchar(50)', primaryKey: true },
      name_th: { type: 'varchar(255)', notNull: true },
      legal_basis: {
        type: 'varchar(20)',
        notNull: true,
        check:
          "legal_basis IN ('PUBLIC_TASK', 'LEGAL_OBLIGATION', 'CONTRACT', 'CONSENT', 'VITAL_INTEREST')",
      },
      requires_consent: { type: 'boolean', notNull: true, default: false },
      retention_period: { type: 'varchar(20)' },
      description: { type: 'text' },
      ropa_ref: { type: 'varchar(100)' },
      is_active: { type: 'boolean', notNull: true, default: true },
    }
  );
  // §1.3: requires_consent = true ได้เฉพาะเมื่อ legal_basis = CONSENT
  pgm.addConstraint(
    { schema: 'mdm', name: 'processing_purpose' },
    'processing_purpose_consent_ck',
    "CHECK (NOT requires_consent OR legal_basis = 'CONSENT')"
  );

  pgm.createTable(
    { schema: 'mdm', name: 'consent_record' },
    {
      consent_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'CASCADE',
      },
      purpose_code: {
        type: 'varchar(50)',
        notNull: true,
        references: { schema: 'mdm', name: 'processing_purpose' },
        onDelete: 'RESTRICT',
      },
      policy_version: { type: 'varchar(50)', notNull: true },
      status: {
        type: 'varchar(10)',
        notNull: true,
        check: "status IN ('GRANTED', 'WITHDRAWN')",
      },
      granted_at: { type: 'timestamptz' },
      withdrawn_at: { type: 'timestamptz' },
      channel: {
        type: 'varchar(30)',
        check: "channel IN ('SELF_SERVICE_PORTAL', 'HR_FORM')",
      },
      evidence: { type: 'jsonb' },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'consent_record' }, ['person_id', 'purpose_code']);

  pgm.createTable(
    { schema: 'mdm', name: 'consumer_system' },
    {
      consumer_system_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      keycloak_client_id: { type: 'varchar(100)', notNull: true },
      name: { type: 'varchar(255)', notNull: true },
      owner_org_unit_id: {
        type: 'uuid',
        references: { schema: 'mdm', name: 'org_unit' },
        onDelete: 'SET NULL',
      },
      purpose_code: {
        type: 'varchar(50)',
        notNull: true,
        references: { schema: 'mdm', name: 'processing_purpose' },
        onDelete: 'RESTRICT',
      },
      allowed_scopes: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
      contact_email: { type: 'varchar(255)' },
      status: {
        type: 'varchar(10)',
        notNull: true,
        default: 'ACTIVE',
        check: "status IN ('ACTIVE', 'SUSPENDED')",
      },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'consumer_system' }, 'keycloak_client_id', { unique: true });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'consumer_system' });
  pgm.dropTable({ schema: 'mdm', name: 'consent_record' });
  pgm.dropTable({ schema: 'mdm', name: 'processing_purpose' });
};
