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

## ยังไม่ครอบคลุมในรอบนี้ (ตั้งใจ ไม่ใช่ลืม)

1. **การล็อกอินจริงผ่าน check.lp-pao.go.th** — เอกสารออกแบบไม่ได้ระบุ wire format ของ session/handoff
   ที่ check ออกให้ "app" ทั่วไป (ต่างจาก ThaID→check ที่มีรายละเอียดครบใน seq-01) และเป็นงานฝั่งรีโป check
   (ใกล้เคียง T7) ในรอบนี้ทำได้แค่ `session/devLogin.js` ซึ่ง**ปิดใช้งานอัตโนมัติเมื่อ `NODE_ENV=production`**
   (ตอบ 404/501) ใช้ได้เฉพาะ dev/test เพื่อทดสอบ self-service flow ทั้งหมดแบบ end-to-end
2. HR console และ DPO console (รอ scope ของ `mdm-portal` เพิ่มใน Keycloak และการตัดสินใจเรื่อง
   `hr_scope_org_units` ตาม §2.2 ข้อ 5)
3. Reference lookups (org-unit/position picker, area code picker สำหรับที่อยู่) - ฟอร์มที่อยู่ปัจจุบัน
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
