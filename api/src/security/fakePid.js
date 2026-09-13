// checksum mod 11 ตามภาคผนวก ข ของเอกสารออกแบบ - ใช้สร้าง pid ปลอมสำหรับตัวอย่าง response/คำขอทดสอบเท่านั้น
// ไม่ใช่เลขบัตรจริงของผู้ใดและ generate ขึ้นจากลำดับเลขคงที่ ไม่อ้างอิงบุคคลจริง
// helper makeFakePid() ตัวเต็ม (สุ่มได้หลายค่า) จะ implement ใน T3 พร้อม security/pid.js
function fakeChecksumPid(base = '123456789012') {
  const digits = base.split('').map(Number);
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0);
  const check = (11 - (sum % 11)) % 10;
  return `${base}${check}`;
}

module.exports = { fakeChecksumPid };
