/* eslint-disable camelcase */

exports.shorthands = undefined;

// T8 §5.3 ระยะ 1 (Data profiling): พื้นที่ staging สำหรับไฟล์ export จากระบบ HR เดิม (LHR/Excel ของ
// ฝ่ายบุคคล) ก่อนนำเข้าจริงผ่าน POST /sync/hr/employment-batch (T4) - "ไม่กระทบระบบที่ใช้งานอยู่" (§5.2):
// อ่านจาก export เท่านั้น, ไม่มี endpoint ใดเขียนตารางนี้นอกจาก migrate/ tool
//
// pid_plaintext: §5.4 ระบุว่าเก็บ plaintext ชั่วคราวได้เพื่อใช้เป็นคีย์จับคู่/ตรวจ checksum ก่อนส่งเข้า
// API (ซึ่งจะแปลงเป็น pid_hash/pid_enc) แต่ "ไม่เก็บ plaintext ใน stg_hr เกิน 30 วัน" - บังคับด้วย worker
// job stgHrPurge (T8) ที่ล้างคอลัมน์นี้เป็น NULL เท่านั้น (ไม่ลบแถว เพื่อคงร่องรอย reconciliation)
//
// resolved_org_unit_id/resolved_position_id: cache ผลการ resolve code -> UUID ตอนตรวจคุณภาพ เพื่อไม่ต้อง
// query mdm ซ้ำตอนแปลงเป็น EmploymentImportRow
exports.up = (pgm) => {
  pgm.createSchema('stg_hr', { ifNotExists: true });

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_migrate') THEN
        CREATE ROLE mdm_migrate NOLOGIN;
      END IF;
    END
    $$;
  `);

  pgm.createTable(
    { schema: 'stg_hr', name: 'import_batch' },
    {
      batch_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      source_system: { type: 'varchar(50)', notNull: true, default: 'LHR' },
      source_filename: { type: 'varchar(255)', notNull: true },
      imported_by: { type: 'varchar(100)', notNull: true },
      imported_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      status: {
        type: 'varchar(20)',
        notNull: true,
        default: 'LOADED',
        check: "status IN ('LOADED', 'QUALITY_CHECKED', 'DRY_RUN_DONE', 'APPLIED')",
      },
    }
  );

  pgm.createTable(
    { schema: 'stg_hr', name: 'raw_row' },
    {
      raw_row_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      batch_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'stg_hr', name: 'import_batch' },
        onDelete: 'CASCADE',
      },
      row_ref: { type: 'varchar(50)', notNull: true },

      // เลขบัตรประชาชน (plaintext ชั่วคราว - ดูหมายเหตุด้านบน)
      pid_plaintext: { type: 'varchar(13)' },
      pid_loaded_at: { type: 'timestamptz' },

      expected_first_name_th: { type: 'varchar(255)' },
      expected_last_name_th: { type: 'varchar(255)' },

      employee_no: { type: 'varchar(50)' },
      personnel_type_raw: { type: 'varchar(100)' },
      position_no: { type: 'varchar(50)' },
      org_unit_code: { type: 'varchar(50)' },
      level_code: { type: 'varchar(50)' },
      appointed_date_raw: { type: 'varchar(20)' },
      effective_from_raw: { type: 'varchar(20)' },
      employment_status_raw: { type: 'varchar(50)' },
      email_work: { type: 'varchar(255)' },

      // §5.4: "รหัสในระบบเดิม" - ใช้ตอน dual-run/สัปดาห์ถัดไป (ไม่ใช้ตอน migrate ครั้งแรกที่จับคู่ด้วย pid)
      external_system_code: { type: 'varchar(50)' },
      external_value: { type: 'varchar(100)' },

      // เก็บไว้เพื่ออ้างอิงของฝ่ายบุคคลเท่านั้น - ยังไม่มี endpoint นำเข้า person_contact เป็นชุด (T8 ไม่ครอบคลุม)
      phone_raw: { type: 'varchar(50)' },
      email_personal_raw: { type: 'varchar(255)' },

      source_data: { type: 'jsonb', notNull: true }, // แถวดิบทั้งหมดตามที่ parse จากไฟล์ (ก่อน map คอลัมน์)

      quality_status: {
        type: 'varchar(10)',
        notNull: true,
        default: 'PENDING',
        check: "quality_status IN ('PENDING', 'OK', 'ERROR')",
      },
      quality_errors: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },

      resolved_org_unit_id: { type: 'uuid', references: { schema: 'mdm', name: 'org_unit' } },
      resolved_position_id: { type: 'uuid', references: { schema: 'mdm', name: 'position' } },

      import_result_code: { type: 'varchar(30)' }, // ผลจาก ImportResult.errors[].code ของ /sync/hr/employment-batch (ถ้ามี)
    }
  );

  pgm.createIndex({ schema: 'stg_hr', name: 'raw_row' }, 'batch_id');
  pgm.createIndex({ schema: 'stg_hr', name: 'raw_row' }, 'quality_status');
  // ตรวจ pid ซ้ำภายในไฟล์เดียวกัน (กฎคุณภาพข้อ 2) - partial index เฉพาะแถวที่ยังไม่ล้าง plaintext
  pgm.createIndex({ schema: 'stg_hr', name: 'raw_row' }, ['batch_id', 'pid_plaintext'], {
    where: 'pid_plaintext IS NOT NULL',
    name: 'raw_row_batch_pid_idx',
  });
  // ใช้ค้นหาแถวที่ต้องล้าง plaintext ตอนอายุเกิน 30 วัน (worker job)
  pgm.createIndex({ schema: 'stg_hr', name: 'raw_row' }, 'pid_loaded_at', {
    where: 'pid_plaintext IS NOT NULL',
    name: 'raw_row_pid_loaded_at_idx',
  });

  pgm.sql(`GRANT USAGE ON SCHEMA stg_hr TO mdm_migrate, mdm_worker;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON stg_hr.import_batch, stg_hr.raw_row TO mdm_migrate;`);
  // worker (purge job) ต้องแค่ล้าง pid_plaintext เป็น NULL - ไม่ต้องเห็น/แก้ฟิลด์อื่น
  pgm.sql(`GRANT SELECT (raw_row_id, pid_plaintext, pid_loaded_at) ON stg_hr.raw_row TO mdm_worker;`);
  pgm.sql(`GRANT UPDATE (pid_plaintext) ON stg_hr.raw_row TO mdm_worker;`);

  // migrate/ tool ต้อง resolve org_unit_code/position_no -> UUID และทำ reconciliation กับ mdm.employment
  // แต่ห้ามแตะ mdm.person/pid_hash/pid_enc โดยตรง (เขียน person ได้ทางเดียวผ่าน API เท่านั้น - กฎข้อ 2)
  pgm.sql(`GRANT USAGE ON SCHEMA mdm TO mdm_migrate;`);
  pgm.sql(`GRANT SELECT ON mdm.org_unit, mdm.position, mdm.employment, mdm.personnel_type TO mdm_migrate;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON mdm.org_unit, mdm.position, mdm.employment, mdm.personnel_type FROM mdm_migrate;`);
  pgm.sql(`REVOKE USAGE ON SCHEMA mdm FROM mdm_migrate;`);
  pgm.sql(`REVOKE ALL ON stg_hr.raw_row FROM mdm_worker;`);
  pgm.sql(`REVOKE ALL ON stg_hr.import_batch, stg_hr.raw_row FROM mdm_migrate;`);
  pgm.sql(`REVOKE USAGE ON SCHEMA stg_hr FROM mdm_migrate, mdm_worker;`);

  pgm.dropTable({ schema: 'stg_hr', name: 'raw_row' });
  pgm.dropTable({ schema: 'stg_hr', name: 'import_batch' });

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_migrate') THEN
        DROP ROLE mdm_migrate;
      END IF;
    END
    $$;
  `);

  pgm.dropSchema('stg_hr', { ifExists: true, cascade: true });
};
