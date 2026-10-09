# DPO Console (T9 รอบ 3)

Express app แยกจาก `api/`, `worker/`, `portal/`, `hr-console/` — คุยกับ MDM API ผ่าน HTTP เท่านั้น
(ไม่แตะ Postgres/Vault โดยตรง) ให้เจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคล (realm role `dpo` หรือ `auditor`)
ตรวจสอบ access log (ใครเข้าถึงข้อมูลของใคร) และประวัติการเปลี่ยนแปลงรายฟิลด์ของบุคคล

โครงสร้างและสถาปัตยกรรม auth เหมือน `hr-console/` ทุกประการ (เป็น service คนละตัวที่คัดลอกโค้ดมาแทนที่จะ
แชร์ dependency ร่วม — ดูเหตุผลใน `hr-console/README.md`) ต่างกันที่:

- ตรวจ realm role **`dpo` หรือ `auditor`** (ไม่ใช่ `hr_officer`) — มีอย่างใดอย่างหนึ่งก็เข้าได้ (ทั้งคู่มี
  scope `audit:read` ตามเอกสารออกแบบ §2.2)
- ไม่มี `X-Acting-Person`/action ที่แก้ไขข้อมูลใด ๆ — เป็น read-only ล้วน (แค่ `GET`)
- ไม่ต้องขอ scope เพิ่มแบบที่ hr-console ต้องขอ `personnel:read:basic` เพิ่ม — `AccessLogEntry`/
  `ChangeLogEntry` schema ไม่มี `x-required-scope` บนฟิลด์ใดเลย จึง scope `audit:read` เพียงตัวเดียวก็เห็น
  ข้อมูลครบตามที่ endpoint คืนมา (ตรวจสอบแล้วก่อนเริ่มงานนี้ ไม่ต้องเดา)


## Session (T10-fix)

เหมือน `hr-console` ทุกประการ: token เก็บใน **session ฝั่งเซิร์ฟเวอร์** (in-memory, `src/session/sessionStore.js`) cookie
`dpo_console_sid` เก็บแค่ session id (Set-Cookie ~106 ไบต์ ไม่ขึ้นกับขนาด token) — เดิมเก็บ access+refresh+id token ใน cookie JWE
เดียว ซึ่งเสี่ยงเกินเพดาน 4096 ไบต์ของ cookie (ดู `hr-console/README.md` ข้อ 4) refresh เป็น single-flight ต่อ session
(realm ตั้ง `revokeRefreshToken=true`) **ข้อจำกัดที่ตั้งใจ:** instance เดียว และ session หายเมื่อ restart/deploy
`DPO_CONSOLE_SESSION_SECRET` ไม่ใช้แล้ว

## หน้าจอ

1. `GET /dpo/access-logs` — รายการ access log (`audit.access_log` ผ่าน `GET /audit/access-logs`)
   filter ได้ด้วย `personId`, `clientId`, ช่วงวันที่ (`from`/`to`), "เฉพาะการเข้าถึง pid/lookup"
   (`pidAccessOnly`) — ทั้งหมด filter ฝั่ง MDM API (มี cursor pagination จริง)
2. `GET /dpo/persons/{personId}/change-log` — ประวัติการเปลี่ยนแปลงรายฟิลด์ของบุคคลหนึ่งคน (ลิงก์จาก
   personId ในตาราง access log) filter ด้วย `since` ค่าฟิลด์ที่จัดชั้น `RESTRICTED` (เช่น `person.pid_hash`)
   แสดงเป็น "(ปกปิด/ไม่มีค่า)" เสมอ — ปกปิดโดย MDM API เอง (`auditService.js`) ไม่ใช่ฝั่ง DPO Console

3. `GET /dpo/change-logs` — ประวัติการเปลี่ยนแปลงทั้งระบบ (`GET /audit/change-logs`, scope `audit:read`) เรียงใหม่ -> เก่า
   เลือก `source`: `PERSON` (`audit.data_change_log`: กรอง `personId`, `changedBy`) หรือ `REFERENCE`
   (`audit.reference_change_log` หน่วยงาน/ตำแหน่ง: กรอง `action`) และกรองด้วยช่วงเวลา, `actorSub`, `tableName` ได้ทั้งสอง source
   - **ค่าถูกปกปิด:** ฟิลด์ชั้น CONFIDENTIAL/SENSITIVE/RESTRICTED แสดงเป็น "(ปกปิด)" เห็นแค่ชื่อฟิลด์ที่เปลี่ยน (ปกปิดโดย MDM API
     และใช้กับหน้า change-log รายบุคคลด้วย) เลข 13 หลักในค่า/เหตุผลถูกแทนที่ด้วย "[ปกปิดเลข 13 หลัก]" ทั้งที่ API และที่ console
   - **ผู้กระทำ:** `actor_sub` = sub ของ token (HR/DPO ที่ล็อกอิน), personId (เจ้าของข้อมูลแก้ของตัวเองผ่าน portal),
     `system:thaid-sync` (sync ตอน login ThaID), `system:hr-import` (นำเข้าจาก HR) + `actor_client` (azp) แถวที่เขียนก่อน PR-A
     (migration 1700000000045) แสดง "ไม่ทราบ" เพราะแก้ย้อนหลังไม่ได้ (append-only)

4. `GET /dpo/pid-reveals` — รายการ "การเปิดเลขบัตรเต็ม" (`POST /persons/{id}/pid`; แถวก่อน PR-B เป็น `GET`) ที่รอรีวิว/รีวิวแล้ว/ขอคำชี้แจง (ตัวกรอง `reviewStatus`
   ของ `GET /audit/access-logs`, เรียงเก่า → ใหม่) แสดง Access ID, ผู้เปิด/client, personId, justification, สถานะรีวิว **ไม่แสดงเลขบัตร**
   และ `POST /dpo/pid-reveals/{accessId}/review` บันทึกผลรีวิว (`REVIEWED` / `NEEDS_EXPLANATION` + หมายเหตุ) ผ่าน
   `POST /audit/access-logs/{accessId}/review` (scope `audit:review` **และ** realm role `dpo` - ตรวจที่ MDM API ทุกครั้ง)
   - **เฉพาะ role `dpo`:** `auditor` เห็นรายการแต่ไม่เห็นฟอร์ม (ซ่อนจาก role ใน id_token + scope ใน access token เพื่อ UX เท่านั้น) และถ้าส่งเอง API ตอบ 403
   - **ห้ามรีวิวรายการที่ตนเองเป็นผู้เปิด** (เทียบ `sub`) → 403 `self-review-forbidden`
   - **CSRF:** ฟอร์ม POST ใช้ token ต่อ session (`src/session/csrf.js` เหมือน hr-console) ส่งกลับเป็นฟิลด์ `_csrf`; หน้าในกลุ่มนี้ `Cache-Control: no-store`
   - หมายเหตุห้ามมีเลข 13 หลัก (422) และ `NEEDS_EXPLANATION` ต้องมีหมายเหตุ รีวิวซ้ำได้ (append-only ผลล่าสุดคือสถานะปัจจุบัน)
   - แนวคิดสถานะ: `PENDING` ไม่เก็บเป็นแถว = ยังไม่มีผลรีวิว (migration 1700000000047) ขั้นตอนตั้ง scope ใน Keycloak: `infra/keycloak/README.md`

5. `GET /dpo/alerts` — แจ้งเตือนพฤติกรรมการเข้าถึงข้อมูลผิดปกติ (`GET /audit/alerts`, scope `audit:read`) ที่ worker job `access-anomaly-scan`
   (ทุก 5 นาที) ตรวจพบ: `BULK_VIEW` (เปิดดูบุคคลหลายคนในเวลาสั้น), `OFF_HOURS` (นอกเวลาราชการ จ.-ศ. 08:30-16:30 เวลาไทย รวมเสาร์-อาทิตย์),
   `PID_REVEAL_FREQUENT` (เปิดเลขบัตรบ่อย) ค่าเกณฑ์ตั้งจาก env ของ worker (ดู `infra/.env.staging.example`) กรองสถานะ (ค่าเริ่มต้น `OPEN`) กฎ ช่วงเวลา และบัญชี
   `POST /dpo/alerts/{id}/ack|close` รับทราบ/ปิดเรื่อง (scope `audit:review` **และ** realm role `dpo`, CSRF เหมือนหน้า `/dpo/pid-reveals`):
   - สถานะคำนวณจากการกระทำล่าสุด: ไม่มี = `OPEN`, รับทราบ = `ACK`, ปิดเรื่อง = `CLOSED` (ตาราง append-only); **ปิดเรื่องต้องมีหมายเหตุ**
     ห้ามมีเลข 13 หลัก; ปิดแล้วทำอะไรต่อไม่ได้ (409) ไม่มีการเปิดใหม่ - ถ้าพฤติกรรมเกิดซ้ำใน bucket ถัดไป ระบบสร้าง alert ใหม่เอง
   - **ผู้ถูกแจ้งเตือนรับทราบ/ปิด alert ของตัวเองไม่ได้** (403 `self-alert-forbidden`)
   - `auditor` เห็นรายการแต่ไม่เห็นฟอร์ม (เหมือน `/dpo/pid-reveals`)
   - alert ไม่มีตัวตนของผู้ถูกเข้าถึง (เก็บแค่จำนวน/ช่วงเวลา/ผู้เข้าถึง) มีลิงก์ไปหน้า access log ตามช่วงเวลาและ client นั้นเพื่อไล่ดูรายละเอียด
   - Telegram (opt-in ที่ฝั่ง worker: `DPO_TELEGRAM_BOT_TOKEN` + `DPO_TELEGRAM_CHAT_ID` ไม่ตั้ง = ปิด) ส่งเฉพาะ alert ใหม่ ข้อความไม่มี pid/ชื่อ

### "ประเภท action" (actorType) — จงใจไม่แก้ API contract

MVP นี้ขอกรอง "ประเภท action" แต่ `AccessLogEntry` ที่มีอยู่ไม่มีฟิลด์ที่ตรงความหมายนั้นตรง ๆ — DB มี
`http_method` (GET/POST) แต่ไม่ถูกส่งออกมาใน response/OpenAPI schema เลย มีแค่ `actorType`
(`USER`/`SERVICE`) ที่ส่งออกมาอยู่แล้ว จึงใช้ `actorType` เป็นตัวกรอง **ฝั่ง DPO Console เอง** (ไม่ใช่
query param ของ MDM API เพราะ `/audit/access-logs` ไม่รองรับกรองด้วย `actorType`) ผลคือ:

- จำนวนแถวที่แสดงต่อหน้าอาจน้อยกว่า limit ที่ขอจริง (กรองทีหลังจากที่ดึงมาแล้ว)
- cursor ของ "หน้าถัดไป" อ้างอิงจากชุดข้อมูลก่อนกรอง — ถ้าตัวกรองนี้ตัดออกเยอะอาจต้องกด "หน้าถัดไป"
  มากกว่าหนึ่งครั้งกว่าจะเจอแถวที่ตรงเงื่อนไข

ถ้าต้องการกรองแบบแม่นยำ/มีประสิทธิภาพกว่านี้ในอนาคต ต้องแก้ `docs/design/personnel-mdm-openapi.yaml`
(เพิ่ม query param เช่น `actorType` หรือเปิดเผย `httpMethod` ใน schema) และ
`api/src/services/auditService.js` — ไม่ได้ทำในรอบนี้ตามที่ตกลงกันไว้ก่อนเริ่มงาน

## ยังไม่ครอบคลุมในรอบนี้ (ตั้งใจ ไม่ใช่ลืม)

1. หน้าจอ event feed (`GET /events`, scope `events:read`) — client `dpo-console` มี scope นี้ให้แล้วใน
   Keycloak แต่ MVP scope ที่ระบุไว้มีแค่ audit log/access log เท่านั้น ยังไม่ได้ทำหน้าจอสำหรับมัน
2. กรอง `actorType` แบบ server-side (ดูหัวข้อด้านบน)
3. per-org-unit scoping — ไม่มีแนวคิดนี้สำหรับ dpo/auditor ในเอกสารออกแบบเลย (ต่างจาก HR ที่อย่างน้อยมีพูดถึง
   `hr_scope_org_units` เป็นทางเลือกในอนาคต)

## รันแบบ dev

```bash
cd dpo-console && npm install
cp .env.example .env   # เติมค่าจริงของ client dpo-console ใน Keycloak
npm start
```

## ทดสอบ

```bash
npm test
```

รัน MDM API จริง (`api/src/app.js`) บน loopback port ชั่วคราว + Postgres (Testcontainers ผ่าน
`db/docker-compose.yml` ตัวเดียวกับ `api/test`) และ mock Keycloak token endpoint (เซ็น id_token/access_token
ด้วย private key เดียวกับที่ MDM API test instance เชื่อ — ดู `test/mockKeycloakServer.js`) ไม่ mock
MDM API เลย
