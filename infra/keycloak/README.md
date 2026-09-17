# realm-export.json — ข้อควรระวัง

- **`description` ของ client ต้องไม่เกิน 255 ตัวอักษร** (Keycloak DB column limit) ถ้าเกิน `--import-realm` จะ fail แบบสุ่ม (error message ไม่ชัดเจนว่าสาเหตุคืออะไร) เจอครั้งแรกกับ `mdm-portal` เมื่อ 2026-09-17 — เช็คความยาวก่อน commit ทุกครั้งที่แก้ description
- `defaultDefaultClientScopes` / `defaultOptionalClientScopes` ต้องมีที่ระดับ realm (แม้เป็น `[]`) ไม่งั้น Keycloak internal validation error ตอน import

## Keycloak persistent mode (`docker-compose.keycloak.yml`) — สาเหตุที่เคยพบ

รวม 3 เรื่องที่เคยทำให้ persistent mode ใช้งานไม่ได้ (เจอระหว่าง T6, 2026-09-17):

1. **client `description` เกิน 255 ตัวอักษร** — ดูหัวข้อด้านบน (`realm-export.json`)
2. **ต้องใช้ image `quay.io/keycloak/keycloak:26.0` ไม่ใช่ `25.0`** — พบว่าเมื่อรันด้วย 25.0 บน database สะอาด (fresh drop/create) พร้อม `KC_BOOTSTRAP_ADMIN_USERNAME`/`KC_BOOTSTRAP_ADMIN_PASSWORD` ตั้งค่าถูกต้อง Keycloak **ไม่สร้าง bootstrap admin user เลย** (ตรวจด้วย `SELECT username FROM user_entity;` ได้ 0 rows, ไม่มี error/warning ใน log) ลองซ้ำหลายรอบได้ผลเหมือนเดิม พอเปลี่ยนเป็น 26.0 ด้วย database fresh เดียวกันทุกประการ bootstrap admin สร้างสำเร็จทันที — เป็นแค่ observation จากการทดสอบซ้ำในสภาพแวดล้อมนี้เท่านั้น **ไม่ได้ยืนยันว่าเป็น known bug ของ Keycloak อย่างเป็นทางการ** ถ้าจะลองเปลี่ยนกลับไปใช้ 25.0 ในอนาคต ต้องทดสอบ bootstrap admin ซ้ำก่อนเสมอ
3. **ต้องมี `--cache=local` ใน command** — ไม่งั้นเจอ Infinispan cluster false-positive ("new cluster view") ที่ทำให้ container shutdown ตัวเอง (ดู comment ใน `docker-compose.keycloak.yml`)
