const { HttpProblem } = require('../security/httpProblem');
const { positionRuleFor } = require('./personnelPositionRules');

// ชื่อตำแหน่ง/ลักษณะงาน (ข้อความอิสระ) - mdm.employment.job_title_text (varchar(255))
// กฎนี้แยกจาก personnelPositionRules ของ PR #34 (ไม่แก้กฎเดิม) แต่อ้างตารางกฎเลขที่ตำแหน่งเพื่อดูว่าประเภทไหนต้องมีตำแหน่ง:
//   ประเภท REQUIRED (ข้าราชการ/ครู/ลูกจ้างประจำ/ถ่ายโอน) -> ส่ง jobTitleText มาไม่ได้ (422 job-title-not-allowed)
//   ประเภท FORBIDDEN (พนักงานจ้าง 3 ประเภท/จ้างเหมารายบุคคล/ฝ่ายการเมือง) -> ใส่ได้ (ไม่บังคับ)
//   ประเภท OPTIONAL (OTHER) -> เลือกได้อย่างใดอย่างหนึ่ง: positionId หรือ jobTitleText หรือไม่ใส่เลย ทั้งสองอย่างพร้อมกัน = 422
//   position-and-job-title-conflict
const MAX_LENGTH = 255;

function jobTitleAllowedFor(personnelType) {
  return positionRuleFor(personnelType) !== 'REQUIRED';
}

function problem(status, type, title, detail, code) {
  const err = new HttpProblem(status, type, title, detail);
  err.code = code; // batch import เก็บ err.code ลงรายการ errors ของแถวนั้น
  return err;
}

// เลขบัตรประชาชน 13 หลัก ทั้งแบบติดกัน (1234567890123) และแบบมีขีด/เว้นวรรค/จุดคั่น (1-2345-67890-12-3) รวมเลขไทย/เลขเต็มความกว้าง -
// รวมกรณีเป็นส่วนหนึ่งของตัวเลขที่ยาวกว่า 13 หลัก (ปฏิเสธเสมอ ไม่ตรวจ checksum: ข้อความอิสระต้องไม่มีเลขที่ดูเหมือน pid เลย)
// ตัวเลขที่ถูกคั่นด้วยขีด/เว้นวรรคได้เพียงตัวเดียวระหว่างหลัก
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
function toAsciiDigits(text) {
  return text.replace(/[๐-๙０-９]/g, (ch) => {
    const thai = THAI_DIGITS.indexOf(ch);
    return thai >= 0 ? String(thai) : String(ch.charCodeAt(0) - 0xff10);
  });
}
const PID_LIKE = /\d(?:[\s\-.]?\d){12}/;

function looksLikePid(text) {
  return PID_LIKE.test(toAsciiDigits(text));
}

// รวมช่องว่างแนวนอน/ขึ้นบรรทัดใหม่ทุกแบบ (รวม NEL, LS, PS) เป็นช่องว่างเดียว แล้วตัด control characters (Cc) และ format characters
// (Cf: bidi เช่น U+202E/U+2066-2069, zero-width, BOM, soft hyphen) ทิ้ง - ทำก่อนตรวจเลขบัตร เพื่อกันการแทรกอักขระล่องหนคั่นหลัก
function normalizeJobTitleText(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw)
    .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

// คืนข้อความที่ normalize แล้ว (หรือ null) - โยน 422 (ไม่มีข้อความจริงใน error เพราะอาจมีข้อมูลส่วนบุคคล)
function validateJobTitleText(raw) {
  const text = normalizeJobTitleText(raw);
  if (text === null) return null;
  if ([...text].length > MAX_LENGTH) {
    throw problem(422, 'job-title-too-long', 'ชื่อตำแหน่ง/ลักษณะงานยาวเกินไป', `jobTitleText ต้องยาวไม่เกิน ${MAX_LENGTH} ตัวอักษร`, 'JOB_TITLE_TOO_LONG');
  }
  if (looksLikePid(text)) {
    throw problem(
      422,
      'job-title-contains-pid',
      'ชื่อตำแหน่ง/ลักษณะงานมีเลขประจำตัวประชาชน',
      'jobTitleText ห้ามมีตัวเลข 13 หลักที่เป็นเลขบัตรประชาชน (ทั้งแบบติดกันและแบบมีขีด/เว้นวรรค)',
      'JOB_TITLE_CONTAINS_PID'
    );
  }
  return text;
}

// ตรวจก่อนเขียน employment ทุกเส้นทาง (เรียกจาก closeAndOpenEmployment) - รับ jobTitleText ที่ validate แล้ว
function assertJobTitleMatchesPersonnelType(personnelType, positionId, jobTitleText) {
  if (jobTitleText === null || jobTitleText === undefined) return;
  const rule = positionRuleFor(personnelType);
  if (rule === 'REQUIRED') {
    throw problem(
      422,
      'job-title-not-allowed',
      'ประเภทบุคลากรนี้ไม่ใช้ชื่อตำแหน่ง/ลักษณะงานแบบข้อความ',
      `ประเภทบุคลากร ${personnelType} ต้องใช้เลขที่ตำแหน่ง (positionId) ห้ามระบุ jobTitleText`,
      'JOB_TITLE_NOT_ALLOWED'
    );
  }
  const hasPosition = positionId !== undefined && positionId !== null && positionId !== '';
  if (rule === 'OPTIONAL' && hasPosition) {
    throw problem(
      422,
      'position-and-job-title-conflict',
      'ระบุทั้งเลขที่ตำแหน่งและชื่อตำแหน่ง/ลักษณะงานพร้อมกันไม่ได้',
      `ประเภทบุคลากร ${personnelType} เลือกได้อย่างใดอย่างหนึ่งระหว่าง positionId กับ jobTitleText`,
      'POSITION_AND_JOB_TITLE_CONFLICT'
    );
  }
}

module.exports = {
  MAX_LENGTH,
  jobTitleAllowedFor,
  normalizeJobTitleText,
  looksLikePid,
  validateJobTitleText,
  assertJobTitleMatchesPersonnelType,
};
