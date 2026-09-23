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
4. `access_token`/`refresh_token` เก็บใน session cookie ของ HR Console เอง **แบบเข้ารหัส** (JWE,
   `alg=dir`/`enc=A256GCM`, key มาจาก `HR_CONSOLE_SESSION_SECRET`) ต่างจาก `portal_session` ของ Portal
   ที่เก็บแค่ `personId` (ไม่ sensitive) จึงแค่เซ็นด้วย JWS เฉย ๆ — คุกกี้นี้พก bearer token จริงจึงต้อง
   เข้ารหัสไม่ใช่แค่เซ็น
5. ทุก request ไป MDM API แนบ `access_token` ของผู้ใช้ตรง ๆ เป็น `Authorization: Bearer` (ไม่มี
   `X-Acting-Person` เหมือน Portal เพราะ scope ของ HR (`personnel:provision` ฯลฯ) ไม่ใช่ user context
   `personnel:self` ที่ต้องมี person_id ผูกอยู่)
6. access token ใกล้หมดอายุ (ภายใน 15 วินาที) → `authGate` refresh อัตโนมัติด้วย `refresh_token`
   (silent refresh) ถ้า Keycloak ส่ง `id_token` ใหม่มาด้วยตอน refresh จะตรวจ role `hr_officer` ซ้ำ
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

Reference lookups (org-unit/position picker) ยังไม่ทำเหมือน Portal เดิม — ช่อง `orgUnitId`/`positionId`
เป็น UUID พิมพ์เองเพราะ scope ของ client `hr-console` ไม่มี `personnel:read:basic` สำหรับดึงรายการ
org-unit/position มาทำ dropdown (การเพิ่ม scope เพื่อ dropdown เพิ่มเติมไม่ได้อยู่ใน MVP รอบนี้)

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
