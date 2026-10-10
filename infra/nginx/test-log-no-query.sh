#!/bin/sh
# ทดสอบ: nginx.conf ต้องไม่ log query string ทั้งใน access log (ปกติ) และ error log (upstream ล่ม)
# ใช้ nginx.conf จริง + stub upstream (nginx อีกตัวที่ alias เป็น api1/api2 บน :3000) ใน docker network ชั่วคราว
# ไม่แตะ stack จริง รัน: sh infra/nginx/test-log-no-query.sh  (ต้องมี docker + curl)
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
SUFFIX=$$
NET="nginxlogtest-$SUFFIX"
STUB="nginxlogtest-stub-$SUFFIX"
PROXY="nginxlogtest-proxy-$SUFFIX"
SENTINEL="ZZSENTINELNAME$SUFFIX"
TMP=$(mktemp -d)

cleanup() {
  docker rm -f "$STUB" "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[nginx-log-test] ล้มเหลว: $1" >&2; exit 1; }

cat > "$TMP/stub.conf" <<'CONF'
events {}
http { server { listen 3000; location / { return 200 "ok"; } } }
CONF

docker network create "$NET" >/dev/null
docker run -d --name "$STUB" --network "$NET" --network-alias api1 --network-alias api2 \
  -v "$TMP/stub.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine >/dev/null
docker run -d --name "$PROXY" --network "$NET" -p 127.0.0.1::80 \
  -v "$DIR/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine >/dev/null

PORT=$(docker port "$PROXY" 80/tcp | head -n1 | sed 's/.*://')
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/health" || true)" = "200" ]; do
  i=$((i + 1)); [ "$i" -lt 30 ] || fail "proxy ไม่พร้อม: $(docker logs "$PROXY" 2>&1 | tail -5)"
  sleep 1
done

echo "[nginx-log-test] 1/3 คำขอปกติที่มี query"
curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/persons?q=$SENTINEL&limit=5"
sleep 1
LOGS=$(docker logs "$PROXY" 2>&1)
echo "$LOGS" | grep -q "/api/v1/persons" || fail "ไม่พบ path ใน access log"
echo "$LOGS" | grep "/api/v1/persons" | grep -Eq ' 200 [0-9]+ rt=[0-9.]+ urt=[0-9.]+ us=200 ' || fail "access log ขาด status/rt/urt/us"
echo "$LOGS" | grep -q "$SENTINEL" && fail "พบ query ใน access log"
echo "$LOGS" | grep -q '?' && fail "พบ '?' ใน access log"

echo "[nginx-log-test] 2/3 หยุด upstream แล้วยิงคำขอที่มี query (ต้องได้ 502/503 และ error log ไม่มี query)"
docker stop "$STUB" >/dev/null
sleep 12 # ให้ resolver (valid=10s) เห็นว่า api1/api2 หายไป
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/persons?q=$SENTINEL&second=1") || CODE=000
case "$CODE" in 502|503|504) ;; *) fail "คาดหวัง 5xx เมื่อ upstream ล่ม แต่ได้ $CODE" ;; esac
sleep 1
LOGS=$(docker logs "$PROXY" 2>&1)
echo "$LOGS" | grep -q "$SENTINEL" && fail "พบ query ใน log หลัง upstream ล่ม (access/error)"
echo "$LOGS" | grep "/api/v1/persons" | grep -q " $CODE " || fail "access log ไม่บันทึก status $CODE ของคำขอที่ upstream ล่ม"

echo "[nginx-log-test] 3/3 ผ่าน: ไม่พบ query ใน access/error log"
