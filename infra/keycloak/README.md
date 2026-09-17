# realm-export.json — ข้อควรระวัง

- **`description` ของ client ต้องไม่เกิน 255 ตัวอักษร** (Keycloak DB column limit) ถ้าเกิน `--import-realm` จะ fail แบบสุ่ม (error message ไม่ชัดเจนว่าสาเหตุคืออะไร) เจอครั้งแรกกับ `mdm-portal` เมื่อ 2026-09-17 — เช็คความยาวก่อน commit ทุกครั้งที่แก้ description
- `defaultDefaultClientScopes` / `defaultOptionalClientScopes` ต้องมีที่ระดับ realm (แม้เป็น `[]`) ไม่งั้น Keycloak internal validation error ตอน import
