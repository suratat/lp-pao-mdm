const crypto = require('node:crypto');
const { EncryptJWT, jwtDecrypt } = require('jose');

const COOKIE_NAME = 'dpo_console_session';
const STATE_COOKIE_NAME = 'dpo_console_oauth_state';

function deriveKey(secret) {
  // A256GCM (alg=dir) ต้องการคีย์ 32 ไบต์เป๊ะ - hash secret ที่ตั้งเป็น string ธรรมดาให้ได้ความยาวคงที่เสมอ
  return crypto.createHash('sha256').update(secret).digest();
}

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

// session ของ DPO Console เก็บ access/refresh token ของผู้ใช้จริง (bearer credential) จึงเข้ารหัสด้วย
// JWE (dir + A256GCM) ไม่ใช่แค่เซ็นด้วย JWS เหมือน portal_session ของ Portal เดิม (แนวทางเดียวกับ
// hr_console_session ของ hr-console)
async function createSessionCookieValue(session, secret) {
  const key = deriveKey(secret);
  return new EncryptJWT({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? null,
    idToken: session.idToken ?? null,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    displayName: session.displayName ?? null,
  })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .encrypt(key);
}

async function readSessionFromCookieValue(value, secret) {
  if (!value) return null;
  try {
    const key = deriveKey(secret);
    const { payload } = await jwtDecrypt(value, key);
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? null,
      idToken: payload.idToken ?? null,
      accessTokenExpiresAt: payload.accessTokenExpiresAt,
      displayName: payload.displayName ?? null,
    };
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

// state คุกกี้อายุสั้นสำหรับกัน CSRF ระหว่าง /auth/login -> /auth/callback (ค่าเป็น random nonce
// เปรียบเทียบตรง ๆ ไม่มีข้อมูลอ่อนไหว จึงไม่ต้องเข้ารหัส/เซ็น)
function setOauthStateCookie(res, state, { secure }) {
  res.setHeader(
    'Set-Cookie',
    `${STATE_COOKIE_NAME}=${encodeURIComponent(state)}; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=300${secure ? '; Secure' : ''}`
  );
}

function clearOauthStateCookie(res, { secure }) {
  res.setHeader('Set-Cookie', `${STATE_COOKIE_NAME}=; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

module.exports = {
  COOKIE_NAME,
  STATE_COOKIE_NAME,
  parseCookies,
  createSessionCookieValue,
  readSessionFromCookieValue,
  setSessionCookie,
  clearSessionCookie,
  setOauthStateCookie,
  clearOauthStateCookie,
};
