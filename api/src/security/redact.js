// กฎข้อ 1 ของ CLAUDE.md: เลข 13 หลัก (รวมกรณีคั่นด้วยช่องว่าง/ขีด เช่น 1-2345-67890-12-3) ห้ามปรากฏในข้อความที่เก็บ/แสดง
const PID_LIKE = /\d(?:[ -]?\d){12}/g;
const REDACTED = '[ปกปิดเลข 13 หลัก]';

function redactPidText(text) {
  return typeof text === 'string' ? text.replace(PID_LIKE, REDACTED) : text;
}

// ใช้กับค่า JSON ใดๆ (string/number/array/object) - number ที่มี 13 หลักพอดีก็ถูกปกปิด
function redactPidDeep(value) {
  if (typeof value === 'string') return redactPidText(value);
  if (typeof value === 'number') return /^\d{13}$/.test(String(value)) ? REDACTED : value;
  if (Array.isArray(value)) return value.map(redactPidDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactPidDeep(v)]));
  }
  return value;
}

module.exports = { redactPidText, redactPidDeep, REDACTED };
