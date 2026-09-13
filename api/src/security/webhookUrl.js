const { HttpProblem } = require('./httpProblem');

// §2.3: "URL ต้องเป็น https และอยู่ในรายการ host ที่ผู้ดูแล MDM อนุญาต (ป้องกัน SSRF)"
// WEBHOOK_ALLOWED_HOSTS = รายชื่อ hostname คั่นด้วย , (ตรงตัวเท่านั้น ไม่รองรับ wildcard)
// ไม่ได้ทำ DNS resolution + block private-range เพิ่ม (defense-in-depth เพื่อกัน DNS rebinding) -
// เพราะ allow-list ทั้งหมดเป็นชื่อที่แอดมิน MDM อนุมัติไว้ล่วงหน้าอยู่แล้ว ถือเป็นขอบเขตที่ตัดไว้ของ T5
function getAllowedHosts() {
  return (process.env.WEBHOOK_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

function validateWebhookUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new HttpProblem(400, 'invalid-url', 'URL ไม่ถูกต้อง', undefined);
  }

  if (parsed.protocol !== 'https:') {
    throw new HttpProblem(400, 'https-required', 'URL ต้องเป็น https เท่านั้น', undefined);
  }

  const allowedHosts = getAllowedHosts();
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new HttpProblem(
      400,
      'host-not-allowed',
      'host ของ URL นี้ไม่อยู่ในรายการที่ผู้ดูแล MDM อนุญาต',
      'ติดต่อผู้ดูแล MDM เพื่อขอเพิ่ม host นี้ในรายการอนุญาต (ป้องกัน SSRF)'
    );
  }

  return parsed;
}

module.exports = { validateWebhookUrl, getAllowedHosts };
