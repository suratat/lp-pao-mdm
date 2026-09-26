const { SESSION_TTL_MS } = require('./sessionStore');

// cookie ของ session เก็บแค่ session id สุ่ม (~43 ตัวอักษร) - token จริงอยู่ใน sessionStore ฝั่งเซิร์ฟเวอร์
// (ดูเหตุผลใน sessionStore.js) ชื่อใหม่แยกจาก hr_console_session (JWE เดิมที่เก็บ token ทั้งชุด) เพื่อไม่ให้สับสนกับ
// cookie รุ่นเก่าที่ยังค้างในเบราว์เซอร์ - รุ่นเก่าถูกล้างทิ้งตอน login/logout
const COOKIE_NAME = 'hr_console_sid';
const LEGACY_COOKIE_NAME = 'hr_console_session';
const STATE_COOKIE_NAME = 'hr_console_oauth_state';
const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        // cookie ที่ percent-encoding เสีย (ไม่ใช่ของเรา) ข้ามไป ไม่ให้ทั้ง request พัง
      }
    }
  });
  return out;
}

// ต่อท้าย Set-Cookie เดิมแทนการเขียนทับ (res.setHeader('Set-Cookie', x) เขียนทับทั้งหมด ทำให้ cookie ที่ตั้งก่อนหน้า
// ใน response เดียวกันหายเงียบๆ)
function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, value]);
}

const secureAttr = (secure) => (secure ? '; Secure' : '');

function setSessionCookie(res, sid, { secure }) {
  appendSetCookie(res, `${COOKIE_NAME}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secureAttr(secure)}`);
}

function clearSessionCookie(res, { secure }) {
  appendSetCookie(res, `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(secure)}`);
}

function clearLegacySessionCookie(res, { secure }) {
  appendSetCookie(res, `${LEGACY_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(secure)}`);
}

// state คุกกี้อายุสั้นสำหรับกัน CSRF ระหว่าง /auth/login -> /auth/callback (ค่าเป็น random nonce
// เปรียบเทียบตรง ๆ ไม่มีข้อมูลอ่อนไหว จึงไม่ต้องเข้ารหัส/เซ็น)
function setOauthStateCookie(res, state, { secure }) {
  appendSetCookie(
    res,
    `${STATE_COOKIE_NAME}=${encodeURIComponent(state)}; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=300${secureAttr(secure)}`
  );
}

function clearOauthStateCookie(res, { secure }) {
  appendSetCookie(res, `${STATE_COOKIE_NAME}=; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=0${secureAttr(secure)}`);
}

module.exports = {
  COOKIE_NAME,
  LEGACY_COOKIE_NAME,
  STATE_COOKIE_NAME,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  clearLegacySessionCookie,
  setOauthStateCookie,
  clearOauthStateCookie,
};
