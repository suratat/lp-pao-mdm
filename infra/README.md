# infra/ — T6: docker-compose staging + Keycloak realm

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `docker-compose.staging.yml` | stack จริงตามภาคผนวก ค: postgres, migrate (one-shot), roles-bootstrap (one-shot), vault (raft), vault-init (one-shot, idempotent), api×2, worker, nginx, portal (T9 self-service), hr-console (T9 รอบ 2 — HR อนุมัติ claim request/ดู reverify list) — ทั้ง portal และ hr-console คุยกับ api ผ่าน service name `nginx` ใน network เดียวกัน ไม่ผ่าน localhost |
| `docker-compose.smoketest.yml` | overlay เพิ่ม Keycloak ชั่วคราว + ตัวรัน smoke test เท่านั้น (ไม่ใช่ topology ของ staging จริง — staging จริงชี้ไปที่ Keycloak `iam.lp-pao.go.th` ที่มีอยู่แล้ว) |
| `keycloak/realm-export.json` | realm `lp-pao` ตามภาคผนวก ก: client scopes (§2.2), audience mapper, clients (`check-broker`, `mdm-worker`, `mdm-portal`, `hr-console`, `eoffice`), realm roles |
| `vault/` | config (raft), policies (per-service + staging-shared), `init.sh` (bootstrap idempotent) |
| `postgres/bootstrap-roles.sql` | สร้าง LOGIN role `mdm_api_svc`/`mdm_worker_svc` ผูกกับ group role ที่ T1 สร้างไว้ |
| `smoke-test.sh` | ขอ token จาก `check-broker` แล้วเรียก `POST /sync/thaid` จริง |

## วิธีรัน (staging จริง)

```bash
cd infra
cp .env.staging.example .env.staging   # แก้ค่า CHANGE_ME ทั้งหมดให้เป็นค่าจริง
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
```

ตรวจสถานะ: `docker compose -f docker-compose.staging.yml ps`, `curl http://localhost:8080/api/v1/health`

`.env.staging` และ `vault/secrets/*` อยู่ใน `.gitignore` แล้ว (ยืนยันก่อนรันครั้งแรกทุกครั้ง — เป็นความลับจริงของ deployment นั้นๆ ไม่ใช่ placeholder)

### ⚠️ การตั้งค่า secret ผ่าน SSH ด้วย `read -s`

เคยเกิดเหตุ (2026-09-17): รันคำสั่งรูปแบบ `echo -n "ใส่ KEYCLOAK_CLIENT_SECRET: "; read -s SECRET` แบบรวมบรรทัดเดียวผ่าน SSH แล้ว `echo -n` หลุดไปต่อท่อเขียนทับ `.env.staging` แทนที่จะพิมพ์ prompt ขึ้นจอ (redirection/pipe ที่ตั้งใจไว้คนละคำสั่งไปโดนคำสั่ง `echo` แทน) ผลคือ `KEYCLOAK_CLIENT_SECRET` ใน `.env.staging` กลายเป็นข้อความ prompt เอง ไม่ใช่ secret จริง ทำให้ Portal error 500 อยู่หลายชั่วโมงกว่าจะเจอสาเหตุ

วิธีที่ปลอดภัยกว่า:

1. **แยกคำสั่งพิมพ์ prompt กับคำสั่งรับ input/เขียนไฟล์ออกเป็นคนละบรรทัดเสมอ** อย่ารวมด้วย `;` หรือ pipe ในบรรทัดเดียวที่มี redirection ปนอยู่

   ```bash
   # ผิด — เสี่ยง echo/redirection หลุดไปโดนไฟล์อื่น
   echo -n "ใส่ secret: "; read -s SECRET; echo "KEYCLOAK_CLIENT_SECRET=$SECRET" >> .env.staging

   # ถูก — แยกทีละบรรทัด ตรวจ SECRET ก่อนเขียนไฟล์
   echo "ใส่ KEYCLOAK_CLIENT_SECRET:"
   read -s SECRET
   echo
   printf 'KEYCLOAK_CLIENT_SECRET=%s\n' "$SECRET" >> .env.staging
   ```

2. **ตรวจไฟล์ด้วย `grep -c` ก่อน-หลังทุกครั้ง** ที่แก้ `.env.staging` แบบ interactive เพื่อจับทั้งกรณีเขียนผิดค่าและกรณีตัวแปรซ้ำบรรทัด (เจอ `.env.staging` มีบางบรรทัด เช่น `CHANGE_ME`/`CHECK_BASE_URL` ถูกเขียนซ้ำ 2 ครั้งด้วยค่าเดียวกัน — ไม่กระทบเพราะ shell/env loader ใช้บรรทัดสุดท้าย แต่ควรระวังไม่ให้สะสม):

   ```bash
   grep -c '^KEYCLOAK_CLIENT_SECRET=' .env.staging   # ต้องเป็น 1 เสมอ ก่อนและหลังแก้
   ```

3. อย่าเชื่อว่า secret ถูกต้องเพียงเพราะ `docker compose up` รันผ่าน — ให้ทดสอบเรียก endpoint ที่ใช้ secret นั้นจริง (เช่น token exchange กับ Keycloak) ก่อนถือว่างานเสร็จ

## วิธีรัน smoke test (พิสูจน์ realm import + client-credentials → /sync/thaid)

```bash
cd infra
docker compose --env-file .env.staging.example \
  -f docker-compose.staging.yml -f docker-compose.smoketest.yml \
  up -d --build
docker compose -f docker-compose.staging.yml -f docker-compose.smoketest.yml \
  run --rm smoke-test
```

รันด้วย `.env.staging.example` ตรงๆ ได้ (ไม่ต้องคัดลอก) เพราะ smoke test ใช้ Postgres/Vault ชั่วคราวในเครื่อง ไม่แตะระบบจริงใดๆ

เก็บกวาด: `docker compose -f docker-compose.staging.yml -f docker-compose.smoketest.yml down -v`

## ผลทดสอบจริง

_ดูสรุปท้ายข้อความของ session ที่รันงานนี้ (T6) — สคริปต์ข้างบนรันจริงแล้วผ่านทั้ง 4 ขั้น: healthcheck, ขอ token จาก check-broker, `GET /health`, `POST /sync/thaid` → `202 UNMATCHED`_

## ข้อจำกัด / สิ่งที่ยังไม่ครอบคลุม

- **Vault token ใช้ร่วมกันระหว่าง api และ worker ใน staging** (`mdm-staging-shared-policy`) — **TODO(production):** ต้องแยก Vault AppRole ต่อ service จริง (`mdm-api-policy.hcl` / `mdm-worker-policy.hcl` มีแยกไว้แล้ว ยังไม่ได้ต่อ AppRole login flow) ไม่ใช่แจก token เดียวที่ทั้งคู่ใช้ร่วมกันตลอดอายุ deployment ตามหลัก least privilege
- การผูก realm role → optional client scope ผ่านแท็บ "Scope" ของ client scope (`audit:read` เฉพาะ `dpo`/`auditor`, `personnel:provision`/`personnel:write:employment`/`personnel:import` เฉพาะ `hr_officer`) **ไม่ได้ใส่ไว้ใน `realm-export.json`** — เสี่ยงเขียน field ผิดจน import ทั้ง realm ล้มเหลว ต้องตั้งด้วยมือใน Keycloak Admin Console หลัง import ครั้งแรก แล้วค่อย export กลับมาทับไฟล์นี้
- Identity Provider `check-lp-pao` (ทางเลือก A ของ §0.3) ยังไม่ใส่ใน realm export เพราะ `check.lp-pao.go.th` ยังไม่มี OIDC facade จนกว่าจะถึง T7
- Vault raft เป็น single-node (ไม่ใช่ multi-node cluster หรือ auto-unseal ผ่าน cloud KMS ตามที่ production ควรพิจารณา) และ unseal key เดียว (`key-shares=1 -key-threshold=1`) — production ที่ต้องการ Shamir ceremony จริงตามภาคผนวก ก ข้อ 7 (break-glass, หลายคนถือคนละ key) ต้องตั้งค่าต่างจากนี้
- Keycloak ใน `docker-compose.smoketest.yml` รันด้วย `start-dev` (เก็บข้อมูลชั่วคราว ไม่ persist) ใช้เฉพาะพิสูจน์ realm import เท่านั้น ไม่ใช่สำหรับใช้งานจริง
- MDM Portal, Netdata/Uptime Kuma monitoring, pg_basebackup/WAL archiving ไป MinIO, Restic, Cloudflare Tunnel/Zero Trust — ยังไม่อยู่ในขอบเขตของ T6 (Portal = T9, monitoring/backup = งานปฏิบัติการที่ต้องตั้งค่าบนเครื่องจริงตามภาคผนวก ค ไม่ได้จำลองใน compose นี้)
- nginx ไม่มี TLS (เครือข่ายภายในของ compose เท่านั้น — TLS/allow-list จริงทำที่ Cloudflare Tunnel + firewall ของ VM ตามภาคผนวก ค ซึ่งอยู่นอก compose นี้)
