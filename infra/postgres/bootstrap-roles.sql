-- T6: สร้าง LOGIN role จริงสำหรับ mdm-api/mdm-worker ผูกกับ group role NOLOGIN ที่ T1 สร้างไว้
-- (mdm_app, mdm_worker ใน db/migrations/1700000000002_roles.js) - migration เองไม่สร้าง LOGIN role
-- เพราะรหัสผ่านต้องมาจาก env/secret ของ deployment จริงเท่านั้น (CLAUDE.md กฎข้อ 7) ไม่ใช่ค่าที่ commit
-- ลง migration ที่เป็น schema versioned ใช้ pattern เดียวกับที่ api/test/globalSetup.js ทำกับ test role
--
-- รันผ่าน psql -v mdm_api_svc_password='...' -v mdm_worker_svc_password='...' -f bootstrap-roles.sql
-- โดย docker-compose.staging.yml (service roles-bootstrap) ด้วย role mdm_migrator (superuser ของ
-- container postgres นี้ ตั้งจาก POSTGRES_USER/POSTGRES_PASSWORD) - idempotent, รันซ้ำได้ทุกครั้งที่ deploy

-- หมายเหตุ: ใช้ SELECT ... \gexec แทน DO $$ ... $$ เพราะ psql ไม่แทนค่าตัวแปร :'name'
-- ภายใน dollar-quoted block ($$ ... $$) - ต้องอยู่นอก $$ เท่านั้นถึงจะ substitute ได้จริง
SELECT format('ALTER ROLE mdm_api_svc PASSWORD %L', :'mdm_api_svc_password')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_api_svc')
UNION ALL
SELECT format('CREATE ROLE mdm_api_svc LOGIN PASSWORD %L', :'mdm_api_svc_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_api_svc')
\gexec
GRANT mdm_app TO mdm_api_svc;

SELECT format('ALTER ROLE mdm_worker_svc PASSWORD %L', :'mdm_worker_svc_password')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_worker_svc')
UNION ALL
SELECT format('CREATE ROLE mdm_worker_svc LOGIN PASSWORD %L', :'mdm_worker_svc_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdm_worker_svc')
\gexec
GRANT mdm_worker TO mdm_worker_svc;

-- Keycloak persistent storage: database + role แยกจาก mdm (ไม่ปนกับ schema ของ MDM API)
SELECT format('ALTER ROLE keycloak_svc PASSWORD %L', :'keycloak_svc_password')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak_svc')
UNION ALL
SELECT format('CREATE ROLE keycloak_svc LOGIN PASSWORD %L', :'keycloak_svc_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak_svc')
\gexec

SELECT 'CREATE DATABASE keycloak OWNER keycloak_svc'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'keycloak')
\gexec
