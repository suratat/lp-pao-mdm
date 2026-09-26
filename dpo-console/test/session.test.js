const crypto = require('node:crypto');
const request = require('supertest');
const { EncryptJWT } = require('jose');
const { buildIntegrationHarness, ALL_REALM_ROLES, ALL_CLIENT_SCOPES } = require('./testHarness');
const { createSessionStore, SID_PATTERN } = require('../src/session/sessionStore');

// T10-fix: session ฝั่งเซิร์ฟเวอร์ - cookie เก็บแค่ session id (เดิมเก็บ JWE ของ access+refresh+id token รวมกันแล้วเกิน 4096 ไบต์
// เบราว์เซอร์ทิ้ง Set-Cookie เงียบๆ -> login วนลูป)
const COOKIE_LIMIT_BYTES = 4096; // เพดาน RFC 6265 / เบราว์เซอร์
const SESSION_COOKIE_TARGET_BYTES = 200; // เป้าหมายของงานนี้: Set-Cookie ของ session ไม่เกิน ~200 ไบต์ ไม่ว่า token จะใหญ่แค่ไหน

let harness;

beforeAll(async () => {
  harness = await buildIntegrationHarness();
});

afterAll(async () => {
  await harness.close();
});

const bytes = (setCookieHeader) => Buffer.byteLength(setCookieHeader, 'utf8');
const sidFrom = (setCookies) => {
  const line = (setCookies || []).find((c) => c.startsWith('dpo_console_sid=') && !c.startsWith('dpo_console_sid=;'));
  return line ? line.split(';')[0].slice('dpo_console_sid='.length) : null;
};

async function login(app, code) {
  const agent = request.agent(app);
  const loginRes = await agent.get('/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const callback = await agent.get('/auth/callback').query({ code, state });
  return { agent, loginRes, callback, sid: sidFrom(callback.headers['set-cookie']) };
}

describe('1) ขนาด cookie: ไม่เกิน 4096 (และ ~200) ไบต์ แม้ token ใหญ่ผิดปกติ', () => {
  test('ผู้ใช้ที่มีทุก role + ทุก scope ของระบบ + role ปลอม 300 ตัว: ทุก Set-Cookie ตลอด login → หน้า → silent refresh → logout ไม่เกินเพดาน', async () => {
    const collected = [];
    const collect = (res) => collected.push(...(res.headers['set-cookie'] || []));

    const { agent, loginRes, callback, sid } = await login(harness.dpoConsoleApp, 'huge-token-code');
    collect(loginRes);
    collect(callback);
    expect(callback.status).toBe(302);
    expect(sid).toMatch(SID_PATTERN);

    // ยืนยันว่า scenario "หนัก" จริง: token ใน store ใหญ่มาก และถ้าเก็บแบบเดิม (JWE ของทั้งชุด) จะเกินเพดานแน่นอน
    const stored = harness.sessionStore.get(sid);
    expect(stored.accessToken.length).toBeGreaterThan(6000);
    const legacyCookieValue = await new EncryptJWT({ accessToken: stored.accessToken, refreshToken: stored.refreshToken })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(crypto.createHash('sha256').update('x').digest());
    expect(legacyCookieValue.length).toBeGreaterThan(COOKIE_LIMIT_BYTES * 2);

    // expiresIn=1s < 15s ⇒ ทุก request ต้อง silent refresh - เดินหลายรอบแล้วเก็บ Set-Cookie ทุกครั้ง
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await agent.get('/dpo/access-logs');
      expect(page.status).toBe(200);
      collect(page);
    }
    collect(await agent.get('/auth/logout'));

    expect(collected.length).toBeGreaterThan(0);
    for (const header of collected) {
      expect(bytes(header)).toBeLessThanOrEqual(COOKIE_LIMIT_BYTES);
      expect(header).not.toMatch(/eyJ/); // ไม่มี JWT (header ขึ้นต้น eyJ) หลุดลง cookie เลย
    }
    const sessionCookies = collected.filter((c) => c.startsWith('dpo_console_sid='));
    expect(sessionCookies.length).toBeGreaterThan(0);
    for (const header of sessionCookies) expect(bytes(header)).toBeLessThanOrEqual(SESSION_COOKIE_TARGET_BYTES);

    // รายงานตัวเลขที่วัดได้จริง
    const measured = Math.max(...sessionCookies.map(bytes));
    // eslint-disable-next-line no-console
    console.log(`[cookie-size] access_token=${stored.accessToken.length}B, JWE เดิมจะยาว ${legacyCookieValue.length}B, Set-Cookie ของ session ยาวสุด ${measured}B`);
  });

  test('ผู้ใช้ทั่วไป (token ปกติ) ก็ได้ cookie ขนาดเท่ากัน - ขนาดไม่ขึ้นกับ token', async () => {
    const { callback: small } = await login(harness.dpoConsoleApp, 'good-dpo-code');
    const { callback: huge } = await login(harness.dpoConsoleApp, 'huge-token-code');
    const size = (res) => bytes(res.headers['set-cookie'].find((c) => c.startsWith('dpo_console_sid=')));
    expect(size(small)).toBe(size(huge));
  });

  test('ใช้ role/scope ครบตามที่ realm-export.json ประกาศจริง (ไม่ใช่รายการที่เดาเอง)', () => {
    expect(ALL_REALM_ROLES).toEqual(expect.arrayContaining(['dpo', 'auditor']));
    expect(ALL_CLIENT_SCOPES).toEqual(expect.arrayContaining(['audit:read', 'events:read', 'personnel:read:basic']));
  });
});

describe('2) silent refresh + single-flight (กัน invalid_grant จาก race)', () => {
  test('request พร้อมกัน 8 ตัวตอน token ใกล้หมดอายุ (refresh token ใช้ได้ครั้งเดียว) -> เรียก Keycloak refresh ครั้งเดียว ทุกตัวได้ 200 ไม่มี invalid_grant', async () => {
    const { agent } = await login(harness.dpoConsoleApp, 'rotating-code');
    const stats = harness.mockKeycloak.stats;

    for (let wave = 1; wave <= 3; wave += 1) {
      const before = { ...stats };
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(Array.from({ length: 8 }, () => agent.get('/dpo/access-logs')));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(stats.refreshGrants - before.refreshGrants).toBe(1);
      expect(stats.invalidGrants - before.invalidGrants).toBe(0);
    }
  });

  test('หลัง refresh: token ใน store เปลี่ยนเป็นตัวใหม่ (refresh token หมุนเวียน) และ session เดิมยังใช้ต่อได้', async () => {
    const { agent, sid } = await login(harness.dpoConsoleApp, 'rotating-code');
    const before = harness.sessionStore.get(sid).refreshToken;
    expect((await agent.get('/dpo/access-logs')).status).toBe(200);
    const after = harness.sessionStore.get(sid).refreshToken;
    expect(after).not.toBe(before);
    expect((await agent.get('/dpo/access-logs')).status).toBe(200);
  });

  test('refresh ถูก Keycloak ปฏิเสธ (invalid_grant) -> ลบ session, ล้าง cookie, redirect login', async () => {
    const { agent, sid } = await login(harness.dpoConsoleApp, 'rotating-code');
    harness.sessionStore.update(sid, { refreshToken: 'refresh-for-rotating-code~999999' }); // ไม่เคยออกให้ = ใช้ไม่ได้
    const res = await agent.get('/dpo/access-logs');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(res.headers['set-cookie'].some((c) => c.startsWith('dpo_console_sid=;'))).toBe(true);
    expect(harness.sessionStore.get(sid)).toBeNull();
  });
});

describe('3-4) logout, sid ปลอม/หมดอายุ/รูปแบบเก่า, session fixation', () => {
  test('logout ลบ session ฝั่งเซิร์ฟเวอร์: เอา sid เดิมไปใช้ซ้ำ (เช่น cookie ที่รั่ว) -> redirect login', async () => {
    const { agent, sid } = await login(harness.dpoConsoleApp, 'good-dpo-code');
    expect(harness.sessionStore.get(sid)).not.toBeNull();
    await agent.get('/auth/logout');
    expect(harness.sessionStore.get(sid)).toBeNull();

    const replay = await request(harness.dpoConsoleApp).get('/dpo/access-logs').set('Cookie', `dpo_console_sid=${sid}`);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe('/auth/login');
  });

  test.each([
    ['sid รูปแบบถูกต้องแต่ไม่มีใน store', () => crypto.randomBytes(32).toString('base64url')],
    ['sid สั้นเกิน', () => 'abc'],
    ['sid มีอักขระต้องห้าม', () => `${'a'.repeat(42)}!`],
    ['sid ยาวผิดปกติ', () => 'a'.repeat(5000)],
  ])('%s -> redirect login', async (_name, makeSid) => {
    const res = await request(harness.dpoConsoleApp).get('/dpo/access-logs').set('Cookie', `dpo_console_sid=${makeSid()}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  test('cookie รุ่นเก่า (dpo_console_session JWE) ที่ค้างในเบราว์เซอร์ถูกเมินและถูกล้างตอน login/logout', async () => {
    const stale = `dpo_console_session=${'x'.repeat(4000)}`;
    const noSid = await request(harness.dpoConsoleApp).get('/dpo/access-logs').set('Cookie', stale);
    expect(noSid.status).toBe(302);

    const { agent, callback } = await login(harness.dpoConsoleApp, 'good-dpo-code');
    expect(callback.headers['set-cookie'].some((c) => c.startsWith('dpo_console_session=;') && c.includes('Max-Age=0'))).toBe(true);
    const out = await agent.get('/auth/logout');
    expect(out.headers['set-cookie'].some((c) => c.startsWith('dpo_console_session=;'))).toBe(true);
    expect(out.headers['set-cookie'].some((c) => c.startsWith('dpo_console_sid=;'))).toBe(true);
  });

  test('session fixation: login ได้ sid ใหม่เสมอ ไม่ยอมรับ sid ที่ผู้โจมตีตั้งมาก่อน และสองครั้งได้คนละค่า', async () => {
    const attackerSid = crypto.randomBytes(32).toString('base64url');
    const agent = request.agent(harness.dpoConsoleApp);
    const loginRes = await agent.set('Cookie', `dpo_console_sid=${attackerSid}`).get('/auth/login');
    const state = new URL(loginRes.headers.location).searchParams.get('state');
    const cb = await request(harness.dpoConsoleApp).get('/auth/callback').set('Cookie', `dpo_console_oauth_state=${state}; dpo_console_sid=${attackerSid}`).query({ code: 'good-dpo-code', state });
    const newSid = sidFrom(cb.headers['set-cookie']);
    expect(newSid).toMatch(SID_PATTERN);
    expect(newSid).not.toBe(attackerSid);
    expect(harness.sessionStore.get(attackerSid)).toBeNull();

    const second = await login(harness.dpoConsoleApp, 'good-dpo-code');
    expect(second.sid).not.toBe(newSid);
  });

  test('cookie session: HttpOnly, SameSite=Lax, Path=/, Max-Age=12 ชม.', async () => {
    const { callback } = await login(harness.dpoConsoleApp, 'good-dpo-code');
    const line = callback.headers['set-cookie'].find((c) => c.startsWith('dpo_console_sid='));
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Lax/);
    expect(line).toMatch(/Path=\//);
    expect(line).toMatch(/Max-Age=43200/);
  });

  test('callback ตั้งได้ทั้ง session cookie และล้าง state cookie พร้อมกัน (เดิม header ตัวหลังเขียนทับตัวแรก)', async () => {
    const { callback } = await login(harness.dpoConsoleApp, 'good-dpo-code');
    const names = callback.headers['set-cookie'].map((c) => c.split('=')[0]);
    expect(names).toEqual(expect.arrayContaining(['dpo_console_oauth_state', 'dpo_console_sid', 'dpo_console_session']));
  });
});

describe('5) sessionStore (unit, จำลองเวลา)', () => {
  const makeClock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms) => { t += ms; } };
  };

  test('create/get/update/delete และ sid เป็นค่าสุ่ม base64url 43 ตัวอักษรไม่ซ้ำ', () => {
    const store = createSessionStore();
    const sids = new Set(Array.from({ length: 2000 }, (_, i) => store.create({ n: i })));
    expect(sids.size).toBe(2000);
    for (const sid of sids) expect(sid).toMatch(SID_PATTERN);
    const sid = [...sids][0];
    expect(store.get(sid)).toEqual({ n: 0 });
    expect(store.update(sid, { n: 42, extra: true })).toBe(true);
    expect(store.get(sid)).toEqual({ n: 42, extra: true });
    expect(store.delete(sid)).toBe(true);
    expect(store.get(sid)).toBeNull();
    expect(store.update(sid, { n: 1 })).toBe(false);
  });

  test('หมดอายุตาม TTL (absolute) และ get ลบตัวที่หมดอายุทิ้ง', () => {
    const clock = makeClock();
    const store = createSessionStore({ ttlMs: 1000, now: clock.now });
    const sid = store.create({ a: 1 });
    clock.advance(999);
    expect(store.get(sid)).toEqual({ a: 1 });
    clock.advance(1);
    expect(store.get(sid)).toBeNull();
    expect(store.size()).toBe(0);
  });

  test('sweep ลบเฉพาะตัวที่หมดอายุ', () => {
    const clock = makeClock();
    const store = createSessionStore({ ttlMs: 1000, now: clock.now });
    const old = store.create({ k: 'old' });
    clock.advance(600);
    const fresh = store.create({ k: 'fresh' });
    clock.advance(500); // old อายุ 1100 (หมด), fresh อายุ 500
    expect(store.size()).toBe(2);
    store.sweep();
    expect(store.size()).toBe(1);
    expect(store.get(old)).toBeNull();
    expect(store.get(fresh)).toEqual({ k: 'fresh' });
  });

  test('เต็ม (maxSessions) -> ตัดตัวเก่าสุดออก ไม่ให้ memory บวมไม่จำกัด', () => {
    const store = createSessionStore({ maxSessions: 3 });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((k) => store.create({ k }));
    expect(store.size()).toBe(3);
    expect(store.get(a)).toBeNull();
    expect([b, c, d].map((s) => store.get(s).k)).toEqual(['b', 'c', 'd']);
  });

  test('sweeper เริ่ม/หยุดได้ และไม่ค้าง process (unref)', () => {
    const store = createSessionStore();
    store.startSweeper(60_000);
    store.startSweeper(60_000); // เรียกซ้ำไม่สร้าง timer เพิ่ม
    store.stopSweeper();
    store.stopSweeper();
  });

  test('get รับเฉพาะ sid รูปแบบที่ถูกต้อง (ไม่ใช่ string/undefined/prototype key)', () => {
    const store = createSessionStore();
    for (const bad of [undefined, null, 42, {}, '', '__proto__', 'constructor', 'a'.repeat(44)]) expect(store.get(bad)).toBeNull();
  });
});
