// ไม่เพิ่ม template engine ใหม่ (ejs/pug ไม่มีในรายการ dependency ที่อนุมัติ) - render ด้วย string
// literal ธรรมดา ต้อง escape เองทุกจุดที่แทรกข้อมูลที่มาจาก MDM API/ผู้ใช้ (แนวทางเดียวกับ hr-console/portal)
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title, bodyHtml, { displayName } = {}) {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} - DPO Console</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    nav a { margin-right: 1rem; }
    nav .who { float: right; color: #555; }
    label { display: block; margin-top: 0.75rem; font-weight: 600; }
    input, select, textarea { width: 100%; padding: 0.4rem; box-sizing: border-box; }
    .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.5rem 1rem; align-items: end; }
    .filters > div { display: flex; flex-direction: column; }
    .filters label { margin-top: 0; }
    .error { color: #b00020; }
    .ok { color: #1a7a2e; }
    .hint { color: #666; font-size: 0.85em; font-weight: normal; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.9em; }
    td, th { border: 1px solid #ccc; padding: 0.35rem; text-align: left; vertical-align: top; word-break: break-word; }
    .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 0.75rem; font-size: 0.85em; background: #eee; }
    .badge-service { background: #e2e3ff; }
    .badge-user { background: #dff5e1; }
  </style>
</head>
<body>
  <nav>
    <a href="/dpo/access-logs">Access Log</a>
    <a href="/auth/logout">ออกจากระบบ</a>
    ${displayName ? `<span class="who">${escapeHtml(displayName)}</span>` : ''}
  </nav>
  <hr />
  ${bodyHtml}
</body>
</html>`;
}

module.exports = { escapeHtml, layout };
