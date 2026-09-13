// แปลงวันที่จากไฟล์ HR เดิมเป็น ISO (ค.ศ.) ตาม §5.4 "แปลง พ.ศ. → ค.ศ." - รูปแบบไฟล์จริงยังไม่ยืนยัน
// (ภาคผนวก ง ข้อ 2) รองรับ 2 รูปแบบที่พบทั่วไปในระบบราชการไทย: DD/MM/YYYY และ YYYY-MM-DD
// ปีตรวจแบบอัตโนมัติ: >= 2400 ถือเป็น พ.ศ. (ลบ 543), น้อยกว่านั้นถือว่าเป็น ค.ศ. อยู่แล้ว (ไม่แปลงซ้ำ)
// เพื่อไม่ให้ไฟล์ที่บันทึกเป็น ค.ศ. อยู่แล้วผิดเพี้ยน
const BUDDHIST_ERA_THRESHOLD = 2400;
const BUDDHIST_TO_GREGORIAN_OFFSET = 543;
const MIN_REASONABLE_YEAR = 1900;

function toGregorianYear(year) {
  return year >= BUDDHIST_ERA_THRESHOLD ? year - BUDDHIST_TO_GREGORIAN_OFFSET : year;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
}

// คืน { isoDate: 'YYYY-MM-DD' } หรือ { error: 'DATE_FORMAT_INVALID' | 'DATE_OUT_OF_RANGE' }
function convertToIsoDate(raw) {
  if (raw === null || raw === undefined) return { error: 'DATE_FORMAT_INVALID' };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { error: 'DATE_FORMAT_INVALID' };

  let year;
  let month;
  let day;

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // DD/MM/YYYY
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // YYYY-MM-DD

  if (slashMatch) {
    day = Number(slashMatch[1]);
    month = Number(slashMatch[2]);
    year = Number(slashMatch[3]);
  } else if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    return { error: 'DATE_FORMAT_INVALID' };
  }

  const gregorianYear = toGregorianYear(year);
  const nextYear = new Date().getFullYear() + 1;
  if (gregorianYear < MIN_REASONABLE_YEAR || gregorianYear > nextYear) {
    return { error: 'DATE_OUT_OF_RANGE' };
  }
  if (!isValidCalendarDate(gregorianYear, month, day)) {
    return { error: 'DATE_FORMAT_INVALID' };
  }

  return { isoDate: `${gregorianYear}-${pad2(month)}-${pad2(day)}` };
}

module.exports = { convertToIsoDate, toGregorianYear };
