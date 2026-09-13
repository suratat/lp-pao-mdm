const crypto = require('node:crypto');

// เรียก POST /internal/sessions/revoke ของ check.lp-pao.go.th (§0.5 ข้อ 7, seq-02 Phase A)
// ไม่ได้แก้โค้ดฝั่ง check (กฎข้อ 9 ของ CLAUDE.md) เพียงเรียก endpoint ที่กำหนดไว้ในสัญญาด้วย
// HMAC shared secret แบบเดียวกับ /internal/verify ที่มีอยู่แล้ว
function createCheckHttpClient({ baseUrl, sharedSecret }) {
  return {
    async revokeSessions(personId) {
      const body = JSON.stringify({ personId });
      const signature = crypto.createHmac('sha256', sharedSecret).update(body).digest('hex');
      const res = await fetch(`${baseUrl}/internal/sessions/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MDM-Signature': signature },
        body,
      });
      if (!res.ok) {
        throw new Error(`check session revoke failed: ${res.status}`);
      }
    },
  };
}

// สำหรับ dev/test: check.lp-pao.go.th ยังไม่มีในรีโปนี้ (เป็นอีกระบบ) จึงบันทึกการเรียกไว้แทนการยิงจริง
function createFakeCheckClient() {
  const calls = [];
  return {
    calls,
    async revokeSessions(personId) {
      calls.push({ personId, at: new Date() });
    },
  };
}

module.exports = { createCheckHttpClient, createFakeCheckClient };
