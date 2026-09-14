// คุยกับ check.lp-pao.go.th ตาม contract จริง (POST /api/verify เท่านั้น - GET ตอบ 405):
// - GET /login?client_id=&redirect_uri= : redirect_uri ต้อง exact-match กับที่ลงทะเบียนไว้ใน check
// - POST /api/verify : Basic auth (client_id/client_secret), body {token}, คืน flat object เฉพาะ
//   field ที่อยู่ใน allowed_claims ของ app นี้ - field ที่ไม่มีสิทธิ์จะ "หายไปเฉย ๆ" ไม่ใช่ null
// ไม่ทำ CSRF state ของ Portal เอง เพราะ check ไม่ส่ง state กลับมาที่ app (เก็บไว้ฝั่ง check เอง ตาม
// seq-01/R02) ใช้ redirect_uri exact-match + handoff token single-use อายุ 60 วิ ของ check แทน
function createCheckAuthClient({ baseUrl, clientId, clientSecret, redirectUri }) {
  function buildLoginUrl() {
    const url = new URL('/login', baseUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  }

  async function verifyToken(token) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    let res;
    try {
      res = await fetch(new URL('/api/verify', baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });
    } catch {
      // ห้าม log error object ตรง ๆ (rule 7) - อาจมีรายละเอียด request ปน อาจไม่ได้มี secret แต่กันไว้ก่อน
      return { ok: false, status: 502, reason: 'upstream_unreachable' };
    }

    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: 502, reason: 'invalid_response' };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, reason: (data && data.error) || 'verify_failed' };
    }
    return { ok: true, claims: data || {} };
  }

  return { buildLoginUrl, verifyToken };
}

module.exports = { createCheckAuthClient };
