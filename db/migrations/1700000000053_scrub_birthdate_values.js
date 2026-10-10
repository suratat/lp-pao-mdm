/* eslint-disable camelcase */

exports.shorthands = undefined;

// ข้อยกเว้น "ครั้งเดียว" สองข้อพร้อมกัน - แบบเดียวกับ migration 1700000000046 / 1700000000052:
//   - กฎข้อ 4 ของ CLAUDE.md (schema audit เป็น append-only): ล้างค่าวันเกิดใน audit.data_change_log
//   - กฎข้อ 2 ของ CLAUDE.md (person_identity เขียนได้จาก POST /sync/thaid เท่านั้น): ล้าง person_identity.birth_date
//
// เหตุผล: ระบบนี้ใช้ยืนยันตัวตนและตรวจสิทธิ์เท่านั้น วันเกิดไม่มีหน้าที่ใด โค้ดหยุดเก็บและหยุดคืนค่าแล้ว (#99 วันเกิดที่ HR กรอก,
// #100 วันเกิดจาก ThaID) แต่ค่าที่เขียนไปก่อนหน้านั้นยังค้างอยู่ migration นี้ล้างค่าที่เหลือ "เฉพาะค่า" ไม่ drop คอลัมน์ ไม่ลบแถว
//
// ผลนับบน prod ก่อนเขียน migration นี้ (ตามที่เจ้าของระบบแจ้ง): mdm.person.expected_birth_date 1 แถว, mdm.person_identity.birth_date 3 แถว,
// audit.data_change_log (field_name = person.expected_birth_date / identity.birth_date) 4 แถว
//
// วันที่: 2026-10-10
// อนุมัติโดย suratat 2026-10-10 (ล้างค่าวันเกิดเดิมหลัง #99 และ #100)
//
// ขอบเขต (สามตาราง ไม่แตะอย่างอื่น):
//   1) mdm.person:           expected_birth_date = NULL ทุกแถวที่ไม่เป็น NULL
//   2) mdm.person_identity:  birth_date = NULL ทุกแถวที่ไม่เป็น NULL
//   3) audit.data_change_log: old_value = NULL, new_value = NULL เฉพาะแถว field_name IN ('person.expected_birth_date', 'identity.birth_date')
//      เลือกตั้งเป็น NULL เพราะ old_value/new_value เป็น jsonb ที่ nullable อยู่แล้ว และ NULL คือสิ่งที่ changeLogWriter เขียนอยู่แล้วเมื่อ
//      field_policy.log_values_in_audit = false (ความหมายเดียวกับ "ไม่เก็บค่า") ไม่ใช้ค่าอื่น (เช่น 'REDACTED') เพื่อไม่ให้มีค่าปลอมใน jsonb
//      คงแถวไว้ครบ (field_name, changed_at, changed_by, reason, actor ฯลฯ ไม่แตะ) data_change_log ไม่ได้แบ่ง partition (migration 009)
//      แต่ตรวจเจ้าของด้วย pg_partition_tree เพื่อให้ถูกต้องหากภายหลังแบ่ง partition
//   ไม่แตะ: โครงสร้างคอลัมน์, field_policy (ต้องคงไว้ให้ประวัติเก่าที่เหลือยังถูกปกปิดค่า), audit.access_log, audit.thaid_sync_event,
//   integration.outbox_event (เก็บแค่ชื่อฟิลด์), stg_hr.raw_row
//
// trigger บนสามตาราง (ตรวจจาก migrations ทั้งหมด):
//   - mdm.person: person_expected_identity_guard (migration 051, BEFORE UPDATE OF expected_* เมื่อค่า expected_* เปลี่ยนจริง) จะ RAISE MD001 กับคนที่เคย
//     ยืนยัน/claim แล้ว -> ปิดเฉพาะตัวนี้ชั่วคราวใน transaction นี้แล้วเปิดคืน ไม่มี trigger อื่นบน mdm.person (ไม่มี trigger bump version / updated_at /
//     เขียน outbox / data_change_log) การ UPDATE นี้จึงไม่เปลี่ยน version, updated_at, ไม่เกิด outbox event, ไม่เกิด data_change_log เพิ่ม
//   - mdm.person_identity: ไม่มี trigger
//   - audit.data_change_log: data_change_log_append_only (migration 014) -> ปิดชั่วคราวแล้วเปิดคืน
//
// ความปลอดภัย (ทั้งหมดอยู่ใน transaction เดียว - node-pg-migrate ห่อทั้งไฟล์ - RAISE EXCEPTION แล้วทุกอย่างย้อนกลับ รวมการปิด trigger):
//   1) current_user ต้องเป็นเจ้าของ mdm.person และทุกตารางใน partition tree ของ audit.data_change_log (DISABLE TRIGGER ต้องเป็นเจ้าของ) ไม่ใช่ -> EXCEPTION
//   2) ปิด trigger ก่อนนับ (คำสั่งนี้ขอ lock ที่กันการเขียนระหว่างนับกับแก้) แล้วนับ: จำนวนแถวทั้งหมดของ data_change_log, จำนวนที่จะล้างในแต่ละตาราง,
//      count + sum(version) ของ mdm.person
//   3) จำนวนที่ UPDATE ต้องเท่ากับจำนวนที่นับในแต่ละตาราง ไม่เท่า -> EXCEPTION
//   4) เปิด trigger คืน แล้วตรวจ: จำนวนแถวทั้งหมดของ data_change_log เท่าเดิม, ไม่เหลือแถวของสองฟิลด์ที่ old/new ไม่ใช่ NULL,
//      ไม่เหลือ expected_birth_date / birth_date ที่ไม่ใช่ NULL, count + sum(version) ของ mdm.person เท่าเดิม, และ trigger ทั้งสอง tgenabled = 'O' -> ไม่ใช่ EXCEPTION
//   5) รันซ้ำได้ (idempotent): รอบสองนับได้ 0 แถวทุกตาราง ไม่เกิดผล (ยังปิด/เปิด trigger และตรวจเหมือนเดิม)
//   6) สิทธิ์ของ mdm_app/mdm_worker (REVOKE UPDATE/DELETE บน audit) ไม่ถูกแตะ - migration นี้ใช้สิทธิ์เจ้าของตารางเท่านั้น
//   หมายเหตุ: ไฟล์ backup (pg_dump) ที่ทำก่อนหน้านี้ยังมีค่าวันเกิดเดิมอยู่
//
// down: ย้อนไม่ได้ (ค่าถูกล้างถาวรโดยตั้งใจ) จึงไม่ทำอะไร - ไม่ throw เพราะ migrate-roundtrip.test.js และเทสต์อื่นๆ down ทุก migration เพื่อสร้างสถานะทดสอบ
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      not_owned text;
      log_total_before bigint;
      person_count_before bigint;
      person_version_sum_before bigint;
      expected_person bigint;
      expected_identity bigint;
      expected_log bigint;
      updated_person bigint;
      updated_identity bigint;
      updated_log bigint;
      log_total_after bigint;
      person_count_after bigint;
      person_version_sum_after bigint;
      remaining bigint;
      bad_triggers text;
    BEGIN
      SELECT string_agg(rel, ', ') INTO not_owned FROM (
        SELECT t.relid::regclass::text AS rel
        FROM pg_partition_tree('audit.data_change_log'::regclass) t
        JOIN pg_class c ON c.oid = t.relid
        WHERE pg_get_userbyid(c.relowner) <> current_user
        UNION ALL
        SELECT 'mdm.person'
        FROM pg_class c
        WHERE c.oid = 'mdm.person'::regclass AND pg_get_userbyid(c.relowner) <> current_user
      ) x;
      IF not_owned IS NOT NULL THEN
        RAISE EXCEPTION 'current_user (%) ไม่ได้เป็นเจ้าของ: % - ต้องรัน migration นี้ด้วย role เจ้าของตาราง', current_user, not_owned;
      END IF;

      ALTER TABLE audit.data_change_log DISABLE TRIGGER data_change_log_append_only;
      ALTER TABLE mdm.person DISABLE TRIGGER person_expected_identity_guard;

      SELECT count(*) INTO log_total_before FROM audit.data_change_log;
      SELECT count(*), COALESCE(sum(version), 0) INTO person_count_before, person_version_sum_before FROM mdm.person;
      SELECT count(*) INTO expected_person FROM mdm.person WHERE expected_birth_date IS NOT NULL;
      SELECT count(*) INTO expected_identity FROM mdm.person_identity WHERE birth_date IS NOT NULL;
      SELECT count(*) INTO expected_log FROM audit.data_change_log
        WHERE field_name IN ('person.expected_birth_date', 'identity.birth_date') AND (old_value IS NOT NULL OR new_value IS NOT NULL);

      UPDATE mdm.person SET expected_birth_date = NULL WHERE expected_birth_date IS NOT NULL;
      GET DIAGNOSTICS updated_person = ROW_COUNT;

      UPDATE mdm.person_identity SET birth_date = NULL WHERE birth_date IS NOT NULL;
      GET DIAGNOSTICS updated_identity = ROW_COUNT;

      UPDATE audit.data_change_log SET old_value = NULL, new_value = NULL
        WHERE field_name IN ('person.expected_birth_date', 'identity.birth_date') AND (old_value IS NOT NULL OR new_value IS NOT NULL);
      GET DIAGNOSTICS updated_log = ROW_COUNT;

      ALTER TABLE mdm.person ENABLE TRIGGER person_expected_identity_guard;
      ALTER TABLE audit.data_change_log ENABLE TRIGGER data_change_log_append_only;

      IF updated_person <> expected_person OR updated_identity <> expected_identity OR updated_log <> expected_log THEN
        RAISE EXCEPTION 'จำนวนแถวที่ UPDATE ไม่ตรงกับที่นับได้ (person % / %, person_identity % / %, data_change_log % / %) - ย้อนกลับทั้งหมด',
          updated_person, expected_person, updated_identity, expected_identity, updated_log, expected_log;
      END IF;

      SELECT count(*) INTO log_total_after FROM audit.data_change_log;
      IF log_total_after <> log_total_before THEN
        RAISE EXCEPTION 'จำนวนแถวของ audit.data_change_log เปลี่ยน (% -> %) - ย้อนกลับทั้งหมด', log_total_before, log_total_after;
      END IF;

      SELECT count(*), COALESCE(sum(version), 0) INTO person_count_after, person_version_sum_after FROM mdm.person;
      IF person_count_after <> person_count_before OR person_version_sum_after <> person_version_sum_before THEN
        RAISE EXCEPTION 'จำนวนแถว/ผลรวม version ของ mdm.person เปลี่ยน (% / % -> % / %) - ย้อนกลับทั้งหมด',
          person_count_before, person_version_sum_before, person_count_after, person_version_sum_after;
      END IF;

      SELECT count(*) INTO remaining FROM audit.data_change_log
        WHERE field_name IN ('person.expected_birth_date', 'identity.birth_date') AND (old_value IS NOT NULL OR new_value IS NOT NULL);
      IF remaining <> 0 THEN
        RAISE EXCEPTION 'ยังเหลือแถวของ data_change_log ที่มีค่าวันเกิด % แถว - ย้อนกลับทั้งหมด', remaining;
      END IF;
      SELECT (SELECT count(*) FROM mdm.person WHERE expected_birth_date IS NOT NULL)
           + (SELECT count(*) FROM mdm.person_identity WHERE birth_date IS NOT NULL) INTO remaining;
      IF remaining <> 0 THEN
        RAISE EXCEPTION 'ยังเหลือค่าวันเกิดในตาราง mdm % แถว - ย้อนกลับทั้งหมด', remaining;
      END IF;

      SELECT string_agg(name, ', ') INTO bad_triggers FROM (
        SELECT 'mdm.person.person_expected_identity_guard' AS name
        WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'mdm.person'::regclass AND g.tgname = 'person_expected_identity_guard' AND g.tgenabled = 'O')
        UNION ALL
        SELECT t.relid::regclass::text || '.data_change_log_append_only'
        FROM pg_partition_tree('audit.data_change_log'::regclass) t
        LEFT JOIN pg_trigger g ON g.tgrelid = t.relid AND g.tgname = 'data_change_log_append_only'
        WHERE g.oid IS NULL OR g.tgenabled <> 'O'
      ) y;
      IF bad_triggers IS NOT NULL THEN
        RAISE EXCEPTION 'trigger ไม่ได้เปิดคืน: % - ย้อนกลับทั้งหมด', bad_triggers;
      END IF;

      RAISE NOTICE 'scrub ค่าวันเกิด: person.expected_birth_date % แถว, person_identity.birth_date % แถว, data_change_log % แถว (จาก % แถวทั้งหมด, ไม่ลบแถว); ที่คาดไว้บน prod: 1 / 3 / 4',
        updated_person, updated_identity, updated_log, log_total_after;
    END
    $$;
  `);
};

exports.down = () => {};
