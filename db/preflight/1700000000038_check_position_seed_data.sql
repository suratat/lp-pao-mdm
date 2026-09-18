-- Preflight check ก่อนรัน migration 1700000000038_seed_real_position_batch.js บนฐานข้อมูลจริง
-- (staging/production) - migration นั้นอ่าน migrate/data/position-seed-data.csv (~1,025 ตำแหน่งจริง
-- ของ อบจ.ลำปาง) แล้ว insert เข้า mdm.position โดย lookup org_unit_code -> org_unit_id และ
-- position_type_code -> position_type(code)
--
-- สคริปต์นี้โหลด CSV ตัวจริงเข้า temp table ด้วย \copy แล้วตรวจกับฐานข้อมูลจริงโดยตรง (ไม่ใช้รายการ
-- code ที่ hardcode ไว้ ซึ่งอาจไม่ตรงกับไฟล์ CSV ถ้าไฟล์เปลี่ยนไปในอนาคต) - เป็น read-only ล้วน ๆ
-- ตรวจแบบเดียวกับที่ migration ตรวจเองก่อน insert อยู่แล้ว (migration จะ throw และ rollback ทั้งหมดถ้า
-- เจอปัญหาเหล่านี้ - ไม่ insert ค้างบางส่วน) แต่ควรรันล่วงหน้าเพื่อให้เจ้าของระบบเห็นผลก่อน deploy จริง
-- ตาม convention เดิม (ดู db/preflight/1700000000033_check_sample_org_data.sql)
--
-- วิธีใช้ (รันจาก root ของ repo เพราะ \copy อ่าน path แบบ relative กับ working directory ของ psql
-- ไม่ใช่ตำแหน่งไฟล์ .sql นี้):
--   psql "$DATABASE_URL" -f db/preflight/1700000000038_check_position_seed_data.sql
--
-- ผลลัพธ์ที่ต้องการ:
--   A, B: offending_codes ต้องเป็น 0 (ไม่มี org_unit_code/position_type_code ใน CSV ที่ไม่มีอยู่จริง)
--   C: offending_rows ต้องเป็น 1 พอดี (มีแค่ 52-1-07-3106-003 ที่ซ้ำกับ pilot record เดิมจาก migration
--      1700000000034) ถ้าเป็น 0 แสดงว่า migration 034 ยังไม่ถูก apply มาก่อน (ต้อง apply ก่อนเสมอ) ถ้า
--      มากกว่า 1 แสดงว่ามี position_no อื่นที่ชนกับของเดิมโดยไม่คาดคิด ต้องไล่ดูรายละเอียดก่อน deploy จริง
--      (migration จะ throw เองถ้าเจอกรณีนี้ ไม่ insert ทับเงียบ ๆ)
--   D: offending_rows ต้องเป็น 0 (ไม่มี position_no ซ้ำกันเองภายในไฟล์ CSV)
--
-- ไม่มีการ SELECT employee_no หรือฟิลด์อื่นที่เป็น pid-classified ในสคริปต์นี้ (แตะเฉพาะ
-- mdm.org_unit/mdm.position_type/mdm.position และ temp table ที่โหลดจาก CSV ตำแหน่ง - ไม่มีฟิลด์ใดเป็น pid)

\set ON_ERROR_STOP on

CREATE TEMP TABLE _preflight_position_seed (
  sheet varchar(50),
  position_no varchar(50),
  title_th varchar(255),
  org_unit_code varchar(50),
  position_type_code varchar(30)
);

\copy _preflight_position_seed FROM 'migrate/data/position-seed-data.csv' WITH (FORMAT csv, HEADER true)

SELECT 'A_csv_org_unit_code_not_in_mdm_org_unit' AS check_name, count(DISTINCT s.org_unit_code) AS offending_codes
FROM _preflight_position_seed s
WHERE NOT EXISTS (SELECT 1 FROM mdm.org_unit ou WHERE ou.code = s.org_unit_code)

UNION ALL

SELECT 'B_csv_position_type_code_not_in_mdm_position_type', count(DISTINCT s.position_type_code)
FROM _preflight_position_seed s
WHERE NOT EXISTS (SELECT 1 FROM mdm.position_type pt WHERE pt.code = s.position_type_code)

UNION ALL

SELECT 'C_position_no_already_exists_in_mdm_position', count(*)
FROM _preflight_position_seed s
JOIN mdm.position p ON p.position_no = s.position_no

UNION ALL

SELECT 'D_duplicate_position_no_within_csv_itself', count(*)
FROM (
  SELECT position_no FROM _preflight_position_seed GROUP BY position_no HAVING count(*) > 1
) dup

ORDER BY 1;

-- ถ้า check C ไม่เท่ากับ 1 พอดี ให้ไล่ดูรายละเอียดว่า position_no ไหนบ้างที่ชนกับของเดิม
-- (ถ้ามีแค่ 52-1-07-3106-003 แถวเดียว คือกรณีที่คาดไว้แล้ว ปลอดภัยที่จะรัน migration ต่อ):
--
-- SELECT s.position_no, s.title_th, s.org_unit_code
-- FROM _preflight_position_seed s
-- JOIN mdm.position p ON p.position_no = s.position_no;

DROP TABLE _preflight_position_seed;
