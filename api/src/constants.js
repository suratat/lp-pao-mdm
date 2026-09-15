// FIXTURE_PERSON_ID: ต้องมีอยู่จริงใน DB (สร้างโดย api/test/fixtures.js#insertFixturePerson ใน
// globalSetup) เพื่อให้ access_log middleware เขียนแถวได้จริงโดยไม่ชน FK - org_unit/position ของ fixture
// นี้สร้างขึ้นเองแบบสุ่มต่อการรัน test (ไม่ผูกกับ org_unit ที่ seed จริงใน migration ใด ๆ) เพื่อไม่ให้ test
// พังเมื่อโครงสร้างส่วนราชการจริงเปลี่ยนแปลง
const FIXTURE_PERSON_ID = '11111111-1111-1111-1111-111111111111';

module.exports = {
  FIXTURE_PERSON_ID,
};
