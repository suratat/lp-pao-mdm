// ค่าคงที่สำหรับ T2 skeleton: personId/orgUnitId/positionId นี้ต้องมีอยู่จริงใน DB (seed จาก T1 + fixture ของ T2)
// เพื่อให้ access_log middleware เขียนแถวได้จริงโดยไม่ชน FK - endpoint จริงใน T3-T5 จะแทนที่ค่าคงที่เหล่านี้
// ด้วยการค้นจาก DB ตาม personId ที่ผู้เรียกส่งมา
const FIXTURE_PERSON_ID = '11111111-1111-1111-1111-111111111111';
const FIXTURE_ORG_UNIT_ID = '00000000-0000-0000-0000-000000000003'; // seed T1: ฝ่ายบริหารงานทั่วไป
const FIXTURE_PARENT_ORG_UNIT_ID = '00000000-0000-0000-0000-000000000002'; // seed T1: กองการเจ้าหน้าที่
const FIXTURE_POSITION_ID = '00000000-0000-0000-0000-000000000102'; // seed T1: นักทรัพยากรบุคคลชำนาญการ

module.exports = {
  FIXTURE_PERSON_ID,
  FIXTURE_ORG_UNIT_ID,
  FIXTURE_PARENT_ORG_UNIT_ID,
  FIXTURE_POSITION_ID,
};
