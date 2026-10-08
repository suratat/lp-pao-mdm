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

module.exports = { formatThaiDateTime, toThaiInputValue, thaiInputToIso, THAI_MONTHS, TIME_ZONE };
