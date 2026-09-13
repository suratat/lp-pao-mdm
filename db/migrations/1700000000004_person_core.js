/* eslint-disable camelcase */

exports.shorthands = undefined;

// ตาราง anchor (mdm.person) + เหตุการณ์ sync (audit.thaid_sync_event) + ข้อมูลระบุตัวตนจาก ThaID
// (mdm.person_identity, mdm.person_photo) - §1.2, §1.4, §1.6
exports.up = (pgm) => {
  pgm.createTable(
    { schema: 'mdm', name: 'person' },
    {
      person_id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
      },
      pid_hash: { type: 'varchar(64)' }, // hex ของ HMAC-SHA256, UNIQUE ด้านล่าง (nullable ชั่วคราวระหว่าง migrate ข้อมูลเก่าที่ไม่มีเลขบัตร)
      pid_enc: { type: 'bytea' },
      key_id: {
        type: 'varchar(200)',
        references: { schema: 'mdm', name: 'encryption_key' },
        onDelete: 'RESTRICT',
      },
      status: {
        type: 'varchar(20)',
        notNull: true,
        default: 'PENDING_CLAIM',
        check: "status IN ('PENDING_CLAIM', 'ACTIVE', 'INACTIVE')",
      },
      verification_status: {
        type: 'varchar(20)',
        notNull: true,
        default: 'UNVERIFIED',
        check: "verification_status IN ('UNVERIFIED', 'VERIFIED', 'STALE', 'EXPIRED')",
      },
      thaid_verified_at: { type: 'timestamptz' },
      claimed_at: { type: 'timestamptz' },
      reverify_requested_at: { type: 'timestamptz' },
      reverify_due_at: { type: 'timestamptz' },
      expected_first_name_th: { type: 'varchar(200)' },
      expected_last_name_th: { type: 'varchar(200)' },
      deleted_at: { type: 'timestamptz' },
      version: { type: 'integer', notNull: true, default: 1 },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );

  // กันข้อมูลซ้ำ - §1.6: UNIQUE (pid_hash) แต่ยอมให้เป็น NULL ได้หลายแถว (ยังไม่ผูก pid)
  pgm.createIndex({ schema: 'mdm', name: 'person' }, 'pid_hash', {
    unique: true,
    where: 'pid_hash IS NOT NULL',
    name: 'person_pid_hash_uk',
  });
  pgm.createIndex({ schema: 'mdm', name: 'person' }, ['status', 'verification_status']);
  pgm.createIndex({ schema: 'mdm', name: 'person' }, 'thaid_verified_at');

  pgm.createTable(
    { schema: 'audit', name: 'thaid_sync_event' },
    {
      sync_event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      person_id: {
        type: 'uuid',
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'RESTRICT',
      }, // null เมื่อ UNMATCHED
      trigger: {
        type: 'varchar(20)',
        notNull: true,
        check: "trigger IN ('LOGIN', 'REVERIFY', 'CLAIM')",
      },
      result: {
        type: 'varchar(20)',
        notNull: true,
        check: "result IN ('NO_CHANGE', 'UPDATED', 'CLAIMED', 'UNMATCHED', 'REJECTED_INACTIVE')",
      },
      app_id: { type: 'varchar(100)' },
      audience: { type: 'varchar(20)', check: "audience IN ('PERSONNEL', 'CITIZEN')" },
      snapshot_hash_before: { type: 'varchar(64)' },
      snapshot_hash_after: { type: 'varchar(64)' },
      changed_fields: { type: 'jsonb' },
      ial: { type: 'varchar(10)' },
      aal: { type: 'varchar(10)' },
      client_ip: { type: 'inet' },
      user_agent: { type: 'text' },
      occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.createIndex({ schema: 'audit', name: 'thaid_sync_event' }, 'person_id');
  pgm.createIndex({ schema: 'audit', name: 'thaid_sync_event' }, 'occurred_at');

  pgm.createTable(
    { schema: 'mdm', name: 'person_identity' },
    {
      person_id: {
        type: 'uuid',
        primaryKey: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'CASCADE',
      },
      title_th: { type: 'varchar(50)' },
      first_name_th: { type: 'varchar(200)' },
      middle_name_th: { type: 'varchar(200)' },
      last_name_th: { type: 'varchar(200)' },
      title_en: { type: 'varchar(50)' },
      first_name_en: { type: 'varchar(200)' },
      last_name_en: { type: 'varchar(200)' },
      birth_date: { type: 'date' },
      gender: { type: 'varchar(10)' },
      reg_house_no: { type: 'varchar(50)' },
      reg_moo: { type: 'varchar(20)' },
      reg_soi: { type: 'varchar(100)' },
      reg_road: { type: 'varchar(100)' },
      reg_subdistrict_code: { type: 'varchar(10)' },
      reg_district_code: { type: 'varchar(10)' },
      reg_province_code: { type: 'varchar(10)' },
      reg_address_text: { type: 'text' },
      id_card_issue_date: { type: 'date' },
      id_card_expire_date: { type: 'date' },
      ial: { type: 'varchar(10)' },
      source_snapshot_hash: { type: 'varchar(64)' },
      last_sync_event_id: {
        type: 'uuid',
        references: { schema: 'audit', name: 'thaid_sync_event' },
        onDelete: 'SET NULL',
      },
      synced_at: { type: 'timestamptz' },
    }
  );

  pgm.createTable(
    { schema: 'mdm', name: 'person_photo' },
    {
      photo_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      person_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'mdm', name: 'person' },
        onDelete: 'CASCADE',
      },
      image_enc: { type: 'bytea' },
      sha256: { type: 'varchar(64)' },
      mime_type: { type: 'varchar(50)' },
      source: { type: 'varchar(10)', notNull: true, default: 'THAID', check: "source IN ('THAID')" },
      is_current: { type: 'boolean', notNull: true, default: false },
      synced_at: { type: 'timestamptz' },
    }
  );
  pgm.createIndex({ schema: 'mdm', name: 'person_photo' }, 'person_id');
  // ธุรกิจกำหนดให้มีรูป "current" ได้เพียงหนึ่งรูปต่อคน (ER 1/2: "current หนึ่งรูป")
  pgm.createIndex({ schema: 'mdm', name: 'person_photo' }, 'person_id', {
    unique: true,
    where: 'is_current',
    name: 'person_photo_one_current_uk',
  });
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'mdm', name: 'person_photo' });
  pgm.dropTable({ schema: 'mdm', name: 'person_identity' });
  pgm.dropTable({ schema: 'audit', name: 'thaid_sync_event' });
  pgm.dropTable({ schema: 'mdm', name: 'person' });
};
