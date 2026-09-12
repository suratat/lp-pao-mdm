# CLAUDE.md — ระบบฐานข้อมูลข้าราชการและพนักงานกลาง (Central Personnel MDM) อบจ.ลำปาง

ไฟล์นี้คือบริบทสำหรับ Claude (Sonnet) ที่ทำงานต่อจากเอกสารออกแบบ อ่านให้ครบก่อนเริ่มทุกงาน

## 1. อ่านก่อนเริ่ม (ตามลำดับ)

1. `docs/design/personnel-mdm-design.md` — หัวข้อ 0 (สถาปัตยกรรม, หลักการ, ข้อ 0.5 สิ่งที่ต้องเพิ่มใน check.lp-pao.go.th) และหัวข้อที่เกี่ยวกับงานที่ได้รับ
2. `docs/design/personnel-mdm-openapi.yaml` — **สัญญาของ API ห้ามเปลี่ยนโดยไม่แจ้ง** ถ้าจำเป็นต้องเปลี่ยน ให้แก้ไฟล์ YAML พร้อมระบุเหตุผลใน PR และรัน validator ใหม่
3. `docs/design/er-01-personnel-core.mermaid`, `er-02-governance-integration.mermaid` — โครงสร้างตาราง
4. `docs/design/seq-01-thaid-login-sync.mermaid`, `seq-02-periodic-reverify.mermaid` — ลำดับการทำงานที่ต้อง implement ให้ตรง

## 2. บริบทที่ต้องรู้

- MDM **ไม่ติดต่อ ThaID/DOPA** การยืนยันตัวตนทำผ่าน `thaid.lp-pao.go.th` (ThaID OAuth broker) → `check.lp-pao.go.th` (SSO broker ของ อบจ. มี app registry + allowed_claims) ทั้งสองมีอยู่แล้ว รันด้วย pm2 บน VM `sso-server` (192.168.0.7, NT Cloud) หลัง Cloudflare Tunnel
- จุดเชื่อมเดียวของ MDM กับการ login คือ `check.lp-pao.go.th` เรียก `POST /api/v1/sync/thaid` (server-to-server, private network) หลังได้ profile จาก `thaid /api/verify` และก่อนออก token ให้ app
- Keycloak (realm `lp-pao`) เป็นผู้ออก access token สำหรับเรียก MDM API (client credentials, client scope = กลุ่มฟิลด์) ไม่ได้อยู่ในเส้นทาง login ของผู้ใช้
- ระบบปลายทางอ้างอิงบุคลากรด้วย `person_id` (UUID) เท่านั้น เลขบัตรประชาชน (pid) อยู่ใน MDM ในรูป `pid_hash` (HMAC-SHA256 + pepper) และ `pid_enc` (Vault Transit) เท่านั้น
- Stack ที่ตัดสินใจแล้ว: Node.js 22 + Express, PostgreSQL 16, `jose` (JWT/JWKS), `pg-boss` (คิว/scheduler บน PostgreSQL), HashiCorp Vault Transit, Docker Compose, ทดสอบด้วย Vitest หรือ Jest + Testcontainers/Docker PostgreSQL

## 3. กฎที่ห้ามละเมิด (hard rules)

1. **ห้าม pid ปรากฏใน log, error message, URL/query string, response ทั่วไป, test fixture ที่ commit, หรือในแชต** ใช้ `person_id` หรือ `pid_hash` แทนเสมอ; logger ต้องมี redaction ตัวเลข 13 หลัก
2. ข้อมูลในตาราง `person_identity` และ `person_photo` เขียนได้จาก `POST /sync/thaid` เท่านั้น ห้ามมี endpoint หรือ path อื่นแก้ไข
3. การเปลี่ยนข้อมูลบุคคลทุกครั้งต้องอยู่ใน transaction เดียวกับ `data_change_log` และ `outbox_event` (ดู seq-01) ห้ามส่ง webhook โดยตรงจาก request handler
4. ตาราง schema `audit` เป็น append-only ห้ามมีโค้ด UPDATE/DELETE
5. Response ตัดฟิลด์ที่ไม่มี scope ออก (ไม่ใส่ `null`) ตาม `field_policy`
6. ทุก endpoint ที่คืนข้อมูลส่วนบุคคลต้องเขียน `access_log` พร้อม `fields_returned` ที่ส่งจริง
7. Secrets (pepper, Vault token, client secret, Redis password) มาจาก env/Docker secrets เท่านั้น ห้าม hardcode, ห้ามใส่ใน `.env.example` เป็นค่าจริง, ห้ามพิมพ์ออกมาใน log
8. ข้อมูลทดสอบต้องเป็นข้อมูลสมมติ: สร้าง pid ปลอมที่ผ่าน checksum ด้วย helper `makeFakePid()` ห้ามใช้เลขบัตรจริงของใคร
9. ไม่แก้ `thaid.lp-pao.go.th` เว้นแต่ระบุในงานอย่างชัดเจน; งานฝั่ง `check.lp-pao.go.th` ทำในรีโปของ check ตามข้อ 0.5 ของเอกสารออกแบบ และตาม convention เดิม (`deploy.sh`/`rollback.sh`, `ecosystem.config.js`, รันเป็น user `sso`)
10. ถ้าข้อมูลในเอกสารขัดแย้งกัน หรือต้องเดา ให้หยุดและถามก่อน ไม่คิดเองแล้วทำต่อ

## 4. โครงรีโป

```
lp-pao-mdm/
  docs/design/            ← ไฟล์ออกแบบทั้ง 7 ไฟล์ (อ่านอย่างเดียว)
  api/                    ← MDM API (Express)
    src/security/         pid.js (checksum, hmac, snapshotHash), jwt.js (jose + JWKS), fieldMask.js
    src/routes/           ตาม tag ใน OpenAPI: persons, me, provisioning, employment, sync, events, webhooks, reference, audit, system
    src/services/         personService, syncService (change detection), employmentService, consentService
    src/db/               pool, transaction helper, repositories
    src/middleware/       auth (scope), accessLog, problemJson, idempotency, rateLimit
    test/
  worker/                 ← outbox dispatcher, webhook sender, reverify jobs, hr import, keycloak sync (pg-boss)
  db/migrations/          ← SQL migrations (node-pg-migrate หรือ dbmate) เรียงเลข
  infra/                  ← docker-compose.staging.yml, keycloak/realm-export.json, vault/policies, nginx
  portal/                 ← (ระยะหลัง) self-service / HR / DPO console
```

## 5. งานตามลำดับ (ทำทีละงาน, หนึ่ง branch ต่อหนึ่งงาน, จบด้วยเกณฑ์ผ่าน)

| # | งาน | อ้างอิงในเอกสาร | เกณฑ์ผ่าน |
|---|---|---|---|
| T1 | SQL migrations ทั้ง 3 schema + constraints + seed `field_policy`, `processing_purpose`, `org_unit`/`position` ตัวอย่าง | §1.4–1.6, ER 1/2, 2/2 | migrate ขึ้น/ลงได้บน PostgreSQL 16 เปล่า; มี test ยืนยัน UNIQUE pid_hash, partial unique employee_no, EXCLUDE ตำแหน่งซ้อน, audit append-only trigger |
| T2 | API skeleton: โหลด OpenAPI ด้วย `express-openapi-validator`, JWT/JWKS (`jose`, RS256 เท่านั้น, ตรวจ iss/aud), scope→field mask จาก `field_policy`, problem+json, access_log middleware, `/health` | §2.2, §2.4 | contract test ทุก path ใน YAML ตอบตาม schema; test ปฏิเสธ token ที่ alg/aud/iss ผิด; response ไม่มีฟิลด์นอก scope |
| T3 | `security/pid.js` (checksum, HMAC, Vault Transit client + in-memory fake สำหรับ test) และ `POST /sync/thaid` ครบ 5 branch พร้อม change detection ตาม §3.3 | §3.1, §3.3, §3.4, ภาคผนวก ข | unit test ครอบคลุม UNMATCHED / CLAIMED / NO_CHANGE / UPDATED / REJECTED_INACTIVE; ฟิลด์ที่ไม่ได้ส่งมาไม่ถูกเขียนทับ; `claim_request` เกิดเฉพาะ audience=PERSONNEL; ทุก branch เขียน sync_event + change_log + outbox ใน transaction เดียว |
| T4 | Worker: outbox dispatcher (FOR UPDATE SKIP LOCKED), webhook signer + retry backoff + DEAD, `GET /events` feed, reverify-scan / reverify-escalate, HR employment-batch import (DRY_RUN/APPLY) | §2.3, seq-02, §5.3 | integration test ด้วย mock receiver: ลายเซ็นตรวจผ่าน, retry ตาม schedule, idempotent; job re-verify เปลี่ยนสถานะถูกต้อง |
| T5 | Persons/Employment/Provisioning/Me/Consents/Webhooks/Audit endpoints ที่เหลือ รวม deactivate → revoke flow | §2.1, §3.4 | contract test ครบ; deactivate สร้าง PERSON_DEACTIVATED และ worker เรียก revoke ทั้ง check + Keycloak (mock) |
| T6 | `infra/`: docker-compose staging (api×2, worker, postgres, vault dev/raft, nginx), Keycloak realm export ตามภาคผนวก ก | ภาคผนวก ก, ค | `docker compose up` แล้วผ่าน smoke test; realm import ได้; token จาก client `check-broker` เรียก `/sync/thaid` ผ่าน |
| T7 | (รีโป check.lp-pao.go.th) hook ตามข้อ 0.5: audience ใน app registry, เรียก sync พร้อม `MDM_SYNC_MODE=off/shadow/enforce`, Redis cache fallback, `person_id` ใน session และ `/api/verify`, `POST /internal/sessions/revoke` | §0.5, seq-01, seq-02 | shadow mode ทำงานกับ MDM staging โดย login เดิมไม่เปลี่ยน; enforce ปฏิเสธ UNMATCHED เฉพาะ app PERSONNEL; `conformance.sh` เพิ่มเคสใหม่และผ่าน |
| T8 | เครื่องมือ migrate: schema `stg_hr`, กฎคุณภาพ, runner สำหรับ import DRY_RUN → รายงาน → APPLY | §5.3–5.4 | รายงาน reconciliation ตรงกับไฟล์ต้นทาง; ไม่มี plaintext pid เหลือใน stg_hr เกิน 30 วัน (job ลบ) |
| T9 | Portal (self-service → HR console → DPO console) | §2.1 Me, §3.4 | ทีหลัง หลัง T1–T7 เสถียร |

## 6. วิธีทำงานที่คาดหวัง

- เริ่มทุกงานด้วยการสรุปสั้น ๆ ว่าจะทำอะไร แตะไฟล์ไหน แล้วค่อยลงมือ; เมื่อจบให้สรุปสิ่งที่ทำ, วิธีทดสอบ, และสิ่งที่ยังไม่ครอบคลุม
- เขียน test ก่อนหรือพร้อมโค้ด; `npm test` ต้องผ่านก่อน commit; รัน `npm run validate:openapi` เมื่อแตะ YAML
- Commit message ภาษาอังกฤษสั้น ๆ อ้าง T-number เช่น `T3: implement /sync/thaid change detection`
- โค้ด comment/ข้อความ error ที่ผู้ใช้เห็นเป็นภาษาไทย, ชื่อตัวแปร/ฟังก์ชันภาษาอังกฤษ
- ไม่ติดตั้ง dependency ใหม่นอกรายการในข้อ 2 โดยไม่บอกเหตุผล
- ห้าม deploy ขึ้น production เอง งานที่แตะเครื่องจริงให้เตรียมคำสั่ง/ไฟล์ แล้วให้เจ้าของระบบรันผ่าน `deploy.sh` ใน staging ก่อนเสมอ
