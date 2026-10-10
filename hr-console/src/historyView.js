const { escapeHtml } = require('./views/html');
const { PERSONNEL_TYPES } = require('./personnelTypes');
const { looksLikePid } = require('./pid');
const { formatThaiDateTime, formatThaiDate } = require('./thaiTime');

// แสดงประวัติการเปลี่ยนแปลงของบุคคล (GET /persons/{id}/history) ให้ HR อ่านรู้เรื่อง: ชื่อฟิลด์เป็นภาษาไทย, id หน่วยงาน/ตำแหน่งแปลงเป็นชื่อ
// ค่าของฟิลด์ชั้น CONFIDENTIAL ขึ้นไปถูก MDM API ปกปิดมาแล้ว (valuesHidden) แสดงเป็น "(ปกปิด)" - ที่นี่ไม่มีทางเห็นเลขบัตรและกรองซ้ำอีกชั้น
const FIELD_LABEL = {
  'employment.employee_no': 'เลขประจำตัว (เลขบัตรประชาชน)',
  'employment.personnel_type': 'ประเภทบุคลากร',
  'employment.position_id': 'ตำแหน่ง',
  'employment.org_unit_id': 'หน่วยงาน',
  'employment.level_code': 'ระดับ/ชั้น',
  'employment.appointed_date': 'วันบรรจุ',
  'employment.email_work': 'อีเมลที่ทำงาน',
  'employment.job_title_text': 'ชื่อตำแหน่ง/ลักษณะงาน',
  'contact.mobile_phone': 'มือถือ',
  'contact.phone_alt': 'โทรศัพท์สำรอง',
  'contact.email_personal': 'อีเมล',
  'contact.line_id': 'LINE ID',
  employment_status: 'สถานะการจ้างงาน',
  status: 'สถานะบุคคล',
  pid_hash: 'การเชื่อมเลขบัตรกับบุคคล',
  'person.expected_first_name_th': 'ชื่อที่ HR กรอก (รอยืนยัน ThaID)',
  'person.expected_last_name_th': 'นามสกุลที่ HR กรอก (รอยืนยัน ThaID)',
  'person.expected_birth_date': 'วันเกิดที่ HR กรอก (รอยืนยัน ThaID)',
};
const CHANGED_BY_LABEL = {
  THAID_SYNC: 'ระบบ (ThaID)',
  SELF: 'เจ้าของข้อมูล',
  HR: 'เจ้าหน้าที่ HR',
  HR_IMPORT: 'นำเข้าจากระบบ HR',
  ADMIN: 'ผู้ดูแลระบบ',
};
const STATUS_LABEL = { ACTIVE: 'ใช้งาน', PENDING_CLAIM: 'รอยืนยันตัวตน', INACTIVE: 'พ้นสภาพ' };
const PERSONNEL_TYPE_LABEL = Object.fromEntries(PERSONNEL_TYPES.map((t) => [t.value, t.label]));

function fieldLabel(key) {
  if (FIELD_LABEL[key]) return FIELD_LABEL[key];
  if (key.startsWith('identity.')) return `ข้อมูลจาก ThaID (${key})`;
  if (key.startsWith('contact.')) return `ข้อมูลติดต่อ (${key})`;
  if (key.startsWith('emergency_contact.')) return `ผู้ติดต่อฉุกเฉิน (${key})`;
  return key;
}

// lookups = { orgUnits: Map(id -> ชื่อ), positions: Map(id -> ชื่อ) }
function renderValue(entry, value, lookups) {
  if (entry.valuesHidden) return '<em>(ปกปิด)</em>';
  if (value === null || value === undefined) return '<em>(ไม่มีค่า)</em>';
  const key = entry.fieldKey;
  if (typeof value === 'string' && !looksLikePid(value)) {
    if (key === 'employment.org_unit_id') return escapeHtml(lookups.orgUnits.get(value) || value);
    if (key === 'employment.position_id') return escapeHtml(lookups.positions.get(value) || value);
    if (key === 'employment.personnel_type') return escapeHtml(PERSONNEL_TYPE_LABEL[value] || value);
    if (key === 'status') return escapeHtml(STATUS_LABEL[value] || value);
  }
  // ค่าที่เป็นวันที่ล้วน (วันบรรจุ วันเกิดที่ HR กรอก ฯลฯ) แสดงเป็น พ.ศ. ไม่ผ่าน Date
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return escapeHtml(formatThaiDate(value));
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // ชั้นที่สอง: ค่าที่ดูเหมือนเลขบัตรไม่แสดง (API ปกปิดมาแล้ว ที่นี่กันไว้อีกชั้น)
  return looksLikePid(text) ? '<em>(ปกปิด)</em>' : escapeHtml(text);
}

const fmt = formatThaiDateTime;

function renderHistory({ entries, nextCursor, personId, lookups }) {
  const rows = entries
    .map(
      (e) => `<tr>
        <td>${escapeHtml(fmt(e.changedAt))}</td>
        <td>${escapeHtml(fieldLabel(e.fieldKey))}</td>
        <td>${renderValue(e, e.oldValue, lookups)}</td>
        <td>${renderValue(e, e.newValue, lookups)}</td>
        <td>${escapeHtml(CHANGED_BY_LABEL[e.changedBy] || e.changedBy || '-')}<br><span class="hint">${e.actorSub ? escapeHtml(e.actorSub) : 'ไม่ทราบผู้กระทำ (ก่อนบันทึกผู้กระทำ)'}</span></td>
        <td>${e.reason ? escapeHtml(looksLikePid(e.reason) ? '(ปกปิด)' : e.reason) : '-'}</td>
      </tr>`
    )
    .join('\n');
  const more = nextCursor
    ? `<p><a href="/hr/persons/${encodeURIComponent(personId)}?historyCursor=${encodeURIComponent(nextCursor)}#history">ประวัติรุ่นเก่ากว่านี้</a></p>`
    : '';
  return `<table class="history">
    <tr><th>เมื่อ</th><th>ฟิลด์</th><th>ค่าเดิม</th><th>ค่าใหม่</th><th>โดย</th><th>เหตุผล</th></tr>
    ${rows || '<tr><td colspan="6">ยังไม่มีประวัติ</td></tr>'}
  </table>${more}`;
}

module.exports = { renderHistory, fieldLabel, CHANGED_BY_LABEL };
