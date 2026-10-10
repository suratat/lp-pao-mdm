const { HttpProblem } = require('./httpProblem');
const { validateEmail, validateMobile, validatePhoneAlt } = require('./contactValidation');

// ตรวจข้อมูลติดต่อที่ส่งมาในคำขอ (PUT /me/contact, PATCH /persons/{id}/contact) ด้วยกติกาเดียวกันในที่เดียว
// - ตรวจเฉพาะฟิลด์ที่ "ส่งมา" และ "ต่างจากค่าที่เก็บไว้" (existingRow = แถว mdm.person_contact เดิมหรือ null):
//   ค่าเก่าที่ไม่ผ่านกติกาใหม่แต่ไม่ได้ถูกแก้ จะไม่ทำให้การบันทึกฟิลด์อื่นล้ม
// - คืน { key: ค่าที่ normalize แล้ว } เฉพาะฟิลด์ที่ตรวจ (เบอร์ = ตัวเลขล้วน, ว่าง = null); ไม่ผ่าน -> 422 invalid-contact
// - ห้ามใส่ค่าที่ตรวจลงใน error/log (มีแต่ชื่อฟิลด์กับข้อความ)
const RULES = [
  { key: 'mobilePhone', column: 'mobile_phone', label: 'มือถือ', validate: validateMobile },
  { key: 'phoneAlt', column: 'phone_alt', label: 'โทรศัพท์สำรอง', validate: validatePhoneAlt },
  { key: 'emailPersonal', column: 'email_personal', label: 'อีเมล', validate: validateEmail },
];

function validateContactFields(body, existingRow = null) {
  const normalized = {};
  const errors = [];
  for (const rule of RULES) {
    if (!(rule.key in body)) continue;
    const sent = body[rule.key];
    const stored = existingRow ? (existingRow[rule.column] ?? null) : null;
    if (sent === stored) continue; // ไม่ได้แก้ - ไม่ตรวจ ไม่ normalize
    const result = rule.validate(sent);
    if (!result.ok) errors.push({ field: rule.key, message: result.message });
    else normalized[rule.key] = result.value;
  }
  if (errors.length > 0) {
    throw new HttpProblem(422, 'invalid-contact', 'ข้อมูลติดต่อไม่ถูกต้อง', errors.map((e) => e.message).join(' | '), { errors });
  }
  return normalized;
}

module.exports = { validateContactFields };
