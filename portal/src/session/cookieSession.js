const { SignJWT, jwtVerify } = require('jose');

const COOKIE_NAME = 'portal_session';

// session ของ Portal เอง (ไม่ใช้ Redis/express-session - ไม่มีในรายการ dependency ที่อนุมัติ) เก็บแค่
// personId ที่กำลังทำ self-service อยู่ ในรูป JWT ที่เซ็นด้วย secret ของ Portal เอง (คนละตัวกับ
// PORTAL_ACTING_ASSERTION_SECRET ที่ใช้คุยกับ MDM API)
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

async function createSessionCookieValue(personId, secret) {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(personId).setIssuedAt().setExpirationTime('12h').sign(key);
}

async function readPersonIdFromCookieValue(value, secret) {
  if (!value) return null;
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(value, key, { algorithms: ['HS256'] });
    return payload.sub || null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, token, { secure }) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res, { secure }) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

module.exports = { COOKIE_NAME, parseCookies, createSessionCookieValue, readPersonIdFromCookieValue, setSessionCookie, clearSessionCookie };
