/* eslint-disable camelcase */

exports.shorthands = undefined;

// transactional outbox + webhook subscription/delivery - §1.3, §1.4, §2.3
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'integration', name: 'outbox_event' },
    {
      event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      sequence: { type: 'bigserial' },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'RESTRICT',
      },
      event_type: {
        type: 'varchar(30)',
        notNull: true,
        check:
          "event_type IN ('PERSON_CLAIMED', 'IDENTITY_UPDATED', 'PHOTO_UPDATED', 'CONTACT_UPDATED', 'EMPLOYMENT_UPDATED', 'PERSON_DEACTIVATED', 'PERSON_REACTIVATED', 'PERSON_MERGED', 'VERIFICATION_STALE', 'VERIFICATION_EXPIRED')",
      },
      changed_fields: { type: 'jsonb' },
      payload: { type: 'jsonb', notNull: true },
      version: { type: 'integer', notNull: true },
      occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      published_at: { type: 'timestamptz' },
    }
  );
  pgm.createIndex({ schema: 'integration', name: 'outbox_event' }, 'sequence', { unique: true });
  // §1.6: outbox_event(published_at) WHERE published_at IS NULL - ให้ dispatcher SELECT ... FOR UPDATE SKIP LOCKED ได้เร็ว
  pgm.createIndex({ schema: 'integration', name: 'outbox_event' }, 'published_at', {
    where: 'published_at IS NULL',
    name: 'outbox_event_unpublished_idx',
  });
  pgm.createIndex({ schema: 'integration', name: 'outbox_event' }, 'person_id');

  pgm.createTable(
    { schema: 'integration', name: 'webhook_subscription' },
    {
      subscription_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      consumer_system_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'consumer_system' },
        onDelete: 'CASCADE',
      },
      url: { type: 'text', notNull: true },
      secret_enc: { type: 'bytea', notNull: true },
      key_id: {
        type: 'varchar(200)',
        references: { schema: 'mdm', name: 'encryption_key' },
        onDelete: 'RESTRICT',
      },
      event_types: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
      is_active: { type: 'boolean', notNull: true, default: true },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  // §2.3: https เท่านั้น
  pgm.addConstraint(
    { schema: 'integration', name: 'webhook_subscription' },
    'webhook_subscription_https_only_ck',
    "CHECK (url LIKE 'https://%')"
  );
  pgm.createIndex({ schema: 'integration', name: 'webhook_subscription' }, 'consumer_system_id');

  pgm.createTable(
    { schema: 'integration', name: 'webhook_delivery' },
    {
      delivery_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      subscription_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'integration', name: 'webhook_subscription' },
        onDelete: 'CASCADE',
      },
      event_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'integration', name: 'outbox_event' },
        onDelete: 'CASCADE',
      },
      status: {
        type: 'varchar(10)',
        notNull: true,
        default: 'PENDING',
        check: "status IN ('PENDING', 'DELIVERED', 'FAILED', 'DEAD')",
      },
      attempt_count: { type: 'integer', notNull: true, default: 0 },
      next_attempt_at: { type: 'timestamptz' },
      last_response_code: { type: 'integer' },
      last_error: { type: 'text' },
      delivered_at: { type: 'timestamptz' },
    }
  );
  pgm.createIndex({ schema: 'integration', name: 'webhook_delivery' }, ['subscription_id', 'event_id'], {
    unique: true,
  });
  // §1.6: webhook_delivery(next_attempt_at) WHERE status IN ('PENDING','FAILED')
  pgm.createIndex({ schema: 'integration', name: 'webhook_delivery' }, 'next_attempt_at', {
    where: "status IN ('PENDING', 'FAILED')",
    name: 'webhook_delivery_due_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'integration', name: 'webhook_delivery' });
  pgm.dropTable({ schema: 'integration', name: 'webhook_subscription' });
  pgm.dropTable({ schema: 'integration', name: 'outbox_event' });
};
