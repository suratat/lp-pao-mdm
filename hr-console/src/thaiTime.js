// วันเวลาของ dpo-console: แสดงเป็นเวลาไทย (พ.ศ., เดือนไทยย่อ, 24 ชั่วโมง) เช่น "8 ต.ค. 2569 21:18:42"
// - แปลงตอนแสดงผลเท่านั้น (ข้อมูลใน DB/API ยังเป็น UTC timestamptz) ระบุ timeZone 'Asia/Bangkok' ตรงๆ ไม่พึ่ง TZ ของเครื่อง/container
// - ไม่พึ่งข้อมูล locale th-TH ของ ICU (บาง build ไม่มี): ดึงส่วนวันเวลาแบบ en-GB แล้วประกอบเอง
const TIME_ZONE = 'Asia/Bangkok';
const BANGKOK_OFFSET = '+07:00'; // ไทยไม่มี DST
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function bangkokParts(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(partsFormatter.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

// null/ว่าง/แปลงไม่ได้ -> "-"
function formatThaiDateTime(value) {
  const p = bangkokParts(value);
  if (!p) return '-';
  return `${Number(p.day)} ${THAI_MONTHS[Number(p.month) - 1]} ${Number(p.year) + 543} ${p.hour}:${p.minute}:${p.second}`;
}

// วันที่อย่างเดียว (YYYY-MM-DD เช่น วันเกิด วันที่มีผล) -> "8 ต.ค. 2569" แยกปี/เดือน/วันจากสตริงตรงๆ ไม่ผ่าน Date และไม่แปลงเขตเวลา (วันที่ไม่เลื่อนไม่ว่า TZ ไหน)
// null/ว่าง -> "-"; รูปแบบที่อ่านไม่ได้คืนค่าเดิมตามที่ได้รับ (ไม่ซ่อนข้อมูลผิดปกติ)
function formatThaiDate(value) {
  if (value === null || value === undefined || value === '') return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) return String(value);
  return `${Number(m[3])} ${THAI_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
}

// วันนี้ตามเวลาไทย (YYYY-MM-DD) - ค่าเริ่มต้นของช่องวันที่ และเพดานของวันเกิด
function todayBangkok(now = new Date()) {
  const p = bangkokParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

// ค่าสำหรับ <input type="datetime-local"> (เวลาไทย, ไม่มี timezone): "YYYY-MM-DDTHH:mm:ss"
// ค่าที่เป็นเวลาไทยอยู่แล้ว (ไม่มี timezone: ที่ผู้ใช้กรอกไว้) คืนตามเดิม; ค่าที่มี Z/offset (เช่น จากลิงก์ที่สร้างจาก UTC) แปลงเป็นเวลาไทย
function toThaiInputValue(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value.trim())) return value.trim().replace(' ', 'T');
  if (typeof value === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return '';
  const p = bangkokParts(value);
  return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` : '';
}

// ค่าจากช่องกรอก -> ISO UTC สำหรับส่ง API: ค่าที่ไม่มี timezone ("YYYY-MM-DDTHH:mm[:ss]" จาก datetime-local) ตีความเป็นเวลาไทย
// ค่าที่มี Z/offset อยู่แล้ว (เช่น accessedAt ที่ API ส่งมา) แปลงตรงๆ ไม่เสียความละเอียดมิลลิวินาที; ใช้ไม่ได้ -> undefined
function thaiInputToIso(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/.exec(v);
  const date = new Date(naive ? `${naive[1]}T${naive[2]}:${naive[3] || '00'}${BANGKOK_OFFSET}` : v);
  if (Number.isNaN(date.getTime())) return undefined;
  if (!naive && !/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return undefined; // รูปแบบอื่นที่ไม่มี timezone: ไม่เดา
  return date.toISOString();
}


// ---- เฉพาะ hr-console: ข้อความ พ.ศ. ใต้ช่อง <input type="date"> (ค่าที่ส่งยังเป็น YYYY-MM-DD ค.ศ. เหมือนเดิม) ----
// renderDateInput วาด input + <span class="be-date"> ที่มีข้อความตั้งต้นจากฝั่งเซิร์ฟเวอร์ (ปิด JS ก็เห็นค่าเดิม ฟอร์มใช้ได้ตามปกติ)
// BE_DATE_SCRIPT (ฝังใน layout ทุกหน้า) อัปเดตข้อความทันทีเมื่อเลือกวัน และสร้าง span ให้ input[type=date] ที่ไม่มี
function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderDateInput({ name, value = '', required = false, min, max }) {
  const hint = value ? formatThaiDate(value) : '';
  return `<input name="${escapeAttr(name)}" type="date"${required ? ' required' : ''}${min ? ` min="${escapeAttr(min)}"` : ''}${max ? ` max="${escapeAttr(max)}"` : ''} value="${escapeAttr(value)}" /><span class="be-date" data-for="${escapeAttr(name)}">${escapeAttr(hint)}</span>`;
}

const BE_DATE_SCRIPT = `<script>
(function () {
  var M = ${JSON.stringify(THAI_MONTHS)};
  function f(v) { var m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(v); return m ? Number(m[3]) + ' ' + M[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543) : ''; }
  document.querySelectorAll('input[type=date]').forEach(function (input) {
    var span = input.nextElementSibling;
    if (!span || !span.classList.contains('be-date')) {
      span = document.createElement('span');
      span.className = 'be-date';
      input.parentNode.insertBefore(span, input.nextSibling);
    }
    function update() { span.textContent = f(input.value); }
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    update();
  });
})();
</script>`;

module.exports = { todayBangkok, renderDateInput, BE_DATE_SCRIPT, formatThaiDateTime, formatThaiDate, toThaiInputValue, thaiInputToIso, THAI_MONTHS, TIME_ZONE };
