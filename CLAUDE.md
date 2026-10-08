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

## Multi-Session Workflow

Rules to keep parallel Claude Code sessions / chats in sync via git as the single source of truth.

### Before starting ANY task, run:
```bash
git fetch --all && git status && git log --oneline -10 --all --graph
```

### Rules
1. One task = one branch = one active session. Never run two sessions on the same branch at the same time.
2. Update the "Status Log" below the moment a task changes state (started / blocked / PR open / merged) — not just in chat.
3. When resuming work in a new session, state which branch/PR/task you're continuing, don't assume the session remembers.
4. Before opening a new branch, confirm main is up to date: `git checkout main && git pull`

### หมายเหตุ Deploy
- build/รัน `migrate-cli` บน VPN-MDM ต้องใช้ `docker compose --env-file infra/.env.staging -f infra/docker-compose.staging.yml --profile tools <build|run> migrate-cli` เสมอ (ไม่ใส่ `--env-file` ตัวแปรจะว่างและ build ล้มด้วย "no port specified") **ห้ามใส่ `--remove-orphans`** เด็ดขาด เพราะจะลบ `infra-keycloak-1` ทิ้งไปด้วย (อยู่คนละ compose file)

### เงื่อนไขก่อนขึ้นระบบจริง (pre-production checklist)
1. แยกบทบาท: ตอนนี้บัญชีผู้พัฒนา/ผู้ดูแล (suratat) ถือ hr_officer + hr_master_data_admin + auditor ชั่วคราวระหว่างตั้งระบบและทดสอบ ก่อนขึ้นระบบจริงต้องย้าย auditor (และ dpo ถ้ามี) ไปให้ผู้อื่นที่เป็นอิสระจากผู้แก้ข้อมูล เพื่อให้การตรวจสอบเป็นอิสระ (ตัดสินใจโดยเจ้าของระบบ 2026-10-03 ว่าพร้อมแล้วจะเปลี่ยน)
2. role mdm_admin (break-glass): สร้างบัญชี local แยก 1-2 บัญชีพร้อม OTP ตามภาคผนวก ก ข้อ 7 ไม่ผูกกับบัญชีส่วนตัว เอกสารไม่ได้กำหนดที่เก็บรหัสผ่านและผู้ตรวจ log ต้องกำหนดก่อนขึ้นระบบจริง
3. หมุนค่าลับทั้งหมดที่เคยอยู่ใน ~/.bash_history ของ VPN-MDM (รหัสผ่านฐานข้อมูล, client secret ของ hr-console/dpo-console/portal/check-broker/keycloak admin, session secret, shared secret, App Password ของอีเมลแจ้งเตือน, secret ของ client migrate-tool) แล้วล้างประวัติ และตรวจสำเนาสำรองที่อาจมีไฟล์ประวัติ
4. client migrate-tool: ปิด Service accounts หรือหมุน secret หลังนำเข้าเสร็จ และถ้าต้องใช้นำเข้าอีก ให้สร้าง client แคบเฉพาะ personnel:import
5. stg_hr ยังเก็บชื่อ เบอร์โทร อีเมลส่วนตัว quality_errors ของ 786 แถว รอ DPO ตัดสินระยะเก็บ (pid_plaintext และ source_data ล้างอัตโนมัติหลัง 30 วัน: batch 782fb229 ล้างวันที่ 2026-11-01 (โหลด 2026-10-02 + 30 วัน), batch ทดสอบ b8cf1d3c ล้างหลัง 2026-10-31)
6. ลำดับ 126, 221, 515 (เลขบัตรไม่ผ่าน checksum) แจ้งฝ่ายบุคคลแล้ว รอไฟล์แก้ไข แล้วนำเข้าเป็น batch ใหม่
7. ข้อสังเกตจากการอ่านโค้ด (ยังไม่แก้): PROVISION ใน HR Console ไม่ตรวจ pid_hash ซ้ำกับ person ที่นำเข้า และไม่ตรวจว่า employeeNo ตรงกับ pid_hash ของคำขอ ไม่มี endpoint ยกเลิกการอนุมัติ ปุ่มอนุมัติใช้กับ 782 คนที่นำเข้าไม่ได้ (ให้แต่ละคนล็อกอิน ThaID แทน)

### Status Log
- [2026-10-08] Fix on branch feat/hr-person-manage-api (found by CI of PR #81, bug introduced by PR-D1 #79 and ALREADY DEPLOYED: real HR imports could fail at random): migrate-cli sent the batch reason `HR_IMPORT batch <full batch UUID>`; a UUID such as 12345678-1234-4567-... reads as a 13-digit number (digits separated by single dashes are counted by containsPidLike), so POST /sync/hr/employment-batch answered 422 reason-contains-pid for roughly 1 in 10 random batch ids (20,000 deterministic ids: hundreds collide). The API check on human-typed reasons is unchanged. FIX: migrate/src/import/importReason.js builds `HR_IMPORT batch <first 8 hex chars of the batch id>` - at most 8 consecutive digits and no separators, so it can never reach 13 digits (and throws before calling the API if it ever did). Trace a log row back with `SELECT batch_id FROM stg_hr.import_batch WHERE batch_id::text LIKE '<8 chars>%'`; the full id is still in stg_hr and in the CLI/report output. Other system-built reasons checked: only the emergency-contact `ผู้ติดต่อฉุกเฉินลำดับที่ <1-3>` (single digit after Thai letters) and the `<user reason> (อ้างอิง: <doc>)` / `<user reason> (ผู้ติดต่อฉุกเฉิน...)` compositions (parts are validated separately and the joiners are letters/parentheses, so digits of the two parts can never be adjacent) - no other collision path. Also removed a random-UUID reason from api/test/hrWriteContract.test.js that could fail the same way. DEPLOY: rebuild the migrate-cli image only (no migration, API unchanged); until then retrying the import with a new batch id (re-load) is the workaround.
- [2026-10-08] Branch feat/hr-person-manage-api (PR-D2 of 4 for "HR manages persons in hr-console", API only; committed locally, not pushed, PR not opened; D1 = #79, portal fix = #80). Migration 1700000000051: mdm.person.expected_birth_date + field_policy rows (birth date CONFIDENTIAL, names INTERNAL, required_scope personnel:manage:person) + trigger person_expected_identity_guard (SQLSTATE MD001) that blocks changing expected_* when OLD.thaid_verified_at/claimed_at is set or OLD.status <> PENDING_CLAIM (fires only when a value actually changes). person_identity is NOT touched (hard rule 2); ThaID always wins at claim, HR values are kept untouched (no mismatch warning). NEW ENDPOINTS (scope personnel:manage:person AND realm role hr_master_data_admin, all reads/writes go to access_log via the middleware; every write needs expectedVersion (409 version-conflict), reason (reason.js), writes data_change_log via changeLogWriter with actor_sub/actor_client, no outbox for PENDING_CLAIM): GET /persons/{id}/manage-profile, PATCH /persons/{id}/expected-identity (names + birthDate; 409 identity-locked for anyone who ever verified - checked in the same transaction as `SELECT ... FOR UPDATE`, identity-locked is reported before version-conflict; race with /sync/thaid tested in both lock orders), PATCH /persons/{id}/contact (partial; null/blank clears), PUT /persons/{id}/emergency-contacts (changed field+slot only, no values, shared core with the portal path in meService.applyEmergencyContacts), GET /persons/{id}/history (newest first, CONFIDENTIAL+ values hidden). POST /persons accepts expectedBirthDate and now logs the expected_* values. hr_officer WITHOUT hr_master_data_admin no longer sees contact/emergencyContacts in GET /persons/{id} even when the token has personnel:read:contact (effectiveScopes in middleware/accessLog.js); consumers without the hr_officer role are unchanged. maxLength on every new request field and on EmergencyContact / expected names in POST /persons (long values used to be HTTP 500); PUT /me/emergency-contacts with duplicate priority is now 422 (was 500). OpenAPI + realm-export.json (client scope personnel:manage:person, Default on hr-console) + infra/keycloak/README.md updated. KEYCLOAK MANUAL STEPS on the live realm: create client scope personnel:manage:person (Include in token scope), add it as Default to hr-console, users need hr_officer + hr_master_data_admin, re-login. DEPLOY: migrate (051) + rebuild/restart api1/api2. hr-console UI = PR-D3/D4 (not started).
- [2026-10-08] Branch fix/emergency-contacts-portal-payload (committed locally, not pushed, PR not opened): prod bug after PR-D1 "portal says saved but emergency contacts do not change" (nginx: PUT /me/emergency-contacts 200 with a 2-byte body, GET /me size unchanged, no data_change_log rows). ROOT CAUSE is in portal/, not in the API or in PR-D1: the form handler silently dropped every row that did not have all of fullName+relationship+phone, so a user who filled name+phone but left relationship empty made the portal send `[]` -> API (correctly) replaced the list with nothing -> 200 `[]` -> portal redirected to /portal/me, which shows no message and no emergency contacts, so it looked like success (reproduced with the real portal form + real API: portal PUT body "[]", API 200 "[]"). If the person had existing contacts the same input would have deleted them. API `replaceMyEmergencyContacts` diff/no-op logic checked: compares the rows loaded before DELETE with the incoming ones, so it is not the cause. FIX (portal only, no API/contract change): a partially filled row rejects the whole form (422, typed values kept, message names the missing fields); values are trimmed and length-checked against the DB columns (name 200 / relationship 50 / phone 20; longer used to be an HTTP 500 because the API schema has no maxLength - not changed here); success redirects 303 to /portal/me/emergency-contacts?saved=<n> with n taken from the API response (not from what was sent) and the page shows "บันทึกแล้ว n คน"; the edit page now shows contacts by slot (priority). Deploy: rebuild portal only.
- [2026-10-06] Branch feat/hr-person-write-hardening (PR-D1 of 4 for "HR manages persons in hr-console"; committed locally, not pushed, PR not opened; D2 = new endpoints + expected_* columns, D3/D4 = hr-console UI). CONTRACT CHANGES: POST /persons, PUT /persons/{id}/employment, POST .../deactivate, POST .../reactivate now need realm role hr_master_data_admin (API-checked, in addition to scope) and a mandatory `reason` (no 13-digit number -> 422 reason-contains-pid, blank -> 422, >500 -> 400; stored in data_change_log.reason, referenceDocument appended; deactivate reason also -> employment.separation_reason); PUT employment/reactivate body is the new schema EmploymentChangeRequest (EmploymentUpsert + reason), POST /persons has `reason`; deactivate gets optional expectedVersion (409 version-conflict); POST /sync/hr/employment-batch needs batch-level `reason` (migrate-cli sends "HR_IMPORT batch <batchId>" automatically, stored on every HR_IMPORT log row). NOT changed: POST /claim-requests/{id}/resolve (hr-console claim approval) and the batch import client need no role. Caller audit: in this repo only tests call the 4 endpoints; migrate-cli calls only /sync/hr/employment-batch (client migrate-tool); the client name `mdm-hr-tool` does not appear anywhere in the repo (if it exists on the live realm and calls them it now gets 403: give its service account the realm role). FIXES: replaceMyEmergencyContacts (portal) now writes data_change_log per changed field+slot WITHOUT values (field_policy emergency_contact.* log_values_in_audit=false, migration 1700000000049), outbox CONTACT_UPDATED and version+1 in one transaction (it had none of the three; unchanged list = no write); PUT employment no longer hard-codes status ACTIVE in the outbox payload and sends no event for PENDING_CLAIM persons (like provision); employment.separation_reason widened to varchar(500) (migration 1700000000050: a 256-500 char deactivate reason returned 500). No Keycloak step is required for existing flows (see infra/keycloak/README.md "PR-D1"). DEPLOY: migrate (049, 050) + rebuild api1/api2 + migrate-cli image
- [2026-10-05] Branch feat/dpo-access-anomaly-alerts (PR-C of 3 for DPO: access anomaly alerts; committed locally, not pushed, PR not opened; PR-A #76 and PR-B #77 merged): migration 1700000000048 audit.access_alert + audit.access_alert_action (both append-only; status OPEN/ACK/CLOSED derived from the latest action; dedupe_key UNIQUE; CLOSE needs a note) + index access_log (keycloak_client_id, accessed_at) (deviation from the plan's (actor_sub, accessed_at): the rules filter by client list + time, not by actor). Worker job access-anomaly-scan (pg-boss, every 5 min; rules BULK_VIEW / OFF_HOURS / PID_REVEAL_FREQUENT; skips searchPersons rows; only clients in ANOMALY_MONITORED_CLIENTS; every query has an accessed_at window predicate and partition pruning is tested; off-hours = outside Mon-Fri [08:30,16:30) Asia/Bangkok, weekends all day, no public holidays yet); env validated at boot (bad value or only one of the two Telegram vars -> worker exits 1). API: GET /audit/alerts (audit:read), POST /audit/alerts/{id}/ack|close (audit:review AND role dpo; closing needs a note, no pid in note, you cannot ack/close an alert about your own account, 409 when already closed/acknowledged, advisory lock per alert). dpo-console /dpo/alerts (CSRF). Telegram opt-in (DPO_TELEGRAM_BOT_TOKEN + DPO_TELEGRAM_CHAT_ID, optional DPO_CONSOLE_BASE_URL), sent only for newly created alerts (ON CONFLICT DO NOTHING RETURNING), at-most-once, message has rule/count/window/actor sub/client only. OpenAPI changed (additive). DEPLOY on VPN-MDM: add the ANOMALY_* / DPO_TELEGRAM_* / DPO_CONSOLE_BASE_URL lines to infra/.env.staging (all optional: compose has defaults, Telegram off if unset), migrate (048; CREATE INDEX on the partitioned access_log needs the owner role and takes a short lock; the partitions created by hand on VPN-MDM get the child index too), rebuild/restart worker + api1/api2 + dpo-console. Also this branch: fixed flaky hr-console/dpo-console refresh tests (cause: mock minted 1-second JWTs, and the 8-concurrent test depended on timing) - separate commit
- [2026-10-04] Branch feat/dpo-pid-access-review (PR-B of 3 for DPO: review of national-ID reveals; committed locally, not pushed, PR not opened; PR-A = #76 merged): migration 1700000000047 audit.pid_access_review (append-only trigger + REVOKE UPDATE/DELETE; refs (access_id, accessed_at) with NO foreign key so old access_log partitions can still be dropped; PENDING = no row, derived with LEFT JOIN LATERAL). API: GET /audit/access-logs adds accessId, reviewStatus/reviewedAt/reviewerSub/reviewNote + filter reviewStatus (reveals only; matches endpoint ~ /persons/<uuid>/pid, also legacy rows with ?justification=); POST /audit/access-logs/{accessId}/review (scope audit:review AND realm role dpo, checked in API because Keycloak cannot give a scope by role; self-review -> 403; accessedAt matched at ms precision, stored value is the row's real microseconds). justification containing a 13-digit number -> 422 on GET /pid and POST /persons/lookup (before any decrypt/access_log write); review note too. problem+json `instance` no longer includes the query string (it echoed the justification, so a typed national ID leaked in a 4xx body). dpo-console: /dpo/pid-reveals + review form, CSRF (copied from hr-console), access-log page shows accessId/justification/review status, /dpo/change-logs hint text fixed. OpenAPI changed (additive + 422). KEYCLOAK MANUAL STEPS on the live realm (see infra/keycloak/README.md): create client scope audit:review (include in token scope), add it as Default to client dpo-console; make sure the reviewing user has role dpo. DEPLOY: migrate (047) + rebuild/restart api1/api2 + dpo-console. Reviewer must be a different account from the person who revealed the ID (the developer account currently holds several roles). Next: PR-C
- [2026-10-04] Branch feat/dpo-change-log-actor (PR-A of 3 for DPO: change log; committed locally, not pushed, PR not opened): (1) every write to audit.data_change_log now goes through api/src/services/changeLogWriter.js (a guard test fails if any other file INSERTs the table) and records actor_sub + new column actor_client: HR/DPO token sub (+ azp), personId for /me (SELF via portal), constants system:thaid-sync / system:hr-import. (2) writer honors field_policy.log_values_in_audit (before: never read, so employment.employee_no = pid was stored in plaintext) and redacts 13-digit numbers in reason. (3) HR import (HR_IMPORT) now writes data_change_log (it wrote nothing before, no outbox by decision). (4) GET /audit/change-logs (audit:read; source PERSON|REFERENCE, filters from/to/actorSub/tableName/personId/changedBy/action) + dpo-console /dpo/change-logs; CONFIDENTIAL/SENSITIVE/RESTRICTED values hidden (valuesHidden) in both this and the per-person change-log. OpenAPI changed (additive). MIGRATIONS 1700000000045 (actor_client + indexes) and 1700000000046 (ONE-TIME append-only exception approved by suratat 2026-10-04: NULLs old/new of field_name='employment.employee_no' with the trigger disabled inside the migration transaction; prod count was 2 rows; RAISE NOTICE with row counts; must be run by the table owner role). DEPLOY: migrate (owner role) + rebuild/restart api1/api2 + dpo-console; no Keycloak change. Old rows keep actor_sub NULL (shown as unknown). Next: PR-B (review of pid reveals, migration 1700000000047, scope audit:review for role dpo only) and PR-C (anomaly alerts, 1700000000048)
- [2026-10-04] Branch fix/dockerignore-negation (committed locally, not pushed, PR not opened): `docker compose build` on VPN-MDM failed with "open infra/postgres/data: permission denied" because the `!**/.env.example` / `!**/.env.staging.example` lines in the root .dockerignore (PR #71) make BuildKit walk into excluded folders (it cannot SkipDir when an exception might match inside), and infra/postgres/data is owned by uid postgres. Removed both `!` lines (no Dockerfile uses .env*.example). Reproduced on Linux semantics (root without DAC caps, dir uid 999 mode 700): fails with the `!` lines, passes without; all 7 Dockerfiles build; context has no .env*, hr*.csv, *.dump, infra/postgres/data, infra/vault/*. Deploy = git pull on VPN-MDM, nothing to restart
- [2026-10-04] Branch fix/access-log-partitions (committed locally, not pushed, PR not opened): audit.access_log monthly partitions were only created by migration 012 (current + next month) and nothing called audit.ensure_access_log_partition afterwards (mdm_worker could not: no CREATE on schema audit). Migration 1700000000044 makes it SECURITY DEFINER (search_path = pg_catalog, audit), EXECUTE only for mdm_worker (mdm_worker_svc inherits it), creates current + 3 months; worker job access-log-partition-ensure (pg-boss daily 03:15) does the same and logs an error if access_log_default has rows. DEPLOY: migrate (owner role must be the one that owns audit.access_log) + rebuild/restart worker. VPN-MDM already has 2026_11/2026_12 created by hand - check before migrate that they are named access_log_YYYY_MM (a differently named overlapping partition makes the migration fail) and that `SHOW timezone` matches what was used when existing partitions were created (bounds are date literals in the session time zone)
- [2026-10-03] Branch fix/ci-run-tests (committed locally, not pushed, PR not opened): CI did NOT run the tests for 6 of 7 workspaces from PR #48 until this branch - only `db` really ran. Cause 1: each job only ran `npm ci` in its own folder, but every globalSetup requires api/test/globalSetup.js (needs `pg` + root `node-pg-migrate`) and hr-console/portal/dpo-console/migrate/worker require api/src + api/test, so jest died with "Cannot find module 'pg'" before any test. Cause 2: `npm test 2>&1 | tee` under `bash -e` (no pipefail) returned tee's exit 0, so the jobs were green anyway. So the "CI passed 7/7" notes (PR #48 and later PRs) mean only `db` was tested. Fix: `npm ci` in root + api + the workspace, `shell: bash` (pipefail), and the job fails when the log has no "Tests:" line. Uncovered by this: 17 stale hr-console tests (claimRequests/jobTitleText/positionLock/approveFormDropdowns sent a random fake pid while the claim had a random pid_hash; PR #69 correctly returns 422 employee-no-pid-mismatch) - tests fixed via hr-console/test/claimHelpers.js, no production code bug. Simulated CI in a clean worktree: all 7 workspaces pass
- [2026-10-03] Branch feat/hr-console-persons-view (committed locally, not pushed, PR not opened): HR Console /hr/persons (search, detail, reveal pid with reason+CSRF), API read:inactive 403 + full-name search + access_log for GET /persons + employeeNoMasked (personnel:read:pid_masked) + ?pidFormat=masked (OpenAPI changed, additive). Keycloak: set A (read:employment, read:inactive) can be added now; set B (read:pid_masked, read:pid) only after DPO agrees - steps in hr-console/README.md.
- [2026-10-03] PR #70 (0864673) fix(infra): KC_PROXY_HEADERS=xforwarded in infra/docker-compose.keycloak.yml — MERGED. Branch
  chore/dockerignore (PR not opened yet): commits the root .dockerignore that existed only on the server (excludes data/secrets
  dirs, node_modules, .git, .env* except the *.example files, keycloak backup JSONs, HR csv files, *.dump from the build
  context); all 7 Dockerfiles under infra/ (api, migrate-cli, migrate, worker, portal, hr-console, dpo-console) still build with it
- [2026-10-03] Keycloak: "Non-secure context detected" came back on VPN-MDM because KC_PROXY_HEADERS was only set on the
  server (2026-09-25) and never committed; put it back and recreated keycloak on VPN-MDM. This branch
  (fix/keycloak-proxy-headers) adds KC_PROXY_HEADERS: "xforwarded" to infra/docker-compose.keycloak.yml so it survives
  redeploys (PR not opened yet). PR #69 (09392ab, PROVISION duplicate pid_hash 409 / employeeNo pid mismatch 422 /
  claim_request.display_name spacing) — MERGED, DEPLOYED api1/api2 on VPN-MDM
- [2026-10-03] Pilot on prod: PENDING_CLAIM -> CLAIMED passed (1 ข้าราชการ อบจ., via my.lp-pao.go.th, MDM
  ACTIVE/VERIFIED). Not tested yet: พนักงานจ้าง. Found: switching browsers on mobile gives thaid-sso no_login_cookie
  (11 times in metrics); the "เริ่มใหม่" button goes to check.lp-pao.go.th, so users wrongly think the login succeeded.
  Fix option A (clearer error message, in-app browser warning, user announcement) is on hold
- [2026-10-03] PR #67 (b857364) fix(api): require personnel:read:basic on POST /persons, deactivate, reactivate and
  GET /reverify/stale (403 insufficient-scope before any DB write, instead of a 500 after commit when the token lacks
  read:basic) — MERGED, DEPLOYED api1/api2 on VPN-MDM (2026-10-03); hr-console's token scopes include read:basic (checked).
  PR #68 (2245915) T8: redact 13-digit numbers in migrate quality_errors messages (err() in migrate/src/quality/rules.js)
  — MERGED, DEPLOYED migrate-cli on VPN-MDM. 2 stale claim_request rows (PENDING_HR) rejected in HR Console; cause: created
  by test logins before the HR import, and their pid_hash differs from the current persons'
- Branch fix/provision-duplicate-and-pid-check (PR not opened yet): resolveClaimRequest action=PROVISION now returns 409
  duplicate-pid (with existingPersonId) when a person with the same pid_hash exists, and 422 employee-no-pid-mismatch when
  pidHash(employeeNo) != claim.pid_hash, both before any DB write; claim_request.display_name from handleUnmatched is now
  separated by spaces (old rows unchanged). No OpenAPI change (409 is not declared for this operation in the YAML; error
  responses bypass the response validator, same as the existing 409 already-resolved). Not done: auto-LINK of claim_request
  during /sync/thaid, endpoint to cancel an approval
- [2026-10-03] PR #65 (6c70c09, fix/omit-position-title) fix(api): omit tokenClaims.positionTitle when employment has no
  position — MERGED. PR #64 (447b38e) test(api): cover ThaID claim of persons created via import — MERGED (test only).
  Deploy on VPN-MDM: main = 447b38e; migrate-cli (#62) and api1/api2 (#65) rebuilt, after backup
  mdm-backup-20261003-044700.dump; no migration
- [2026-10-03] State of HR import batch 782fb229: 783 persons, reconcile 783/783, PENDING_CLAIM 782 / ACTIVE 1
- [2026-10-03] check-app prod check (sso-server):
  - MDM_SYNC_MODE=shadow (not enforce as noted on 23 Sep); the process has loaded the latest .env and the PR #2 code
    (e84c682). Decision: keep shadow during the pilot, switch to enforce once the pilot passes
  - audit baseline_id=222; only NO_CHANGE events of the admin account
  - check-app deploy key moved from root to user sso; run git in /opt/check-app with sudo -u sso
  - installed sqlite3 CLI on sso-server (use -readonly)
  - sso-server has a pending kernel upgrade (6.8.0-139 -> 142), reboot during the maintenance window
- Open: small-group ThaID login pilot (include at least 1 พนักงานจ้าง) — waiting for testers; CLAIMED / UNMATCHED /
  job_title_text paths not yet tested on prod
- [2026-10-02] HR import batch 782fb229-5edb-45f9-b4df-f35413812d58 on VPN-MDM (real HR file, 786 rows): load 786 rows
  (stg_hr 786 rows incl. the 3 failing ones); check-quality OK=783 ERROR=3 (row refs 126, 221, 515 PID_CHECKSUM_INVALID,
  HR notified, waiting for corrected file -> import as a new batch); DRY_RUN created=782 updated=1 unchanged=0 errors=0
  in 5 chunks (180/178/177/168/80 rows, ~61 KB each; 897/571/572/478/248 ms, total 3742 ms; the first DRY_RUN attempt
  failed with 413 because it was one request -> PR #62); APPLY created=782 updated=1 unchanged=0 errors=0 in one run, no
  mid-way failure, after backup mdm-backup-20261002-192759.dump; reconcile matched=783/783 mismatches=0. State after
  import: 782 persons PENDING_CLAIM/UNVERIFIED + 1 ACTIVE/VERIFIED (mdm.person = 783). stg_hr purge of pid_plaintext +
  source_data for this batch: 2026-11-01. See "เงื่อนไขก่อนขึ้นระบบจริง" above for open items
- PR #62 (fix/migrate-import-chunk-by-bytes, T8): MERGED (1bebdc6) — fixes 413 on HR import: runImport now splits
  requests by real body size (MAX_BODY_BYTES 61440 = 60% of express.json() 100 KB default in api/src/app.js, API limit
  NOT raised) via migrate/src/import/chunkByBytes.js; retry 2x on 5xx/network only; 401 fails immediately (TOKEN_EXPIRED,
  says whether earlier chunks were committed); partial report (-partial.json) when a chunk fails midway, batch not set to
  APPLIED, rerun on same batch is safe (committed rows become unchanged; use reconcile to verify). Per-chunk durationMs in
  report to judge token lifetime. No migration, no api/infra change; deploy = rebuild migrate-cli only (needs --env-file
  infra/.env.staging, never --remove-orphans). DEPLOYED on VPN-MDM (2026-10-02 UTC); verified on real batch 782fb229:
  5 chunks, no 413, APPLY single run, reconcile 783/783
- PR #61 (feat/stg-hr-purge-source-data-a, T8): MERGED (a15ce07) — DEPLOYED on VPN-MDM (2026-10-02 UTC). PR A of 2:
  migration 1700000000043 (stg_hr.raw_row loaded_at NOT NULL backfilled COALESCE(pid_loaded_at, import_batch.imported_at,
  now()), source_purged_at, partial index, column-level grants + trigger so mdm_worker can only write source_data = '{}')
  and worker stgHrPurge now clears pid_plaintext + source_data in one statement (loaded_at < now() -
  STG_HR_PID_RETENTION_DAYS). Deploy evidence: backup mdm-backup-20261002-183722.dump (checked with pg_restore --list,
  copied off-site); git pull --ff-only -> a15ce07; migration 1700000000043 applied; verified loaded_at filled 11/11 rows,
  already_purged = 0, oldest_loaded = 2026-10-01, trigger raw_row_guard_worker_source_data present; worker image rebuilt
  and only infra-worker-1 restarted, no errors in its log. batch b8cf1d3c-73a8-4325-896c-1a247150633b ages unchanged,
  purged after 2026-10-31. NOT purged yet, waiting for DPO: expected_first_name_th, expected_last_name_th, phone_raw,
  email_personal_raw, email_work, employee_no, external_value, quality_errors. PR B (redact() in err() of
  migrate/src/quality/rules.js + sentinel test) not started
- PR #59 (feat/migrate-position-no-similar): MERGED (53b6a46) — deployed on VPN-MDM (2026-10-02, no migration).
  Wires api/src/services/positionNoMatch.js (PR #55) into migrate/src/quality/rules.js: check-quality now emits
  POSITION_NO_SIMILAR_EXISTS when position_no doesn't match exactly but normalizes to an existing position
  (names the matching position_no, does not auto-resolve); still POSITION_NOT_FOUND when no match at all.
  loadLookups throws a clear POSITION_NO_KEY_COLLISION error (batch stays non-QUALITY_CHECKED) if mdm.position
  itself has two active positions colliding after normalize. infra/migrate-cli/Dockerfile updated to COPY the
  new file. Verified on VPN-MDM: git pull --ff-only, rebuilt migrate-cli image (see "หมายเหตุ Deploy" above -
  needs --env-file infra/.env.staging or build fails with "no port specified"), confirmed require() resolves
  (no MODULE_NOT_FOUND), re-ran check-quality on batch b8cf1d3c-73a8-4325-896c-1a247150633b (same as PR #34) ->
  OK=11 ERROR=0, unchanged from before this PR
- PR #55 (feat/position-no-match-utility): MERGED (2026-10-02) — adds api/src/services/positionNoMatch.js
  (normalizePositionNo + buildPositionNoIndex, pure function, no DB/HTTP) to normalize position_no as a
  comparison key only (never overwrites the stored position_no) - handles whitespace/NBSP/tab/newline and
  the trailing "(ถ)" suffix (half-width + full-width parens); buildPositionNoIndex throws on key collision
  instead of silently resolving. Utility only - not wired into migrate/ or POST /positions yet (PR 2 next:
  wire into migrate/src/quality/rules.js for POSITION_NO_SIMILAR_EXISTS detection). 20 unit tests, mutation
  testing 5/5 killed. No migration, no deploy needed (pure utility, not called from anywhere yet)
- PR #57 (chore/gitignore-hr-data): MERGED (b317701) — .gitignore only: ignore real HR data files
  (/hr*.csv at root, /migrate/*.csv top-level only - not ** so migrate/data/position-seed-data.csv fixture
  stays tracked). No code, no migration
- PR #52 (fix/personnel-type-map-civil-servant): MERGED (2026-10-01T23:07:19Z) — data-only fix: add
  "ข้าราชการองค์การบริหารส่วนจังหวัด"
  (full name) as a synonym key for "ข้าราชการ อบจ." in migrate/config/personnel-type-map.json, both -> CIVIL_SERVANT
  (confirmed from real HR file). No code/migration touched; migrate suite 41/41 (2026-10-01)
- PR #51 (chore/migrate-cli-dockerfile): MERGED (image built) — infra/migrate-cli/Dockerfile (new, separate from
  infra/migrate/Dockerfile) runs migrate/src/cli.js (HR import tool); copies migrate/ plus 4 api/src files it
  transitively requires (pid.js, jobTitleText.js, httpProblem.js, personnelPositionRules.js - the last one
  was missing from the original instructions, found via actual require() trace). New migrate-cli service in
  infra/docker-compose.staging.yml, profile "tools" only (confirmed not in default `up` service list), no
  depends_on. Verified: docker build succeeds, cli.js runs with correct usage-error messages, no
  MODULE_NOT_FOUND. Infra/tooling only, no production impact (2026-10-01)
- PR #50 (feat/migrate-job-title-text): MERGED (2026-10-01) — deployed on VPN-MDM (migration 1700000000042
  applied). migrate/ tool now supports job_title_text in HR CSV import (column-map.json, loadBatch.js,
  rules.js reuses api/src/services/jobTitleText.js directly, toImportRow.js, runImport.js).
  stg_hr.raw_row.job_title_text is text (not varchar(255) - avoids crashing loadBatch on overlong input
  before JOB_TITLE_TOO_LONG can report it). stg_hr-only, no mdm schema touched. migrate suite 39/39,
  db 50/50, api 306/306
- PR #49 (docs/sync-design-docs): MERGED (2026-09-30) — docs-only: personnel-mdm-design.md + er-01-personnel-core.mermaid add
  job_title_text (PR #40), hr_master_data_admin role + personnel:manage:reference scope (PR #29); adds
  "ภาคผนวก จ" noting post-T9 work isn't in this doc's original scope, points to CLAUDE.md Status Log instead.
  No code/production impact
- PR #48 (ci/github-actions): MERGED (2026-09-30) — adds .github/workflows/ci.yml, matrix job (db/api/worker/
  migrate/hr-console/portal/dpo-console) on pull_request->main and push main, node 22, npm ci + npm test per
  workspace (globalSetup.js handles docker/migrate/roles itself, no env/secrets needed), ~/.npm cache per
  workspace, jest-output.log uploaded as artifact on always(). Verified: CI run on main after merge passed
  7/7 jobs (test db/api/worker/migrate/hr-console/portal/dpo-console all success)
- PR #46 (fix/flaky-tests): MERGED (2026-09-30) — no deploy needed (test-only change). Test-only fix:
  db/test/positionBatchSeed.test.js filters mdm.position queries by CSV position_no (was order-dependent on
  constraints.test.js's uncleaned inserts, confirmed diff=10 rows); migrate/test/rules.test.js:104 fixture
  updated to match personnel-type-map.json's real key 'พนักงานจ้าง' (commit 2e16d9b). No production code,
  migrations, or config touched
- PR #44 (fix/employment-error-status): MERGED (2026-09-30) — deployed on VPN-MDM (api1/api2 built, no migration).
  mapEmploymentConstraintError returns HttpProblem (422 org-unit-invalid/position-invalid/personnel-type-invalid,
  409 position-occupied/employee-no-conflict) instead of plain Error+.code that leaked as 500 on
  provision/reactivate/resolve-claim. PUT /persons/{id}/employment status changed from blanket 409 to per-code
  422/409 (breaking change, no known internal callers affected). Verified: normal approve-claim flow still works
  on real hr-console.
- PR #42 (chore/remove-line-of-work): MERGED (2026-09-30) — deployed on VPN-MDM (migration 041 applied,
  api1/api2 then hr-console/portal/dpo-console). Verified on real hr-console: position form has no
  line_of_work field, approve-form dropdowns (PR #39) and jobTitleText (PR #40) still work correctly.
- PR #40 (feat/employment-job-title-text, T10-feat): MERGED (2026-09-29) — deployed on VPN-MDM
  (migration 040 applied, api1/api2 then hr-console/portal/dpo-console). Verified on real hr-console:
  jobTitleText field for no-position types + OTHER (mutual exclusion with position), maxlength, Back-button.
- PR #34 (fix/position-number-lock, T10-fix): MERGED (2026-09-28) — deployed on VPN-MDM (api1/api2/hr-console). Verified: approve form lock + Back-button on real hr-console, 422 rules on local stack. DRY_RUN check completed 2026-10-01 using a partial real HR CSV file (11 rows passed quality check out of 19 total — 8 rows skipped due to inconsistent column count, not yet resolved with HR). Result: load OK (11 rows), check-quality OK=11 ERROR=0, import --mode DRY_RUN created=10 updated=1 errors=0. Not yet APPLYed — waiting for complete HR file before writing real data.
- [2026-10-01] DRY_RUN test detail for PR #34 (real partial HR CSV, see line above): batch id b8cf1d3c-73a8-4325-896c-1a247150633b. Found 1 missing personnel-type-map.json mapping ("ข้าราชการองค์การบริหารส่วนจังหวัด") - fixed in PR #52. Unresolved: 7 of 19 rows have 15 columns vs the 10-column header - need to ask HR what the extra columns are before importing the complete file.
- PR #33 (docs/keycloak-basic-scope-note, T10 docs): OPEN, mergeable — documents basic client scope loss on --import-realm (2026-09-26)
- T9 (Portal, HR Console, DPO Console): DONE, merged to main
- T8 (stg_hr schema + HR migrate runner): DONE, merged to main
- T7 (check.lp-pao.go.th sync-on-login): DONE, confirmed merged into check-app master on sso-server (commit e84c682) (2026-09-26)
- T1-T6 (SQL migrations → API → worker → staging docker-compose/Keycloak): DONE, merged to main
- PR #32 (fix/audit-log-actor-sub-nullable): MERGED (2026-09-26) — T10-fix: AccessLogEntry.actorSub allow null for SERVICE actors
- PR #31 (fix/keycloak-basic-scope): MERGED (2026-09-26) — T10-fix: declare basic client scope (sub claim) explicitly
- PR #30 (fix/hr-console-server-side-session): MERGED (2026-09-26) — T10-fix: hr-console/dpo-console server-side session (แก้ login วนลูปจาก cookie เกิน 4096 ไบต์)
- PR #29 (reference-master-data-write): MERGED (2026-09-25) — T10: HR Console master data (org units / positions) + hr_master_data_admin
