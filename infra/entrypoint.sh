#!/bin/sh
# T6: entrypoint ร่วมของ api/worker - vault-init.sh สร้าง service token แล้วเขียนไว้ที่
# /vault/secrets/service-token.txt (mount มาจาก infra/vault/secrets/ บน host, read-only) อ่านมาตั้งเป็น
# VAULT_TOKEN ก่อน exec node เพราะ docker compose เองไม่มีกลไกส่ง secret ที่ generate ขึ้นระหว่างรันจาก
# service หนึ่งไปเป็น env ของอีก service หนึ่งโดยตรง (ดู depends_on: vault-init: condition:
# service_completed_successfully ใน docker-compose.staging.yml ที่รับประกันว่าไฟล์นี้มีอยู่ก่อน container
# นี้จะ start)
set -eu

if [ -f /vault/secrets/service-token.txt ]; then
  VAULT_TOKEN="$(cat /vault/secrets/service-token.txt)"
  export VAULT_TOKEN
fi

exec "$@"
