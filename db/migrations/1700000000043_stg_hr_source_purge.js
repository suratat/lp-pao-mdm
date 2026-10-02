/* eslint-disable camelcase */

exports.shorthands = undefined;

// T8 §5.4 ("ไม่เก็บ plaintext ใน stg_hr เกิน 30 วัน") - ปิดช่องที่ worker job stgHrPurge ล้างแค่ pid_plaintext
// แต่ stg_hr.raw_row.source_data (แถวดิบทั้งแถวจาก CSV) ยังมีเลขบัตร/ชื่อ/เบอร์โทร/อีเมลซ้ำอยู่
//
// เพิ่ม 2 คอลัมน์:
//   loaded_at         เวลาโหลดแถวนี้ (NOT NULL ทุกแถว) ใช้เป็นจุดเริ่มนับอายุของ job ล้าง source_data เพราะ
//                     pid_loaded_at เป็น NULL เมื่อแถวไม่มี pid แต่ source_data ของแถวนั้นยังมีข้อมูลบุคคลอื่นอยู่
//   source_purged_at  marker ว่าล้าง source_data แล้ว (NULL = ยังไม่ล้าง) ทำให้ job รันซ้ำได้โดยไม่นับซ้ำ
//                     และไม่ต้องให้ worker มีสิทธิ์ SELECT source_data
//
// backfill loaded_at = COALESCE(pid_loaded_at, import_batch.imported_at, now()) เพื่อไม่ให้อายุของแถวเดิมเปลี่ยน
// โดยไม่ตั้งใจ: ใช้เวลาโหลดจริงเสมอเมื่อมี, now() เป็น fallback สุดท้ายเท่านั้น (ไม่น่าเกิดเพราะ batch_id NOT NULL FK)
//
// สิทธิ์ mdm_worker เป็นรายคอลัมน์เท่านั้น (ไม่ให้ทั้งตาราง และไม่ให้ SELECT source_data):
//   SELECT (loaded_at, source_purged_at), UPDATE (source_data, source_purged_at)
// trigger ป้องกันเพิ่ม: mdm_worker (ที่ไม่ใช่ superuser) เขียน source_data ได้เฉพาะ '{}'::jsonb เท่านั้น
// ไม่กระทบ INSERT ของ loadBatch (trigger ผูกกับ UPDATE OF source_data เท่านั้น) และไม่กระทบ owner/mdm_migrate
//
// คำเตือน: ห้ามรัน migration นี้บน production ก่อนสำรองฐานข้อมูล - migration ตัวนี้ไม่ล้างข้อมูลเอง แต่ job ที่
// ตามมา (stgHrPurge) จะเขียนทับ source_data เป็น '{}' ถาวร กู้คืนไม่ได้ และ down จะไม่คืนค่า source_data ที่ล้างไปแล้ว
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE stg_hr.raw_row
      ADD COLUMN loaded_at timestamptz,
      ADD COLUMN source_purged_at timestamptz;
  `);

  pgm.sql(`
    UPDATE stg_hr.raw_row r
    SET loaded_at = COALESCE(r.pid_loaded_at, b.imported_at, now())
    FROM stg_hr.import_batch b
    WHERE b.batch_id = r.batch_id;
  `);

  pgm.sql(`
    ALTER TABLE stg_hr.raw_row
      ALTER COLUMN loaded_at SET DEFAULT now(),
      ALTER COLUMN loaded_at SET NOT NULL;
  `);

  // job ล้างค้นเฉพาะแถวที่ยังไม่ล้าง เรียงตามอายุ
  pgm.sql(`
    CREATE INDEX raw_row_source_unpurged_idx ON stg_hr.raw_row (loaded_at)
    WHERE source_purged_at IS NULL;
  `);

  pgm.sql(`GRANT SELECT (loaded_at, source_purged_at) ON stg_hr.raw_row TO mdm_worker;`);
  pgm.sql(`GRANT UPDATE (source_data, source_purged_at) ON stg_hr.raw_row TO mdm_worker;`);

  // ตรวจเฉพาะ role ที่เป็นสมาชิก mdm_worker และไม่ใช่ superuser (superuser เป็นสมาชิกทุก role โดยปริยาย)
  pgm.sql(`
    CREATE FUNCTION stg_hr.guard_worker_source_data() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_data IS DISTINCT FROM '{}'::jsonb
         AND pg_has_role(current_user, 'mdm_worker', 'MEMBER')
         AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        RAISE EXCEPTION 'mdm_worker เขียน stg_hr.raw_row.source_data ได้เฉพาะ {} (ล้างข้อมูล) เท่านั้น'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER raw_row_guard_worker_source_data
    BEFORE UPDATE OF source_data ON stg_hr.raw_row
    FOR EACH ROW EXECUTE FUNCTION stg_hr.guard_worker_source_data();
  `);
};

// ลำดับ: trigger -> function -> grants -> index -> คอลัมน์ (ย้อนกลับของ up)
exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS raw_row_guard_worker_source_data ON stg_hr.raw_row;`);
  pgm.sql(`DROP FUNCTION IF EXISTS stg_hr.guard_worker_source_data();`);

  pgm.sql(`REVOKE UPDATE (source_data, source_purged_at) ON stg_hr.raw_row FROM mdm_worker;`);
  pgm.sql(`REVOKE SELECT (loaded_at, source_purged_at) ON stg_hr.raw_row FROM mdm_worker;`);

  pgm.sql(`DROP INDEX IF EXISTS stg_hr.raw_row_source_unpurged_idx;`);

  pgm.sql(`
    ALTER TABLE stg_hr.raw_row
      DROP COLUMN IF EXISTS source_purged_at,
      DROP COLUMN IF EXISTS loaded_at;
  `);
};
