// FIXTURE_PERSON_ID: ต้องมีอยู่จริงใน DB (สร้างโดย api/test/fixtures.js#insertFixturePerson ใน
// globalSetup) เพื่อให้ access_log middleware เขียนแถวได้จริงโดยไม่ชน FK - org_unit/position ของ fixture
// นี้สร้างขึ้นเองแบบสุ่มต่อการรัน test (ไม่ผูกกับ org_unit ที่ seed จริงใน migration ใด ๆ) เพื่อไม่ให้ test
// พังเมื่อโครงสร้างส่วนราชการจริงเปลี่ยนแปลง
const FIXTURE_PERSON_ID = '11111111-1111-1111-1111-111111111111';

// realm role ที่ใช้เขียนข้อมูลบุคคลด้วยมือผ่าน hr-console (สร้าง/ย้ายตำแหน่ง/พ้นสภาพ/คืนสภาพ ฯลฯ) และ master data หน่วยงาน/ตำแหน่ง
// MDM API ตรวจ role นี้จาก access token ทุก request (scope ใน token ไม่ใช่ตัวกั้นสิทธิ์ - ดู infra/keycloak/README.md)
const MASTER_DATA_ADMIN_ROLE = 'hr_master_data_admin';

// scope ของ endpoint จัดการข้อมูลบุคคลโดย HR (PR-D2: manage-profile, expected-identity, contact, emergency-contacts, history) - ไม่ผูกกับ field ใดใน
// response ของ Person (คนละเรื่องกับ personnel:read:contact) ใช้คู่กับ realm role hr_master_data_admin เสมอ
const SCOPE_MANAGE_PERSON = 'personnel:manage:person';
// role ของเจ้าหน้าที่ HR ทั่วไปที่ล็อกอิน hr-console (ยังไม่มีสิทธิ์ดูข้อมูลติดต่อส่วนตัว นอกจากจะมี MASTER_DATA_ADMIN_ROLE ด้วย)
const HR_OFFICER_ROLE = 'hr_officer';
// เห็นบุคคลสถานะ INACTIVE (ลาออก/โอนย้าย) ทั้งใน list และ endpoint รายบุคคล
const SCOPE_READ_INACTIVE = 'personnel:read:inactive';

module.exports = {
  FIXTURE_PERSON_ID,
  MASTER_DATA_ADMIN_ROLE,
  SCOPE_MANAGE_PERSON,
  HR_OFFICER_ROLE,
  SCOPE_READ_INACTIVE,
};
