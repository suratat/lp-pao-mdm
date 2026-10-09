const { HttpProblem } = require('../security/httpProblem');
const { SCOPE_READ_INACTIVE } = require('../constants');

// endpoint อ่านข้อมูลรายบุคคล: ถ้าบุคคลเป็น INACTIVE (ลาออก/โอนย้าย) ต้องมี personnel:read:inactive เหมือน GET /persons?status=INACTIVE
// ตอบ 403 insufficient-scope (ก่อนเข้า handler จึงไม่เขียน access_log และไม่ถอดรหัสอะไร) ส่วนบุคคลที่ไม่มีอยู่ปล่อยให้ handler ตอบ 404 ตามเดิม
// query เดียวต่อคำขอ ผลเก็บใน req.personStatus ให้ handler ใช้ต่อได้ ต้องวางหลัง requireScope()/requireRole() เสมอ
// เจตนา: ไม่ครอบ endpoint เขียน (deactivate/reactivate ฯลฯ) และ /me (เจ้าของข้อมูลดูของตนเอง)
function requireInactiveScope(pool) {
  return async function (req, res, next) {
    try {
      const { rows } = await pool.query('SELECT status FROM mdm.person WHERE person_id = $1', [req.params.personId]);
      req.personStatus = rows[0]?.status;
      if (req.personStatus === 'INACTIVE' && !(req.auth?.scope || []).includes(SCOPE_READ_INACTIVE)) {
        return next(
          new HttpProblem(403, 'insufficient-scope', 'สิทธิ์ไม่เพียงพอ', `ต้องมี scope "${SCOPE_READ_INACTIVE}" เพื่อดูข้อมูลบุคคลสถานะ INACTIVE`)
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireInactiveScope };
