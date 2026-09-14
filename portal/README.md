# MDM Portal (T9 รอบแรก — self-service)

Express app แยกจาก `api/` และ `worker/` คุยกับ MDM API ผ่าน HTTP เท่านั้น (ไม่แตะ Postgres โดยตรง)
ให้บุคลากรดูข้อมูลของตนเอง แก้ไขข้อมูลติดต่อ/ผู้ติดต่อฉุกเฉิน แจ้งข้อมูลระบุตัวตนผิด และจัดการ consent

## สถาปัตยกรรม auth (ทางเลือก B, §0.3)

- Portal ถือ Keycloak client `mdm-portal` (client credentials, scope `personnel:self`)
- ทุกครั้งที่เรียก MDM API จะแนบ `X-Acting-Person`: JWT อายุ ≤30 วินาที (HS256) ระบุ `sub = personId`
  ของผู้ใช้ที่กำลังทำ self-service อยู่ในเบราว์เซอร์ เซ็นด้วย `PORTAL_ACTING_ASSERTION_SECRET`
  (ต้องเป็นค่าเดียวกับที่ `api/` ตั้งไว้ - ดู `api/.env.example`)
- ฝั่ง MDM API (`api/src/middleware/auth.js`) ตรวจ assertion นี้เฉพาะเมื่อ `azp` ของ Bearer token
  อยู่ใน allowlist (`mdm-portal`) และ scope มี `personnel:self` เท่านั้น - client อื่นที่ถือ Bearer token
  ปกติ (ไม่มี `X-Acting-Person`) ไม่ได้รับผลกระทบ และถ้า deployment ไหนไม่ตั้ง secret ไว้ กลไกนี้ปิดเงียบ

## การล็อกอินจริงผ่าน check.lp-pao.go.th

`src/routes/authRoutes.js` + `src/security/checkAuthClient.js` implement flow เต็ม (ยืนยันกับโค้ดจริง
ของ check-app ที่เพิ่มไว้ตอน T7):

1. `GET /auth/login` → redirect ไป `check/login?client_id=&redirect_uri=` (`redirect_uri` ต้อง
   exact-match กับที่ลงทะเบียนไว้ใน check ของ Portal เป๊ะ ๆ)
2. `GET /auth/callback?token=` → เรียก `POST check/api/verify` (Basic auth ด้วย
   `CHECK_CLIENT_ID`/`CHECK_CLIENT_SECRET`, body `{token}`) แล้วอ่าน `person_id` จาก claims ที่ตอบกลับ
   (field ที่ไม่มีสิทธิ์ตาม `allowed_claims` จะหายไปเฉย ๆ ไม่ใช่ `null` - เช็คด้วย `!claims.person_id`)
3. ถ้ามี `person_id` → สร้าง session cookie เดิมของ Portal; ถ้าไม่มี หรือ verify ล้มเหลว
   (token หมดอายุ/ใช้ซ้ำ, client credential ผิด, เชื่อมต่อ check ไม่ได้) → แสดงหน้า error ภาษาไทยที่
   เหมาะกับสาเหตุ ไม่ crash และไม่ log token/secret/response body

ไม่ทำ CSRF `state` ของ Portal เอง เพราะ check ไม่ส่ง state กลับมาที่ app (เก็บไว้ฝั่ง check เอง ตาม
seq-01/R02) อาศัย `redirect_uri` exact-match + handoff token single-use อายุ 60 วิ ของ check แทน

ต้องตั้งค่า `CHECK_BASE_URL`, `CHECK_CLIENT_ID`, `CHECK_CLIENT_SECRET`, `PORTAL_AUTH_CALLBACK_URL`
ให้ครบทั้ง 4 ตัว (ดู `.env.example`) — **ยังไม่ได้ลงทะเบียน Portal ใน `ALLOWED_APPS` ของ check จริง**
(ต้องทำผ่าน `/admin/apps/new` ของ check เหมือนตอนสร้าง `mdm-test-personnel` ทดสอบ T7 — เป็นงาน ops
แยกจากรอบนี้) ถ้าไม่ตั้งค่าให้ครบ (dev/test) จะ fallback ไปใช้ `dev-login` stub เดิมทุกประการ ซึ่ง
**ปิดใช้งานอัตโนมัติเมื่อ `NODE_ENV=production`** (ตอบ 404) เพื่อกันไม่ให้กลายเป็นช่องโหว่จริง

## ยังไม่ครอบคลุมในรอบนี้ (ตั้งใจ ไม่ใช่ลืม)

1. HR console และ DPO console (รอ scope ของ `mdm-portal` เพิ่มใน Keycloak และการตัดสินใจเรื่อง
   `hr_scope_org_units` ตาม §2.2 ข้อ 5)
2. Reference lookups (org-unit/position picker, area code picker สำหรับที่อยู่) - ฟอร์มที่อยู่ปัจจุบัน
   รับเป็นข้อความอิสระ (`fullText`) และบ้านเลขที่เท่านั้น

## รันแบบ dev

```bash
cd portal && npm install
cp .env.example .env   # เติมค่าจริง (secret ต้องตรงกับของ api/)
npm start
```

จากนั้นเปิด `http://localhost:3100/auth/login` (dev-login เท่านั้น ไม่ใช่ของจริง)

## ทดสอบ

```bash
npm test
```

รัน MDM API จริง (`api/src/app.js`) บน loopback port ชั่วคราว + Postgres (Testcontainers ผ่าน
`db/docker-compose.yml` ตัวเดียวกับ `api/test`) แล้วให้ Portal คุยผ่าน HTTP จริงทุกประการ ยกเว้นข้ามการขอ
token จาก Keycloak จริง (ใช้ token ที่เซ็นด้วย local JWKS ของ `api/test/testJwks.js` แทน)
