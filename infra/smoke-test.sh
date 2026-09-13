#!/bin/sh
# T6: smoke test เกณฑ์ผ่านของ CLAUDE.md - "realm import ได้; token จาก client check-broker เรียก
# /sync/thaid ผ่าน" รันภายใน docker network เดียวกับ stack (ดู docker-compose.smoketest.yml service
# smoke-test) เพื่อให้ hostname ที่ใช้ขอ token (สำหรับคำนวณ iss) ตรงกับ hostname ที่ API ใช้ตรวจสอบ iss เป๊ะๆ
set -eu

KEYCLOAK_BASE_URL="${KEYCLOAK_BASE_URL:?ต้องตั้ง KEYCLOAK_BASE_URL}"
MDM_API_BASE_URL="${MDM_API_BASE_URL:?ต้องตั้ง MDM_API_BASE_URL}"
CHECK_BROKER_CLIENT_SECRET="${CHECK_BROKER_CLIENT_SECRET:?ต้องตั้ง CHECK_BROKER_CLIENT_SECRET}"

fail() {
  echo "[smoke-test] ล้มเหลว: $1" >&2
  exit 1
}

echo "[smoke-test] 1/4 รอ Keycloak พร้อมออก token (realm lp-pao import สำเร็จ)..."
TOKEN_ENDPOINT="$KEYCLOAK_BASE_URL/realms/lp-pao/protocol/openid-connect/token"
i=0
while true; do
  i=$((i + 1))
  HTTP_CODE=$(curl -s -o /tmp/token_resp.json -w '%{http_code}' \
    -X POST "$TOKEN_ENDPOINT" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=client_credentials' \
    -d 'client_id=check-broker' \
    -d "client_secret=$CHECK_BROKER_CLIENT_SECRET" \
    -d 'scope=sync:thaid') || HTTP_CODE=000
  if [ "$HTTP_CODE" = "200" ]; then break; fi
  if [ "$i" -ge 60 ]; then
    fail "ขอ token จาก $TOKEN_ENDPOINT ไม่สำเร็จภายในเวลาที่กำหนด (HTTP $HTTP_CODE) - realm import อาจล้มเหลว หรือ client check-broker/secret ไม่ตรงกับ realm-export.json"
  fi
  sleep 2
done
echo "[smoke-test] ได้ token จาก client check-broker แล้ว (realm import สำเร็จ)"

ACCESS_TOKEN=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' /tmp/token_resp.json)
[ -n "$ACCESS_TOKEN" ] || fail "parse access_token จาก response ไม่ได้: $(cat /tmp/token_resp.json)"

echo "[smoke-test] 2/4 ตรวจ GET /health (ไม่ต้องมี token)..."
HEALTH_CODE=$(curl -s -o /tmp/health_resp.json -w '%{http_code}' "$MDM_API_BASE_URL/api/v1/health") || HEALTH_CODE=000
[ "$HEALTH_CODE" = "200" ] || fail "GET /health คืน HTTP $HEALTH_CODE: $(cat /tmp/health_resp.json 2>/dev/null || true)"
echo "[smoke-test] /health ตอบ 200"

echo "[smoke-test] 3/4 สร้าง pid ปลอมที่ผ่าน checksum (mod 11) สำหรับทดสอบ..."
# ใช้ pid คงที่ที่ผ่าน checksum จริง (ไม่ใช่เลขบัตรของใคร ตาม CLAUDE.md กฎข้อ 8) - บุคคลนี้ไม่เคยมีอยู่ใน
# staging DB มาก่อนแน่นอน (เพิ่ง migrate schema ว่างใหม่) จึงคาดหวัง branch UNMATCHED (202) เสมอ
FAKE_PID="0161583843492"

echo "[smoke-test] 4/4 POST /sync/thaid ด้วย token ของ check-broker..."
SYNC_CODE=$(curl -s -o /tmp/sync_resp.json -w '%{http_code}' \
  -X POST "$MDM_API_BASE_URL/api/v1/sync/thaid" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"claims\":{\"pid\":\"$FAKE_PID\",\"firstNameTh\":\"ทดสอบ\",\"lastNameTh\":\"สโมคเทสต์\"},\"context\":{\"appId\":\"eoffice\",\"audience\":\"PERSONNEL\"}}") \
  || SYNC_CODE=000

if [ "$SYNC_CODE" != "202" ]; then
  fail "POST /sync/thaid คืน HTTP $SYNC_CODE (คาดหวัง 202 UNMATCHED): $(cat /tmp/sync_resp.json 2>/dev/null || true)"
fi

RESULT=$(sed -n 's/.*"result":"\([^"]*\)".*/\1/p' /tmp/sync_resp.json)
[ "$RESULT" = "UNMATCHED" ] || fail "response.result = '$RESULT' (คาดหวัง UNMATCHED): $(cat /tmp/sync_resp.json)"

echo "[smoke-test] POST /sync/thaid ตอบ 202 UNMATCHED ตามที่คาดไว้ - token RS256 ผ่าน JWKS/iss/aud, scope sync:thaid, Vault pepper (pid_hash) ทำงานถูกต้องทั้งสาย"
echo "[smoke-test] ผ่านทั้งหมด"
