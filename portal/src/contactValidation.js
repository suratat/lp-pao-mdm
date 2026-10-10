// กติกาตรวจอีเมล/เบอร์โทรของข้อมูลติดต่อ - ไฟล์นี้มีสำเนา "ที่ต้องเหมือนกันทุกตัว" ใน 3 workspace:
//   api/src/security/contactValidation.js, portal/src/contactValidation.js, hr-console/src/contactValidation.js (และ emailCheck.js, contactFormUi.js ใน portal/hr-console)
// (Dockerfile ของแต่ละ workspace COPY เฉพาะโฟลเดอร์ตัวเอง จึงใช้ไฟล์ร่วมกันไม่ได้) แก้ที่หนึ่งต้องแก้ครบทั้งสาม
// มีเทสต์ api/test/contactValidationCopies.test.js เทียบเนื้อไฟล์ให้ ถ้าไม่ตรงกันเทสต์จะล้ม
// ตัวตัดสินสุดท้ายคือ API; portal/hr-console ใช้ตรวจซ้ำเพื่อให้ข้อความเร็วขึ้น และ portal/hr-console ฝังไฟล์นี้ลงหน้าเว็บให้ browser
// ตรวจด้วยกติกาเดียวกัน ดังนั้นห้ามใช้ require/import และห้ามพึ่งสิ่งที่ไม่มีใน browser
// ไม่ log ค่าที่ตรวจ (อีเมล/เบอร์โทรเป็นข้อมูลส่วนบุคคล)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContactRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const EMAIL_MAX = 254;
  const LOCAL_MAX = 64;
  const EMAIL_MESSAGE = 'รูปแบบอีเมลไม่ถูกต้อง ตัวอย่างที่ถูก: name@example.com';
  const MOBILE_MESSAGE = 'เบอร์มือถือไม่ถูกต้อง ต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 06, 08 หรือ 09 เช่น 0812345678';
  const PHONE_ALT_MESSAGE =
    'โทรศัพท์สำรองไม่ถูกต้อง ต้องเป็นมือถือ 10 หลักขึ้นต้นด้วย 06, 08 หรือ 09 (เช่น 0812345678) หรือโทรศัพท์บ้าน/สำนักงาน 9 หลักขึ้นต้นด้วย 02, 03, 04, 05 หรือ 07 (เช่น 054123456)';

  const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

  // คืน { ok: true, value } (value = อีเมลที่ trim แล้ว หรือ null เมื่อว่าง) หรือ { ok: false, message }
  function validateEmail(raw) {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: EMAIL_MESSAGE };
    const value = raw.trim();
    if (value === '') return { ok: true, value: null };
    if (value.length > EMAIL_MAX) return { ok: false, message: 'อีเมลยาวเกิน ' + EMAIL_MAX + ' ตัวอักษร' };
    if (/\s/.test(value)) return { ok: false, message: 'อีเมลต้องไม่มีช่องว่าง' };
    const parts = value.split('@');
    if (parts.length !== 2) return { ok: false, message: EMAIL_MESSAGE };
    const local = parts[0];
    const domain = parts[1];
    if (local === '' || local.length > LOCAL_MAX || !LOCAL_RE.test(local)) return { ok: false, message: EMAIL_MESSAGE };
    if (domain.startsWith('[') || domain.endsWith(']')) return { ok: false, message: 'อีเมลต้องไม่ใช้ที่อยู่ IP เป็นโดเมน' };
    const labels = domain.split('.');
    if (labels.length < 2) return { ok: false, message: EMAIL_MESSAGE };
    if (!labels.every((l) => l.length >= 1 && l.length <= 63 && LABEL_RE.test(l))) return { ok: false, message: EMAIL_MESSAGE };
    const tld = labels[labels.length - 1];
    // TLD ที่เป็นตัวเลขล้วนคือรูปแบบ IP (เช่น a@192.168.0.1) และ TLD จริงยาวอย่างน้อย 2 ตัว
    if (/^[0-9]+$/.test(tld)) return { ok: false, message: 'อีเมลต้องไม่ใช้ที่อยู่ IP เป็นโดเมน' };
    if (tld.length < 2) return { ok: false, message: EMAIL_MESSAGE };
    return { ok: true, value };
  }

  // ตัดช่องว่าง ขีด วงเล็บ จุด แล้วแปลง +66 / 66 นำหน้าเป็น 0; คืนสตริงตัวเลขล้วน หรือ null ถ้ามีอักขระอื่นปน
  function normalizePhoneDigits(raw) {
    let s = String(raw).replace(/[\s\-().]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    else if (!(s.startsWith('66') && s.length >= 10)) return /^[0-9]*$/.test(s) ? s : null;
    if (!/^[0-9]*$/.test(s)) return null;
    // เข้าที่นี่เมื่อมี + นำหน้า หรือขึ้นต้น 66 และยาว >= 10 (เลขไทย 0xxxxxxxxx ไม่มีทางขึ้นต้น 66)
    return s.startsWith('66') ? '0' + s.slice(2) : s;
  }

  const MOBILE_RE = /^0[689][0-9]{8}$/;
  const LANDLINE_RE = /^0[23457][0-9]{7}$/;

  function validatePhone(raw, allowLandline, message) {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message };
    if (raw.trim() === '') return { ok: true, value: null };
    const digits = normalizePhoneDigits(raw);
    if (digits === null) return { ok: false, message };
    if (MOBILE_RE.test(digits) || (allowLandline && LANDLINE_RE.test(digits))) return { ok: true, value: digits };
    return { ok: false, message };
  }

  // "มือถือ": 10 หลัก ขึ้นต้น 06/08/09
  function validateMobile(raw) {
    return validatePhone(raw, false, MOBILE_MESSAGE);
  }

  // "โทรศัพท์สำรอง": มือถือ (กฎเดียวกัน) หรือโทรศัพท์บ้าน/สำนักงาน 9 หลักขึ้นต้น 02/03/04/05/07
  function validatePhoneAlt(raw) {
    return validatePhone(raw, true, PHONE_ALT_MESSAGE);
  }

  return { validateEmail, validateMobile, validatePhoneAlt, normalizePhoneDigits, EMAIL_MAX };
});
