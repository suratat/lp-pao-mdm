#!/bin/sh
# T6: bootstrap Vault ให้พร้อมใช้งานสำหรับ docker-compose.staging.yml - รันทุกครั้งที่ compose ขึ้น (idempotent)
# เพราะ raft เก็บข้อมูลถาวรใน volume แต่ Vault process จะ "sealed" ใหม่เสมอหลัง restart (unseal ไม่ persist)
#
# output (unseal keys, root token, pepper รวมอยู่ใน Vault เอง, service token) เขียนลง /vault/secrets ซึ่ง
# mount มาจาก infra/vault/secrets/ บน host - อยู่ใน .gitignore แล้ว (ดู .gitignore บรรทัด "infra/vault/secrets/*")
# ห้าม commit ไฟล์ในไดเรกทอรีนี้เด็ดขาด เป็นความลับจริงของ deployment นี้เท่านั้น
set -eu

apk add --no-cache jq >/dev/null 2>&1

export VAULT_ADDR="http://vault:8200"
SECRETS_DIR="/vault/secrets"
INIT_FILE="$SECRETS_DIR/init.json"
TOKEN_FILE="$SECRETS_DIR/service-token.txt"

echo "[vault-init] รอ Vault ตอบสนอง..."
# exit code ของ `vault status`: 0=unsealed, 2=sealed (แต่ตอบสนองแล้ว - รวมกรณี "ยังไม่เคย init" ด้วย),
# 1=ต่อไม่ติด/error อื่น - ต้อง set +e คร่อมไว้เพราะ non-zero ของคำสั่งนี้ไม่ใช่ความล้มเหลวของสคริปต์เสมอไป
for i in $(seq 1 60); do
  set +e
  vault status >/dev/null 2>&1
  code=$?
  set -e
  if [ "$code" -eq 0 ] || [ "$code" -eq 2 ]; then break; fi
  if [ "$i" -eq 60 ]; then echo "[vault-init] Vault ไม่ตอบสนองภายในเวลาที่กำหนด" >&2; exit 1; fi
  sleep 1
done

# --- 1) init (ครั้งแรกเท่านั้น) ---
# key-shares=1/threshold=1 ตั้งใจให้ unseal ง่ายสำหรับ single-node staging - production ที่ต้องการ
# Shamir ceremony จริง (หลายคนถือคนละ key ตามภาคผนวก ก ข้อ 7 "break-glass") ต้องตั้งค่าต่างจากนี้
if [ ! -f "$INIT_FILE" ]; then
  echo "[vault-init] ยังไม่เคย init - กำลัง operator init (key-shares=1, threshold=1)"
  vault operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"
  chmod 600 "$INIT_FILE"
else
  echo "[vault-init] เคย init แล้ว ใช้ $INIT_FILE เดิม"
fi

UNSEAL_KEY=$(jq -r '.unseal_keys_b64[0]' "$INIT_FILE")
ROOT_TOKEN=$(jq -r '.root_token' "$INIT_FILE")

# --- 2) unseal (ต้องทำทุกครั้งที่ process เริ่มใหม่) ---
if vault status -format=json 2>/dev/null | jq -e '.sealed == true' >/dev/null 2>&1; then
  echo "[vault-init] Vault sealed อยู่ - unseal"
  vault operator unseal "$UNSEAL_KEY" >/dev/null
else
  echo "[vault-init] Vault unsealed อยู่แล้ว"
fi

export VAULT_TOKEN="$ROOT_TOKEN"

# --- 3) KV v2 สำหรับ pepper (secret/mdm/pid-pepper ตามภาคผนวก ข) ---
if ! vault secrets list -format=json | jq -e 'has("secret/")' >/dev/null 2>&1; then
  echo "[vault-init] เปิด KV v2 ที่ secret/"
  vault secrets enable -path=secret kv-v2
fi

# ห้าม regenerate pepper ถ้ามีอยู่แล้ว - pid_hash ทุกแถวใน Postgres คำนวณจาก pepper ตัวนี้ เปลี่ยนแล้ว
# ค้นหา/ตรวจสอบ pid เดิมทั้งหมดจะพังทันที (ดู README.md หัวข้อ "ข้อจำกัด")
if ! vault kv get -format=json secret/mdm/pid-pepper >/dev/null 2>&1; then
  echo "[vault-init] ยังไม่มี pepper - สร้างใหม่ (32 ไบต์สุ่ม)"
  PEPPER_B64=$(head -c 32 /dev/urandom | base64)
  vault kv put secret/mdm/pid-pepper pepper="$PEPPER_B64" >/dev/null
else
  echo "[vault-init] มี pepper อยู่แล้ว ไม่แตะ"
fi

# --- 4) Transit (mdm-pid, mdm-photo, mdm-webhook-secret ตามภาคผนวก ข + T5) ---
if ! vault secrets list -format=json | jq -e 'has("transit/")' >/dev/null 2>&1; then
  echo "[vault-init] เปิด Transit secrets engine"
  vault secrets enable transit
fi

for key in mdm-pid mdm-photo mdm-webhook-secret; do
  if ! vault read -format=json "transit/keys/$key" >/dev/null 2>&1; then
    echo "[vault-init] สร้าง transit key: $key"
    vault write -f "transit/keys/$key" type=aes256-gcm96 >/dev/null
  fi
done

# --- 5) policies ---
echo "[vault-init] เขียน policy (api/worker แยกไว้สำหรับ production, shared ใช้เฉพาะ staging)"
vault policy write mdm-api-policy /vault/policies/mdm-api-policy.hcl >/dev/null
vault policy write mdm-worker-policy /vault/policies/mdm-worker-policy.hcl >/dev/null
vault policy write mdm-staging-shared-policy /vault/policies/mdm-staging-shared-policy.hcl >/dev/null

# --- 6) service token สำหรับ api/worker (staging: token เดียวร่วมกัน) ---
# TODO(production): ห้ามใช้ token เดียวร่วมกันแบบนี้ - ต้องสร้าง AppRole แยกต่อ service (บทบาทละ
# mdm-api-policy / mdm-worker-policy คนละ role_id/secret_id) แล้วให้แต่ละ service login เอาโทเคนอายุสั้น
# ของตัวเอง (เช่นผ่าน Vault Agent) แทนการแจก token เดียวที่ทั้งคู่ใช้ร่วมกันตลอดอายุ deployment
if [ ! -f "$TOKEN_FILE" ] || ! vault token lookup "$(cat "$TOKEN_FILE")" >/dev/null 2>&1; then
  echo "[vault-init] สร้าง service token ใหม่ (staging shared policy, periodic 768h)"
  vault token create \
    -policy=mdm-staging-shared-policy \
    -orphan \
    -period=768h \
    -field=token > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
else
  echo "[vault-init] service token เดิมยังใช้ได้ ไม่สร้างใหม่"
fi

echo "[vault-init] เสร็จสิ้น"
