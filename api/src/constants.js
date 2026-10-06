// FIXTURE_PERSON_ID: ต้องมีอยู่จริงใน DB (สร้างโดย api/test/fixtures.js#insertFixturePerson ใน
// globalSetup) เพื่อให้ access_log middleware เขียนแถวได้จริงโดยไม่ชน FK - org_unit/position ของ fixture
// นี้สร้างขึ้นเองแบบสุ่มต่อการรัน test (ไม่ผูกกับ org_unit ที่ seed จริงใน migration ใด ๆ) เพื่อไม่ให้ test
// พังเมื่อโครงสร้างส่วนราชการจริงเปลี่ยนแปลง
const FIXTURE_PERSON_ID = '11111111-1111-1111-1111-111111111111';

// realm role ที่ใช้เขียนข้อมูลบุคคลด้วยมือผ่าน hr-console (สร้าง/ย้ายตำแหน่ง/พ้นสภาพ/คืนสภาพ ฯลฯ) และ master data หน่วยงาน/ตำแหน่ง
// MDM API ตรวจ role นี้จาก access token ทุก request (scope ใน token ไม่ใช่ตัวกั้นสิทธิ์ - ดู infra/keycloak/README.md)
const MASTER_DATA_ADMIN_ROLE = 'hr_master_data_admin';

module.exports = {
  FIXTURE_PERSON_ID,
  MASTER_DATA_ADMIN_ROLE,
};
