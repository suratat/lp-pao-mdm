// อ่าน scope จาก access token เพื่อ "ซ่อน/แสดงปุ่มและคอลัมน์" ใน UI เท่านั้น - ไม่ได้ตรวจลายเซ็น และไม่ใช่การตัดสินสิทธิ์
// (MDM API ตรวจ scope จาก token ซ้ำทุก request เสมอ ถ้า UI เข้าใจผิดอย่างมากสุดคือได้ 403 จาก API)
function decodeScopes(accessToken) {
  try {
    const payloadPart = String(accessToken || '').split('.')[1];
    if (!payloadPart) return new Set();
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    const scope = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    return new Set(scope);
  } catch {
    return new Set();
  }
}

module.exports = { decodeScopes };
