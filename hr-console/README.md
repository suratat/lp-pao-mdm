# HR Console (T9 รอบ 2)

Express app แยกจาก `api/`, `worker/`, `portal/` — คุยกับ MDM API ผ่าน HTTP เท่านั้น (ไม่แตะ Postgres/Vault
โดยตรง) ให้เจ้าหน้าที่ฝ่ายบุคคล (realm role `hr_officer`) อนุมัติ/ปฏิเสธ claim request (ล็อกอิน ThaID ที่หา
บุคคลใน MDM ไม่เจอ) และดูรายชื่อที่ข้อมูล ThaID ค้างยืนยัน (STALE/EXPIRED)

ไม่เพิ่ม endpoint ใหม่ใน `api/` — ทั้งสองหน้าจอใช้ endpoint ที่มีอยู่แล้วจาก T5:
`GET /claim-requests`, `POST /claim-requests/{id}/resolve`, `GET /reverify/stale` (และ
`POST /persons/{id}/reverify` สำหรับปุ่ม "ขอ reverify ทันที" ในหน้า reverify)

## สถาปัตยกรรม auth: Keycloak authorization code flow (ต่างจาก Portal)

Portal (self-service) ใช้ client credentials + X-Acting-Person เพราะไม่ต้องรู้ว่าใครคือผู้ใช้ในความหมาย
ของ Keycloak (ผู้ใช้ล็อกอินด้วย ThaID ผ่าน check.lp-pao.go.th ไม่ใช่ Keycloak) HR Console ต่างออกไป:
ต้องรู้ตัวตนจริงของเจ้าหน้าที่และตรวจ **realm role `hr_officer`** ก่อนให้เข้าใช้งาน จึงใช้ authorization
code flow มาตรฐานกับ client Keycloak ของตัวเอง (`hr-console`, confidential, `standardFlowEnabled=true`)

1. `GET /auth/login` → สุ่ม `state` (กัน CSRF) เก็บใน cookie อายุ 5 นาที แล้ว redirect ไป Keycloak
   authorization endpoint พร้อม `scope` ตาม `HR_CONSOLE_SCOPES`
2. `GET /auth/callback?code=&state=` → ตรวจ `state` ตรงกับ cookie ก่อนเสมอ แล้วแลก `code` เป็น
   token ที่ token endpoint (`grant_type=authorization_code`)
3. ตรวจ **`id_token`** (ไม่ใช่ `access_token`) ด้วย JWKS ของ Keycloak: `alg=RS256`, `iss`, และ
   `aud = HR_CONSOLE_CLIENT_ID` (client id ของ hr-console เอง — คนละ audience กับ `access_token` ที่จะ
   ส่งต่อให้ MDM API ซึ่งต้องมี `aud=mdm-api` แทน) อ่าน `realm_access.roles` จาก id_token — ปฏิเสธ
   (403) ถ้าไม่มี `hr_officer`
4. `access_token`/`refresh_token` เก็บใน **session ฝั่งเซิร์ฟเวอร์** (in-memory, `src/session/sessionStore.js`) ส่วน cookie
   `hr_console_sid` เก็บแค่ session id สุ่ม 32 ไบต์ (Set-Cookie ~105 ไบต์ ไม่ขึ้นกับขนาด token) — เดิมเก็บ token ทั้งชุด
   ใน cookie JWE เดียว จนเกิน 4096 ไบต์เมื่อ token โตขึ้น (T10 เพิ่ม role/scope) เบราว์เซอร์ทิ้ง Set-Cookie เงียบๆ
   ทำให้ login วนลูป (`ERR_TOO_MANY_REDIRECTS`/`invalid_grant`) — `id_token` ตรวจแล้วทิ้ง ไม่เก็บ
   - อายุ session absolute 12 ชม., มี sweep ทุก 5 นาที และเพดาน 5,000 session (เต็มแล้วตัดตัวที่ **ไม่ได้ใช้นานสุด** แบบ LRU ไม่ใช่ตัวที่ login ก่อน)
   - login ออก sid ใหม่ทุกครั้ง (กัน session fixation) และล้าง cookie รุ่นเก่า `hr_console_session`; logout ลบ session ฝั่ง server ด้วย
   - **ข้อจำกัดที่ตั้งใจ:** รันได้แค่ **instance เดียว** และ **session หายเมื่อ restart/deploy** (ผู้ใช้ถูกส่งไป Keycloak แล้วกลับมาเอง
     ถ้า SSO session ยังอยู่) ถ้าจะรันหลาย instance ต้องเปลี่ยน store เป็น Redis (คง interface `create/get/update/delete`)
   - `HR_CONSOLE_SESSION_SECRET` ไม่ใช้แล้ว (ไม่ต้องตั้ง)
5. ทุก request ไป MDM API แนบ `access_token` ของผู้ใช้ตรง ๆ เป็น `Authorization: Bearer` (ไม่มี
   `X-Acting-Person` เหมือน Portal เพราะ scope ของ HR (`personnel:provision` ฯลฯ) ไม่ใช่ user context
   `personnel:self` ที่ต้องมี person_id ผูกอยู่)
6. access token ใกล้หมดอายุ (ภายใน 15 วินาที) → `authGate` refresh อัตโนมัติด้วย `refresh_token`
   (silent refresh, อัปเดตใน store ไม่ต้อง Set-Cookie ใหม่) แบบ **single-flight ต่อ session**: realm ตั้ง
   `revokeRefreshToken=true` (refresh token ใช้ได้ครั้งเดียว) request พร้อมกันจึงรอผล refresh ครั้งเดียวกัน
   แทนที่จะแย่งกัน refresh แล้วได้ `invalid_grant` ถ้า Keycloak ส่ง `id_token` ใหม่มาด้วยตอน refresh จะตรวจ role `hr_officer` ซ้ำ
   (เผื่อถูกถอด role ระหว่าง session ยังไม่หมดอายุ) ถ้า refresh ไม่สำเร็จ/ไม่มี refresh_token →
   ล้าง session แล้ว redirect ไป `/auth/login`

ไม่มี dev-login stub เหมือน Portal — HR Console เป็นเครื่องมือของเจ้าหน้าที่ที่ต้องมี role `hr_officer`
เท่านั้น ไม่ควรมีทางลัดข้ามการตรวจ role แม้ใน dev/test (เทสใช้ mock Keycloak token endpoint จริงแทน)

## ทำไมต้องมี `personnel:read:basic` เพิ่ม (นอกเหนือจาก personnel:provision/write:employment/import)

`GET /reverify/stale` คืน schema `Person` ซึ่งถูก field-mask ตาม `x-required-scope` ใน
`docs/design/personnel-mdm-openapi.yaml` เหมือน endpoint อื่นทุกตัว: กลุ่มฟิลด์ `basic` (ชื่อ-สกุล,
ตำแหน่ง, สังกัด) และ `verification` (verificationStatus, thaidVerifiedAt) ต้องมี scope
`personnel:read:basic` — ถ้า client `hr-console` มีแค่ `personnel:provision`/`write:employment`/`import`
ตามที่ตกลงไว้ตอนแรก หน้า reverify list จะเห็นแค่ `personId`/`status` เปล่า ๆ ไม่มีชื่อ/สังกัดให้ระบุตัวคน
เลย (ยืนยันด้วยเทส `test/reverify.test.js`) จึงต้องขอเพิ่ม `personnel:read:basic` ให้ client `hr-console`
ใน Keycloak จริงด้วย (ดู `infra/keycloak/realm-export.json` ที่แก้ไว้แล้วสำหรับ staging — **ฝั่ง
production ต้องให้ผู้ดูแล Keycloak เพิ่ม default client scope นี้ให้ client `hr-console` ตัวจริงเองด้วย
เพราะงานนี้ตั้งค่าไว้แค่ใน realm-export.json ของ staging เท่านั้น**) `personnel:read:basic` ไม่มี
contact/identity/pid ปนอยู่ ความเสี่ยงต่ำ (ดูตาราง §2.2 ของเอกสารออกแบบ)

`claim-requests` list ไม่ติดปัญหานี้ — schema `ClaimRequest` ไม่มี `x-required-scope` เลยสักฟิลด์
(ดูข้างล่าง หัวข้อ pid)

## pid ในหน้าจออนุมัติ (approve)

`action=PROVISION` ของ `POST /claim-requests/{id}/resolve` ต้องการ `employment.employeeNo` ซึ่งตาม
เอกสารออกแบบคือ **เลขบัตรประชาชนเสมอ** (อบจ.ลำปางไม่มีเลขประจำตัวข้าราชการแยกต่างหาก) หน้าฟอร์ม
`/hr/claim-requests/:id/approve` จึงมีช่องกรอกเลขนี้ตรง ๆ ให้ HR (ส่งทาง POST body เท่านั้น ไม่ใช่ query
string) เป็นพฤติกรรมที่ตั้งใจตามสัญญา API เดิม ไม่ใช่สิ่งที่ HR Console เพิ่มขึ้นมาเอง — โค้ดฝั่งนี้ไม่ log
`req.body` ที่ route นี้เลย (ตาม hard rule ข้อ 1) และไม่ echo ค่ากลับเข้าฟอร์มถ้า resolve ล้มเหลว (ลด
surface ที่ pid จะไปโผล่ในที่ที่ไม่ตั้งใจ) `ClaimRequest` schema เองไม่มีฟิลด์ pid/pid_hash ให้แสดงในหน้า
รายการเลย (แสดงได้แค่ `displayName` จาก ThaID) — จงใจตามสัญญา API เดิม ไม่ใช่ intentional gap ของงานนี้

Reference lookups ในฟอร์ม approve: หน่วยงาน (`orgUnitId`) และตำแหน่ง (`positionId`) เป็น dropdown จาก `GET /org-units`, `GET /positions`,
`GET /position-types` (scope `personnel:read:basic` ที่ client `hr-console` มีอยู่แล้ว) — ดูหัวข้อถัดไป

## ฟอร์ม approve claim: dropdown หน่วยงาน/ตำแหน่ง + lock ตามประเภทบุคลากร

- **หน่วยงาน** (`orgUnitId`): dropdown "รหัสหน่วยงาน — ชื่อหน่วย" เฉพาะที่ active (ค่าที่ส่งเป็น UUID)
- **ตำแหน่ง** (`positionId`): dropdown "เลขที่ตำแหน่ง — ชื่อตำแหน่ง · ประเภทตำแหน่ง (ชื่อไทย)" เฉพาะที่ active และกรองตามหน่วยงานที่เลือก
  (ไม่แสดงระดับ/สายงาน: ระดับเป็นของ `employment.level_code` ไม่ใช่ของตำแหน่ง) — ช่องระดับ/ชั้น (`levelCode`) ยังเป็นช่องพิมพ์เอง
- server ของ console ตรวจซ้ำก่อนเรียก API: หน่วยงาน/ตำแหน่งมีอยู่จริงและ active, ตำแหน่งอยู่ในหน่วยงานที่เลือก (MDM API ไม่ตรวจข้อนี้)

ช่องตำแหน่ง lock ตามประเภทบุคลากร
(ค่าที่เจ้าของระบบยืนยัน, `src/personnelTypes.js` ↔ `api/src/services/personnelPositionRules.js` มี test เทียบสองฝั่ง):
- **ห้ามมี** — พนักงานจ้าง 3 ประเภท (`CONTRACT/GENERAL/EXPERT_EMPLOYEE`), `OUTSOURCE_INDIVIDUAL`, `POLITICAL_APPOINTEE`: ช่องถูกล้างค่า + disable + ไม่ required
- **ต้องมี** — `CIVIL_SERVANT`, `TEACHER`, `PERMANENT_EMPLOYEE`, `TRANSFERRED_HEALTH`: ช่อง enable + required
- **ไม่บังคับ** — `OTHER`
- สคริปต์ lock ทำงานตอนโหลดหน้า, ตอนเปลี่ยน dropdown, และตอน `pageshow` (กด Back แล้วเบราว์เซอร์คืนค่าเดิมโดยไม่ยิง `change`)
- ฝั่ง client เป็น UX เท่านั้น: server ของ console ตรวจซ้ำ (422 ก่อนเรียก API) และ **MDM API บังคับทุกเส้นทางที่เขียน employment** (422
  `position-required` / `position-not-allowed`, batch import = error รายแถว) — client แก้ผ่าน devtools ไม่ได้ผล
- เลขที่ตำแหน่งแบบเลขลำดับล้วน (ลูกจ้างประจำ) รับ 1–4 หลัก (เดิม 1–2 หลักตาม seed) — ทั้งฟอร์มนี้และฟอร์ม master data ตำแหน่ง
- ทดสอบสคริปต์ lock ในเบราว์เซอร์จริง (Google Chrome headless รัน script ตัวจริงของหน้า) แล้ว: 13 สถานการณ์ตามเกณฑ์ผ่านทั้งหมด (ก่อนเปลี่ยนเป็น dropdown; สคริปต์ปัจจุบันตรวจซ้ำใน Chrome headless แล้วเช่นกัน — ดู PR)
- ยังไม่ได้ยืนยัน: เบราว์เซอร์จริงที่ session จริงบน staging (ดู checklist ใน PR)

### ชื่อตำแหน่ง/ลักษณะงาน (`jobTitleText`, ข้อความอิสระ)

สำหรับบุคลากรที่ไม่มีเลขที่ตำแหน่งตามอัตรากำลัง — เก็บที่คอลัมน์แยก `mdm.employment.job_title_text` (varchar(255)) **ไม่ใช้ `position_id`/`position_no`**
และไม่แทน `basic.positionTitle`, ไม่อยู่ใน token claims (`syncService`)
- **ใช้ได้กับ:** ประเภทที่ห้ามมีตำแหน่ง (`CONTRACT/GENERAL/EXPERT_EMPLOYEE`, `OUTSOURCE_INDIVIDUAL`, `POLITICAL_APPOINTEE`) และ `OTHER`
- **ประเภทที่ต้องมีตำแหน่ง** (`CIVIL_SERVANT`, `TEACHER`, `PERMANENT_EMPLOYEE`, `TRANSFERRED_HEALTH`): ซ่อน/disable ช่อง+ล้างค่า; ส่งมาตรง ๆ → 422 `job-title-not-allowed`
- **`OTHER`:** เลือกได้อย่างใดอย่างหนึ่ง (ตำแหน่ง หรือข้อความ หรือไม่ใส่) — กรอกอย่างใดอย่างหนึ่งแล้วอีกช่องถูก disable อัตโนมัติ ลบ/เลือกกลับเพื่อเปลี่ยนใจ;
  ส่งทั้งสองอย่าง → 422 `position-and-job-title-conflict` (ถ้าเบราว์เซอร์คืนค่ามาทั้งสองช่อง ตำแหน่งชนะและข้อความถูกล้าง)
- **การตรวจ (console และ MDM API ตรวจซ้ำทั้งคู่ — `src/jobTitleText.js` ↔ `api/src/services/jobTitleText.js` มี test เทียบสองฝั่ง):** ตัด control/bidi/zero-width characters,
  รวมขึ้นบรรทัดใหม่เป็นช่องว่างเดียว, trim, ยาวไม่เกิน 255 ตัวอักษร, **ปฏิเสธข้อความที่มีเลขบัตรประชาชน 13 หลัก** (ติดกัน/มีขีด/เว้นวรรค/จุด/เลขไทย) — error ไม่ echo ข้อความกลับ
- **history:** แก้เฉพาะข้อความ = ปิดแถว employment เก่า/เปิดแถวใหม่ + `data_change_log` (`employment.job_title_text`) + `outbox_event` ใน transaction เดียว
  (`changed_fields` มีแค่ชื่อฟิลด์ ข้อความไม่ไปอยู่ใน payload ของ outbox/webhook/`GET /events`)
- **การแสดงผล:** hr-console reverify, portal `/portal/me` (แถว "ชื่อตำแหน่ง/ลักษณะงาน"), dpo-console change-log — escape ทุกจุด + `overflow-wrap: anywhere` ใน CSS ของตาราง

## T10: จัดการ master data หน่วยงาน/ตำแหน่ง (`/hr/master-data`)

หน้าเพิ่ม/แก้ `mdm.org_unit` และ `mdm.position` ผ่าน `POST/PUT /org-units`, `/positions` ของ MDM API
- **สิทธิ์:** เฉพาะผู้มี realm role **`hr_master_data_admin`** (PS ที่ได้รับมอบหมาย + เจ้าของระบบ) แยกจาก `hr_officer` โดยสิ้นเชิง
  แต่ยังต้องมี `hr_officer` ด้วยเพื่อ login เข้า console ได้ (ผู้ใช้ต้องมีทั้งสอง role) `hr_officer` ทั่วไปได้ 403 ทุก path/method ของ
  `/hr/master-data*` และไม่เห็นลิงก์เมนู ที่ console นี้เป็นเพียงชั้นแรก — MDM API ตรวจ scope `personnel:manage:reference`
  **และ** role จาก access token ซ้ำเสมอ (ไม่พึ่ง console) ดู `infra/keycloak/README.md`
- **หน้า:** รายการหน่วยงาน (กรอง ใช้งาน/ปิดใช้งาน/ทั้งหมด), รายการตำแหน่ง (กรองหน่วยงาน, ค้นหาเลขที่/ชื่อ, แบ่งหน้า 50 รายการ),
  ฟอร์มเพิ่ม/แก้ทั้งสองแบบ
- **ไม่มีการลบ:** "ปิดใช้งาน" = `isActive=false` (มี confirm ก่อนส่ง) MDM API ปฏิเสธถ้ายังมีของที่ผูกอยู่ (หน่วยงานลูก/ตำแหน่ง/ผู้ดำรงตำแหน่ง)
  และแสดงเหตุผลในฟอร์ม
- **Validation ฝั่ง client:** `pattern`/`required`/`maxlength` + สคริปต์ inline (`setCustomValidity`, ตัดช่องว่างหัวท้าย) หน่วยงาน/หมวดตำแหน่ง/ต้นสังกัด
  เป็น `<select>` เท่านั้น (ค่าที่ส่งคือ id ไม่ใช่ข้อความที่พิมพ์เอง) และ server ของ console ตรวจซ้ำก่อนเรียก API (`src/masterData.js`)
  รูปแบบ `position_no` ต้องตรงกับ `components.schemas.PositionNo` ใน OpenAPI (4 รูปแบบตามข้อมูลจริง)
- **ยังไม่ได้ทดสอบในเบราว์เซอร์จริง:** เทสตรวจ HTML ที่ render (attribute `pattern` คอมไพล์ได้ทั้งโหมด u/v, สคริปต์ไม่มี syntax error) แต่ไม่ได้รัน
  สคริปต์ใน DOM จริง (ไม่มี jsdom/เบราว์เซอร์ในรายการ dependency) — ควรเปิดดูด้วยตาบน staging ก่อนใช้งานจริง

## ยังไม่ครอบคลุมในรอบนี้ (ตั้งใจ ไม่ใช่ลืม)

1. `action=LINK` (ผูก claim request กับ person ที่มีอยู่แล้วแต่ไม่มี pid_hash) — MVP รองรับแค่
   อนุมัติ (PROVISION) / ปฏิเสธ (REJECT) ตามที่ระบุในงาน ("ปุ่ม approve/reject")
2. org-unit/position picker (ดูหัวข้อด้านบน)
3. `hr_scope_org_units` (จำกัด HR ให้เห็นเฉพาะสังกัดตน) — เอกสารออกแบบ §2.2 ข้อ 5 ระบุชัดว่า
   "HR (hr_officer) ไม่มี row-level จำกัดในเวอร์ชันแรก" จึงไม่ implement ในรอบนี้เช่นกัน

## รันแบบ dev

```bash
cd hr-console && npm install
cp .env.example .env   # เติมค่าจริงของ client hr-console ใน Keycloak
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

## หน้า "ข้อมูลบุคคล" (/hr/persons) - ดูอย่างเดียว

- `/hr/persons` ค้นหา (ชื่อ หรือ "ชื่อ นามสกุล" แบบขึ้นต้นด้วย), กรองสถานะ/หน่วยงาน/ประเภทบุคลากร, หน้าถัดไปแบบ cursor
- `/hr/persons/:id` รายละเอียด + ตำแหน่งปัจจุบัน (รวม job_title_text) + ประวัติ employment
- `/hr/persons/:id/reveal-pid` ฟอร์มเหตุผล (POST + CSRF, 10-500 ตัวอักษร, ห้ามมีเลข 13 หลัก) -> แสดงเลขเต็มใน response ของ POST เท่านั้น (`no-store`, ไม่ redirect, ไม่เก็บใน session)
- `mdmClient` ส่ง `?pidFormat=masked` ใน searchPersons/getPerson/getEmployment เสมอ และลบ key `employeeNo` ออกจากผลลัพธ์ทุกครั้ง (เฉพาะ `revealPid` ที่คืนเลขเต็ม)
- ปุ่ม/คอลัมน์ซ่อนตาม scope ใน access token (UI เท่านั้น MDM API ตรวจซ้ำ)

### เพิ่ม scope ให้ client `hr-console` ใน Keycloak admin (realm-export.json ไม่ถูก apply ซ้ำ)

Clients -> `hr-console` -> Client scopes -> Add client scope -> เลือก scope -> เลือก **Default**

- **ชุด A (เปิดได้ทันที):** `personnel:read:employment`, `personnel:read:inactive`
- **ชุด B (เปิดเมื่อ DPO เห็นชอบเท่านั้น):** `personnel:read:pid_masked`, `personnel:read:pid`
  - `personnel:read:pid_masked` ยังไม่มี client scope นี้ใน realm จริง ต้องสร้างก่อน: Client scopes -> Create client scope (Type: None, Protocol: OpenID Connect, ชื่อ `personnel:read:pid_masked`, Include in token scope = On, Display on consent screen = Off) แล้วค่อยเพิ่มให้ client
  - หลังเพิ่ม ให้ผู้ใช้ logout/login ใหม่เพื่อให้ token มี scope ใหม่
