// ไม่เพิ่ม template engine ใหม่ (ejs/pug ไม่มีในรายการ dependency ที่อนุมัติ) - render ด้วย string
// literal ธรรมดา ต้อง escape เองทุกจุดที่แทรกข้อมูลที่มาจากผู้ใช้/ThaID
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// เมนู "ความยินยอม" ขึ้นกับ PORTAL_CONSENTS_ENABLED: layout() ไม่รู้ config จึงวาง placeholder ไว้ แล้ว
// middleware ใน app.js แทนด้วยลิงก์ (เปิด) หรือค่าว่าง (ปิด) ก่อนส่ง response
const NAV_CONSENTS_PLACEHOLDER = '<!--nav-consents-->';
const NAV_CONSENTS_LINK = '<a href="/portal/me/consents">ความยินยอม</a>';

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} - MDM Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    nav a { margin-right: 1rem; }
    label { display: block; margin-top: 0.75rem; font-weight: 600; }
    input, textarea { width: 100%; padding: 0.4rem; box-sizing: border-box; }
    .error { color: #b00020; }
    .ok { color: #1a7a2e; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    td, th { border: 1px solid #ccc; padding: 0.4rem; text-align: left; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <nav>
    <a href="/portal/me">ข้อมูลของฉัน</a>
    <a href="/portal/me/contact">ข้อมูลติดต่อ</a>
    <a href="/portal/me/emergency-contacts">ผู้ติดต่อฉุกเฉิน</a>
    ${NAV_CONSENTS_PLACEHOLDER}
    <a href="/portal/me/report-identity-issue">แจ้งข้อมูลผิด</a>
    <a href="/auth/logout">ออกจากระบบ</a>
  </nav>
  <hr />
  ${bodyHtml}
</body>
</html>`;
}

module.exports = { escapeHtml, layout, NAV_CONSENTS_PLACEHOLDER, NAV_CONSENTS_LINK };
