-- Preflight check ก่อนรัน migration 1700000000033_seed_real_org_units.js บนฐานข้อมูลจริง (staging/production)
--
-- migration นั้นลบ org_unit ตัวอย่างของ T8 (code STRATEGY/PERSONNEL/PERSONNEL-ADMIN/PERSONNEL-ADMIN-REG)
-- และ position ตัวอย่าง (position_no POS-0001/POS-0002/POS-0003) ก่อนจะ insert โครงสร้างจริง 11
-- หน่วยงาน ถ้ามีข้อมูลจริงผูกอยู่กับของตัวอย่างเหล่านี้ migration จะ fail ทันทีแบบ FK violation (ไม่ลบ
-- เงียบ ๆ - ปลอดภัยโดยโครงสร้าง) แต่ควรตรวจล่วงหน้าเพื่อรู้ผลก่อนรันจริงและวางแผนแก้ไขข้อมูลถ้าจำเป็น
--
-- วิธีใช้: รันด้วย mdm_migrator (หรือ role ที่มีสิทธิ์ SELECT บน schema mdm/stg_hr) ก่อน deploy
--   psql "$DATABASE_URL" -f db/preflight/1700000000033_check_sample_org_data.sql
--
-- ผลลัพธ์ที่ต้องการ: ทุกแถวในคอลัมน์ offending_rows ของผลลัพธ์แรก (summary) ต้องเป็น 0 ยกเว้น
-- F_consumer_system_owner_will_be_nulled ซึ่งไม่ block การ migrate (ON DELETE SET NULL) แต่ถ้า > 0
-- ควรรู้ล่วงหน้าว่าจะมี consumer_system ถูกเปลี่ยน owner_org_unit_id เป็น NULL
--
-- ไม่มีการ SELECT employee_no หรือฟิลด์อื่นที่เป็น pid-classified ในสคริปต์นี้ (employee_no = pid เสมอ
-- ตาม 1700000000032_employee_no_is_pid.js) - แสดงเฉพาะ person_id/employment_id/UUID อื่น ๆ ที่ไม่ใช่ pid

WITH sample_org_units AS (
  SELECT org_unit_id, code
  FROM mdm.org_unit
  WHERE code IN ('STRATEGY', 'PERSONNEL', 'PERSONNEL-ADMIN', 'PERSONNEL-ADMIN-REG')
),
sample_positions AS (
  SELECT position_id, position_no
  FROM mdm.position
  WHERE position_no IN ('POS-0001', 'POS-0002', 'POS-0003')
),
target_codes AS (
  SELECT unnest(ARRAY['HQ', 'SP', 'SL', 'KL', 'SC', 'SS', 'YB', 'ED', 'TS', 'PD', 'PS']) AS code
)
SELECT 'A_employment_referencing_sample_position' AS check_name, count(*) AS offending_rows
FROM mdm.employment e
JOIN sample_positions sp ON sp.position_id = e.position_id

UNION ALL

SELECT 'B_employment_referencing_sample_org_unit', count(*)
FROM mdm.employment e
JOIN sample_org_units so ON so.org_unit_id = e.org_unit_id

UNION ALL

-- position อื่น (ไม่ใช่ 3 ตัวอย่างที่ migration ลบเองอยู่แล้ว) ที่ยังผูกกับ org_unit ตัวอย่าง - ถ้ามี
-- จะทำให้ลบ org_unit ตัวอย่างไม่ได้ (FK RESTRICT) แม้ position ตัวอย่างทั้ง 3 จะถูกลบไปแล้วก็ตาม
SELECT 'C_other_position_referencing_sample_org_unit', count(*)
FROM mdm.position p
JOIN sample_org_units so ON so.org_unit_id = p.org_unit_id
WHERE p.position_no NOT IN ('POS-0001', 'POS-0002', 'POS-0003')

UNION ALL

-- org_unit อื่น (นอกเหนือ 4 ตัวอย่างที่ลบพร้อมกัน) ที่มี parent_id ชี้เข้าไปในชุดตัวอย่าง
SELECT 'D_other_org_unit_child_of_sample', count(*)
FROM mdm.org_unit ou
JOIN sample_org_units so ON so.org_unit_id = ou.parent_id
WHERE ou.code NOT IN ('STRATEGY', 'PERSONNEL', 'PERSONNEL-ADMIN', 'PERSONNEL-ADMIN-REG')

UNION ALL

-- stg_hr.raw_row.resolved_org_unit_id/resolved_position_id ไม่ได้ระบุ ON DELETE (default NO ACTION) -
-- ถ้ามี batch เก่าที่ resolve เข้ากับตัวอย่าง T8 ไว้ จะ block การลบเหมือนกัน
SELECT 'E1_stg_hr_raw_row_resolved_to_sample_position', count(*)
FROM stg_hr.raw_row r
JOIN sample_positions sp ON sp.position_id = r.resolved_position_id

UNION ALL

SELECT 'E2_stg_hr_raw_row_resolved_to_sample_org_unit', count(*)
FROM stg_hr.raw_row r
JOIN sample_org_units so ON so.org_unit_id = r.resolved_org_unit_id

UNION ALL

-- mdm.consumer_system.owner_org_unit_id มี ON DELETE SET NULL - ไม่ block การ migrate แต่ถ้า > 0
-- แถวเหล่านี้จะถูกเปลี่ยน owner_org_unit_id เป็น NULL โดยอัตโนมัติ ควรรู้ล่วงหน้า
SELECT 'F_consumer_system_owner_will_be_nulled', count(*)
FROM mdm.consumer_system cs
JOIN sample_org_units so ON so.org_unit_id = cs.owner_org_unit_id

UNION ALL

-- ถ้า code เป้าหมาย (HQ/SP/.../PS) มีอยู่แล้วในตาราง migration จะ fail ด้วย UNIQUE violation ตอน INSERT
-- (ไม่ใช่ FK violation - ไม่ทำให้ข้อมูลเสียหาย แต่ยังคงทำให้ migrate up ล้มเหลว ควรรู้ล่วงหน้าเหมือนกัน)
SELECT 'G_target_codes_already_exist', count(*)
FROM mdm.org_unit
WHERE code IN (SELECT code FROM target_codes)

ORDER BY 1;

-- ถ้าเช็คข้อใดไม่เป็น 0 ให้ไล่ดูรายละเอียดด้วย query ย่อยด้านล่าง (เลือกรันเฉพาะข้อที่ต้องการ)
-- ตัวอย่าง (A) - แสดง person_id/employment_id เท่านั้น ไม่แสดง employee_no (pid-classified):
--
-- SELECT e.employment_id, e.person_id, e.position_id, e.is_current, e.employment_status
-- FROM mdm.employment e
-- JOIN mdm.position p ON p.position_id = e.position_id
-- WHERE p.position_no IN ('POS-0001', 'POS-0002', 'POS-0003');
--
-- ตัวอย่าง (C):
-- SELECT p.position_id, p.position_no, p.title_th, ou.code AS org_unit_code
-- FROM mdm.position p
-- JOIN mdm.org_unit ou ON ou.org_unit_id = p.org_unit_id
-- WHERE ou.code IN ('STRATEGY', 'PERSONNEL', 'PERSONNEL-ADMIN', 'PERSONNEL-ADMIN-REG')
--   AND p.position_no NOT IN ('POS-0001', 'POS-0002', 'POS-0003');
