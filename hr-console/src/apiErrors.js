const { escapeHtml } = require('./views/html');
const { MdmApiError } = require('./mdmClient');

// แปลง error ของ MDM API (403/404/409/422/400) เป็นข้อความภาษาไทยที่ผู้ใช้เข้าใจและแก้ได้ - ใช้ `problem.type` (ส่วนท้ายของ URI) เป็นหลัก
// ไม่สะท้อนค่าที่ผู้ใช้กรอกกลับไป (กฎข้อ 1: ห้ามเลขบัตรใน error) และไม่แสดงรายละเอียดภายในของระบบ
const MESSAGES = {
  'insufficient-role': 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (ต้องมี role hr_master_data_admin) กรุณาติดต่อผู้ดูแลระบบ',
  'insufficient-scope': 'สิทธิ์ใน token ไม่เพียงพอ กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ ถ้ายังเป็นอยู่ให้ติดต่อผู้ดูแลระบบ',
  'version-conflict': 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่น (หรือระบบ) ระหว่างที่คุณเปิดหน้านี้ ไม่ได้บันทึกอะไร กรุณาโหลดข้อมูลล่าสุดแล้วทำรายการอีกครั้ง',
  'duplicate-pid': 'มีบุคคลที่ใช้เลขบัตรประชาชนนี้อยู่ในระบบแล้ว',
  'invalid-pid': 'เลขบัตรประชาชนไม่ถูกต้อง (ไม่ผ่านการตรวจหลักสุดท้าย)',
  'reason-required': 'กรุณาระบุเหตุผล',
  'reason-too-long': 'เหตุผลยาวเกินไป',
  'reason-contains-pid': 'เหตุผลห้ามมีเลขบัตรประชาชน 13 หลัก',
  'reference-document-contains-pid': 'เลขที่คำสั่งห้ามมีเลขบัตรประชาชน 13 หลัก',
  'birth-date-out-of-range': 'วันเกิดไม่ถูกต้อง (ต้องอยู่ระหว่าง 1900-01-01 ถึงวันนี้)',
  'effective-from-before-current': 'วันที่มีผลต้องไม่ก่อนวันที่มีผลของข้อมูลการจ้างปัจจุบัน',
  'employee-no-required': 'ไม่พบข้อมูลการจ้างเดิมของบุคคลนี้',
  'employee-no-conflict': 'เลขบัตรประชาชนนี้ถูกใช้กับบุคลากรอื่นที่ยังปฏิบัติงานอยู่แล้ว',
  'org-unit-invalid': 'ไม่พบหน่วยงานที่เลือก หรือหน่วยงานถูกปิดใช้งานแล้ว',
  'position-invalid': 'ไม่พบตำแหน่งที่เลือก',
  'position-occupied': 'ตำแหน่งนี้มีผู้ครองอยู่แล้วในช่วงเวลาที่ระบุ',
  'personnel-type-invalid': 'ประเภทบุคลากรไม่ถูกต้อง',
  'position-not-allowed': 'ประเภทบุคลากรนี้ไม่มีเลขที่ตำแหน่ง ห้ามระบุตำแหน่ง',
  'position-required': 'ประเภทบุคลากรนี้ต้องระบุเลขที่ตำแหน่ง',
  'job-title-not-allowed': 'ประเภทบุคลากรนี้ต้องใช้เลขที่ตำแหน่ง ห้ามระบุชื่อตำแหน่ง/ลักษณะงานแบบข้อความ',
  'position-and-job-title-conflict': 'เลือกได้อย่างใดอย่างหนึ่งระหว่างตำแหน่งกับชื่อตำแหน่ง/ลักษณะงาน',
  'job-title-contains-pid': 'ชื่อตำแหน่ง/ลักษณะงานห้ามมีเลขบัตรประชาชน 13 หลัก',
  'job-title-too-long': 'ชื่อตำแหน่ง/ลักษณะงานยาวเกินไป',
  'already-inactive': 'บุคคลนี้พ้นสภาพไปแล้ว',
  'not-found': 'ไม่พบข้อมูลที่ต้องการ (อาจถูกลบหรือไม่มีอยู่)',
};

function problemType(err) {
  return String(err?.problem?.type || '').split('/').pop();
}

// คืนข้อความไทยสำหรับ error ของ API (MdmApiError) - ถ้าไม่รู้จัก type: ใช้ detail ของ API เมื่อเป็นภาษาไทย ไม่งั้นข้อความกลางๆ
function messageFor(err) {
  const type = problemType(err);
  if (MESSAGES[type]) return MESSAGES[type];
  if (err.status === 401) return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
  const detail = err.problem?.detail;
  if (typeof detail === 'string' && /[฀-๿]/.test(detail)) return detail;
  if (err.status === 400) return 'ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบแต่ละช่องแล้วลองใหม่';
  if (err.status === 403) return 'ไม่มีสิทธิ์ทำรายการนี้';
  if (err.status === 404) return MESSAGES['not-found'];
  if (err.status === 409) return 'ทำรายการไม่ได้เพราะข้อมูลขัดแย้งกับสถานะปัจจุบัน กรุณาโหลดข้อมูลล่าสุดแล้วลองใหม่';
  if (err.status === 422) return 'ข้อมูลไม่ผ่านการตรวจสอบของระบบ กรุณาตรวจสอบแล้วลองใหม่';
  return 'ระบบ MDM ขัดข้อง กรุณาลองใหม่อีกครั้งภายหลัง';
}

const isVersionConflict = (err) => err instanceof MdmApiError && problemType(err) === 'version-conflict';

// ผู้ใช้ทำให้ผิดพลาดที่แก้ได้ (4xx ที่ไม่ใช่ 401/429) หรือระบบ/เครือข่ายขัดข้อง (5xx, fetch ล้มเหลว) -> หน้าไทยทั้งคู่ ไม่ให้เป็นหน้า 500 ว่างๆ
function statusFor(err) {
  if (err instanceof MdmApiError) return err.status >= 400 && err.status < 500 ? err.status : 502;
  return 502;
}

function failureMessage(err) {
  if (err instanceof MdmApiError) return messageFor(err);
  return 'เชื่อมต่อระบบ MDM ไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้งภายหลัง';
}

// ส่วน HTML ของข้อผิดพลาด: ข้อความไทย + (ถ้าเป็น version-conflict) ปุ่ม "โหลดข้อมูลล่าสุด" ไปที่ reloadUrl
function renderFailure(err, { reloadUrl, backUrl, backLabel = 'ย้อนกลับ' } = {}) {
  const conflict = isVersionConflict(err) && reloadUrl;
  return `<p class="error">${escapeHtml(failureMessage(err))}</p>
    <p>${conflict ? `<a class="button" href="${escapeHtml(reloadUrl)}"><strong>โหลดข้อมูลล่าสุด</strong></a> ` : ''}${backUrl ? `<a href="${escapeHtml(backUrl)}">${escapeHtml(backLabel)}</a>` : ''}</p>`;
}

// fetch ล้มเหลว (เครือข่าย/MDM ล่ม) - ต่างจาก bug ของโค้ดเราเอง (TypeError อื่นๆ ต้องไม่ถูกกลบเป็น "เชื่อมต่อไม่ได้")
const isRemoteFailure = (err) => err instanceof MdmApiError || (err?.name === 'TypeError' && /fetch failed/i.test(String(err.message)));

module.exports = { isRemoteFailure, messageFor, failureMessage, isVersionConflict, statusFor, renderFailure, problemType };
