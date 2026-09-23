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

## หน้าจอ

1. `GET /dpo/access-logs` — รายการ access log (`audit.access_log` ผ่าน `GET /audit/access-logs`)
   filter ได้ด้วย `personId`, `clientId`, ช่วงวันที่ (`from`/`to`), "เฉพาะการเข้าถึง pid/lookup"
   (`pidAccessOnly`) — ทั้งหมด filter ฝั่ง MDM API (มี cursor pagination จริง)
2. `GET /dpo/persons/{personId}/change-log` — ประวัติการเปลี่ยนแปลงรายฟิลด์ของบุคคลหนึ่งคน (ลิงก์จาก
   personId ในตาราง access log) filter ด้วย `since` ค่าฟิลด์ที่จัดชั้น `RESTRICTED` (เช่น `person.pid_hash`)
   แสดงเป็น "(ปกปิด/ไม่มีค่า)" เสมอ — ปกปิดโดย MDM API เอง (`auditService.js`) ไม่ใช่ฝั่ง DPO Console

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
