#!/bin/sh
# T6: wrapper รัน bootstrap-roles.sql ผ่าน psql (ใช้ image postgres:16 เดิม มี psql ในตัวอยู่แล้ว ไม่ต้อง
# build image แยก) รหัสผ่านมาจาก env ของ compose (Docker secrets / .env.staging ของเครื่องจริง) เท่านั้น
set -eu

psql "$MIGRATOR_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v mdm_api_svc_password="$MDM_API_DB_PASSWORD" \
  -v mdm_worker_svc_password="$MDM_WORKER_DB_PASSWORD" \
  -f /bootstrap-roles.sql
