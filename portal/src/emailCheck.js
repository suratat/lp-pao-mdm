// ตัวช่วยของปุ่ม "ตรวจสอบอีเมล" (ค้น DNS MX ของโดเมน) - ไฟล์นี้มีสำเนา "ที่ต้องเหมือนกันทุกตัว" ใน portal/src และ hr-console/src
// (Dockerfile ของแต่ละ workspace COPY เฉพาะโฟลเดอร์ตัวเอง) แก้ที่หนึ่งต้องแก้อีกที่ มีเทสต์ api/test/contactValidation.test.js เทียบเนื้อไฟล์ให้ ถ้าไม่ตรงกันเทสต์จะล้ม
// ผลการตรวจเป็นข้อมูลประกอบเท่านั้น: การบันทึกตัดสินด้วยรูปแบบอีเมลอย่างเดียว ห้ามใช้ผลนี้บล็อกการบันทึก
// ห้าม log ค่าอีเมล (ไม่ใส่ในข้อความ error/log ใดๆ ของไฟล์นี้)
const dns = require('node:dns');
const { validateEmail } = require('./contactValidation');

const DNS_TIMEOUT_MS = 3000;

const MESSAGES = {
  ok: 'รูปแบบถูกต้องและโดเมนรับอีเมลได้',
  no_mx: 'โดเมนนี้ไม่มีเซิร์ฟเวอร์รับอีเมล',
  unavailable: 'ตรวจสอบไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง',
  rate_limited: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  unauthorized: 'กรุณาเข้าสู่ระบบใหม่',
  bad_request: 'คำขอไม่ถูกต้อง',
};

// กันไม่ให้ปุ่มนี้ถูกใช้เป็นเครื่องมือสำรวจ DNS ภายใน: โดเมนที่ลงท้ายด้วยชื่อเหล่านี้ไม่ถูกค้น DNS (ตอบว่าไม่มีเซิร์ฟเวอร์รับอีเมล)
const BLOCKED_SUFFIXES = ['local', 'internal', 'localhost', 'localdomain', 'lan', 'intranet', 'corp', 'home', 'private', 'arpa', 'invalid', 'test'];

function isBlockedDomain(domain) {
  if (!domain.includes('.')) return true;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return BLOCKED_SUFFIXES.includes(tld);
}

const NO_RECORD_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NODATA', 'NOTFOUND']);

async function lookupOrEmpty(fn) {
  try {
    return { records: await fn(), error: null };
  } catch (err) {
    if (NO_RECORD_CODES.has(err && err.code)) return { records: [], error: null };
    return { records: [], error: err };
  }
}

// คืน 'ok' | 'no_mx' | 'unavailable'; resolver ฉีดได้ (resolveMx/resolve4/resolve6 แบบ promise) เพื่อใช้ mock ในเทสต์
async function checkEmailDomain(email, { resolver = null, timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const parsed = validateEmail(email);
  if (!parsed.ok || parsed.value === null) return 'unavailable';
  const domain = parsed.value.slice(parsed.value.lastIndexOf('@') + 1).toLowerCase();
  if (isBlockedDomain(domain)) return 'no_mx';

  const r = resolver || new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('unavailable'), timeoutMs);
  });
  const work = (async () => {
    const mx = await lookupOrEmpty(() => r.resolveMx(domain));
    if (mx.error) return 'unavailable';
    // null MX (RFC 7505: exchange ว่างหรือ ".") = โดเมนประกาศว่าไม่รับอีเมล
    const real = mx.records.filter((m) => m.exchange && m.exchange !== '.');
    if (real.length > 0) return 'ok';
    if (mx.records.length > 0) return 'no_mx';
    // ไม่มี MX: ใช้หลัก implicit MX (A/AAAA ของโดเมนเอง)
    const a = await lookupOrEmpty(() => r.resolve4(domain));
    if (a.records.length > 0) return 'ok';
    const aaaa = await lookupOrEmpty(() => r.resolve6(domain));
    if (aaaa.records.length > 0) return 'ok';
    if (a.error || aaaa.error) return 'unavailable';
    return 'no_mx';
  })().catch(() => 'unavailable');
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    if (r && typeof r.cancel === 'function') {
      try {
        r.cancel();
      } catch (_) {
        /* ไม่มีคำขอค้าง */
      }
    }
  }
}

// rate limit ต่อ key (session) แบบหน้าต่างเลื่อนในหน่วยความจำ - ใช้ได้เพราะ console รันตัวเดียวต่อ container
function createRateLimiter({ max = 10, windowMs = 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, list] of hits) if (list.every((ts) => t - ts >= windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

// handler ของ POST .../check-email (body JSON {email}); keyOf(req) = ตัวระบุ session; ต้องผ่านการล็อกอิน/สิทธิ์มาก่อนถึง handler นี้
function createCheckEmailHandler({ keyOf, limiter = createRateLimiter(), checkDomain = checkEmailDomain }) {
  return async function checkEmailHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!limiter.allow(keyOf(req))) return res.status(429).json({ status: 'rate_limited', message: MESSAGES.rate_limited });
    const email = req.body && typeof req.body.email === 'string' ? req.body.email : null;
    if (email === null) return res.status(400).json({ status: 'bad_request', message: MESSAGES.bad_request });
    const parsed = validateEmail(email);
    if (!parsed.ok) return res.json({ status: 'invalid', message: parsed.message });
    if (parsed.value === null) return res.json({ status: 'invalid', message: 'กรุณากรอกอีเมลก่อนตรวจสอบ' });
    const status = await checkDomain(parsed.value);
    return res.json({ status, message: MESSAGES[status] });
  };
}

module.exports = { checkEmailDomain, createRateLimiter, createCheckEmailHandler, isBlockedDomain, MESSAGES, DNS_TIMEOUT_MS };
