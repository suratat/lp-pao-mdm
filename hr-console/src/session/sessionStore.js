const crypto = require('node:crypto');

// session ฝั่งเซิร์ฟเวอร์ (in-memory) - cookie เก็บแค่ session id สุ่ม ส่วน access/refresh token อยู่ในหน่วยความจำ
// ของ process นี้เท่านั้น ไม่ถูกส่งไปเบราว์เซอร์ (แทนการเก็บ token ทั้งชุดใน cookie JWE ซึ่งโตตามขนาด token จนเกิน
// 4096 ไบต์ของ cookie เดียวได้ - เบราว์เซอร์ทิ้ง Set-Cookie นั้นเงียบๆ ทำให้ login วนลูป)
//
// ข้อจำกัดที่ตั้งใจ (ตัดสินใจโดยเจ้าของระบบ): รันได้แค่ instance เดียว และ session หายเมื่อ restart/deploy
// (ผู้ใช้ถูกส่งไป Keycloak แล้วกลับมาเอง ถ้า SSO session ยังไม่หมดอายุ) - อยากใช้หลาย instance ให้เปลี่ยน
// implementation ตัวนี้เป็น Redis โดยคง interface เดิม (create/get/update/delete)
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // absolute lifetime เท่ากับ cookie JWE เดิม
const MAX_SESSIONS = 5000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SID_PATTERN = /^[A-Za-z0-9_-]{43}$/; // base64url ของ 32 ไบต์

function createSessionStore({ ttlMs = SESSION_TTL_MS, maxSessions = MAX_SESSIONS, now = Date.now } = {}) {
  const sessions = new Map(); // sid -> { data, expiresAt } (Map เรียงตามลำดับที่ใส่ ใช้ตัดตัวเก่าสุดเมื่อเต็ม)
  let timer = null;

  function create(data) {
    // ออก sid ใหม่ทุกครั้งที่ login เสมอ (กัน session fixation)
    const sid = crypto.randomBytes(32).toString('base64url');
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    sessions.set(sid, { data: { ...data }, expiresAt: now() + ttlMs });
    return sid;
  }

  function get(sid) {
    if (typeof sid !== 'string' || !SID_PATTERN.test(sid)) return null;
    const entry = sessions.get(sid);
    if (!entry) return null;
    if (now() >= entry.expiresAt) {
      sessions.delete(sid);
      return null;
    }
    return entry.data;
  }

  function update(sid, patch) {
    const entry = sessions.get(sid);
    if (!entry) return false;
    Object.assign(entry.data, patch);
    return true;
  }

  function remove(sid) {
    return sessions.delete(sid);
  }

  function sweep() {
    const t = now();
    for (const [sid, entry] of sessions) {
      if (t >= entry.expiresAt) sessions.delete(sid);
    }
  }

  function startSweeper(intervalMs = SWEEP_INTERVAL_MS) {
    if (timer) return;
    timer = setInterval(sweep, intervalMs);
    timer.unref(); // ไม่ให้ timer ค้าง process ตอนปิด
  }

  function stopSweeper() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { create, get, update, delete: remove, sweep, startSweeper, stopSweeper, size: () => sessions.size };
}

module.exports = { createSessionStore, SESSION_TTL_MS, MAX_SESSIONS, SID_PATTERN };
