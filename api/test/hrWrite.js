// PR-D1: endpoint เขียนข้อมูลบุคคลด้วยมือ (POST /persons, PUT /persons/{id}/employment, POST .../deactivate|reactivate) ต้องมี realm role
// hr_master_data_admin และ `reason` ทุกครั้ง; POST /sync/hr/employment-batch ต้องมี `reason` ระดับ batch (ไม่ต้องมี role)
// เทสต์เดิมจำนวนมากไม่ได้ทดสอบเรื่องนี้โดยตรง - helper นี้เติมค่าเริ่มต้นให้ (role + reason) เพื่อไม่ต้องแก้ทุกจุดเรียก ส่วนการบังคับใช้จริง
// (role/เหตุผลว่าง/มีเลข 13 หลัก/ผู้เรียกที่ไม่มี role) ทดสอบแยกที่ test/hrWriteContract.test.js ซึ่งไม่ใช้ helper นี้
const HR_WRITE_ROLE = 'hr_master_data_admin';
const DEFAULT_REASON = 'ทดสอบระบบ (เหตุผลสมมติ)';

const MANUAL_WRITE = [
  ['post', /^\/persons$/],
  ['put', /^\/persons\/[^/]+\/employment$/],
  ['post', /^\/persons\/[^/]+\/(deactivate|reactivate)$/],
];
const BATCH_IMPORT = ['post', /^\/sync\/hr\/employment-batch$/];

const matches = ([m, re], method, url) => m === method.toLowerCase() && re.test(url.split('?')[0].replace(/^\/api\/v1/, ''));

function isManualWrite(method, url) {
  return MANUAL_WRITE.some((rule) => matches(rule, method, url));
}

// roles ที่ต้องใส่ใน token (undefined = ไม่ต้อง)
function rolesFor(method, url) {
  return isManualWrite(method, url) ? [HR_WRITE_ROLE] : undefined;
}

// เติม reason ถ้า body เป็น object และยังไม่มี reason (ไม่แตะ body ที่ตั้งใจส่งแบบอื่น เช่น array/สตริง)
function withDefaultReason(method, url, body) {
  const needs = isManualWrite(method, url) || matches(BATCH_IMPORT, method, url);
  if (!needs || !body || typeof body !== 'object' || Array.isArray(body) || 'reason' in body) return body;
  return { ...body, reason: DEFAULT_REASON };
}

module.exports = { HR_WRITE_ROLE, DEFAULT_REASON, rolesFor, withDefaultReason, isManualWrite };
