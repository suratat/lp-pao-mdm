/* eslint-disable camelcase */

exports.shorthands = undefined;

// audit.access_log - ใครอ่านฟิลด์ใดของใคร partition รายเดือนตาม §1.1, §1.4, §1.6
// PostgreSQL บังคับให้คอลัมน์ที่ใช้ partition (accessed_at) ต้องอยู่ใน PK ด้วย จึงใช้ PK แบบ composite
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE audit.access_log (
      access_id bigserial NOT NULL,
      accessed_at timestamptz NOT NULL DEFAULT now(),
      subject_person_id uuid NOT NULL REFERENCES mdm.person(person_id),
      actor_type varchar(10) NOT NULL CHECK (actor_type IN ('USER', 'SERVICE')),
      actor_sub varchar(255),
      consumer_system_id uuid REFERENCES mdm.consumer_system(consumer_system_id),
      keycloak_client_id varchar(100),
      endpoint varchar(255) NOT NULL,
      http_method varchar(10) NOT NULL,
      fields_returned jsonb,
      purpose_code varchar(50),
      justification text,
      request_id varchar(100),
      client_ip inet,
      response_status integer,
      PRIMARY KEY (access_id, accessed_at)
    ) PARTITION BY RANGE (accessed_at);
  `);

  pgm.sql(`CREATE INDEX access_log_subject_accessed_idx ON audit.access_log (subject_person_id, accessed_at);`);

  // สร้าง partition รายเดือนล่วงหน้า (เดือนปัจจุบัน + 2 เดือนถัดไป) และ default partition กันตกหล่น
  // การสร้าง partition เดือนถัดไปเป็นงานบำรุงรักษาของ mdm-worker (T4) ฟังก์ชันนี้ให้ worker เรียกซ้ำได้ (idempotent)
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit.ensure_access_log_partition(for_month date)
    RETURNS void AS $$
    DECLARE
      partition_start date := date_trunc('month', for_month)::date;
      partition_end date := (date_trunc('month', for_month) + interval '1 month')::date;
      partition_name text := 'access_log_' || to_char(partition_start, 'YYYY_MM');
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS audit.%I PARTITION OF audit.access_log FOR VALUES FROM (%L) TO (%L);',
        partition_name, partition_start, partition_end
      );
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`CREATE TABLE audit.access_log_default PARTITION OF audit.access_log DEFAULT;`);
  pgm.sql(`SELECT audit.ensure_access_log_partition(date_trunc('month', now())::date);`);
  pgm.sql(`SELECT audit.ensure_access_log_partition((date_trunc('month', now()) + interval '1 month')::date);`);
};

exports.down = (pgm) => {
  pgm.sql('DROP FUNCTION IF EXISTS audit.ensure_access_log_partition(date);');
  pgm.sql('DROP TABLE IF EXISTS audit.access_log CASCADE;');
};
