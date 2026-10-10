const { checkEmailDomain, createRateLimiter, isBlockedDomain, MESSAGES } = require('../src/emailCheck');

// ตัวค้น DNS MX ของปุ่ม "ตรวจสอบอีเมล" ด้วย resolver จำลอง (ไม่ยิง DNS จริง)

const dnsError = (code) => Object.assign(new Error(code), { code });
const resolver = (impl) => ({
  resolveMx: async () => {
    throw dnsError('ENODATA');
  },
  resolve4: async () => {
    throw dnsError('ENODATA');
  },
  resolve6: async () => {
    throw dnsError('ENODATA');
  },
  ...impl,
});

describe('checkEmailDomain', () => {
  test('มี MX -> ok', async () => {
    const r = resolver({ resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }] });
    expect(await checkEmailDomain('a@example.com', { resolver: r })).toBe('ok');
  });

  test('ไม่มี MX แต่มี A (implicit MX) -> ok; มีแต่ AAAA -> ok', async () => {
    expect(await checkEmailDomain('a@example.com', { resolver: resolver({ resolve4: async () => ['93.184.216.34'] }) })).toBe('ok');
    expect(await checkEmailDomain('a@example.com', { resolver: resolver({ resolve6: async () => ['2001:db8::1'] }) })).toBe('ok');
  });

  test('ไม่มีทั้ง MX/A/AAAA (ENODATA/ENOTFOUND) -> no_mx', async () => {
    expect(await checkEmailDomain('a@example.com', { resolver: resolver({}) })).toBe('no_mx');
    const notFound = resolver({
      resolveMx: async () => {
        throw dnsError('ENOTFOUND');
      },
      resolve4: async () => {
        throw dnsError('ENOTFOUND');
      },
      resolve6: async () => {
        throw dnsError('ENOTFOUND');
      },
    });
    expect(await checkEmailDomain('a@nodomain.example.org', { resolver: notFound })).toBe('no_mx');
  });

  test('null MX (RFC 7505) -> no_mx แม้โดเมนมี A', async () => {
    const r = resolver({ resolveMx: async () => [{ exchange: '', priority: 0 }], resolve4: async () => ['93.184.216.34'] });
    expect(await checkEmailDomain('a@example.com', { resolver: r })).toBe('no_mx');
  });

  test('DNS ล่ม (SERVFAIL/ETIMEOUT/ECONNREFUSED) -> unavailable ไม่ใช่ no_mx', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED']) {
      // eslint-disable-next-line no-await-in-loop
      const r = resolver({
        resolveMx: async () => {
          throw dnsError(code);
        },
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await checkEmailDomain('a@example.com', { resolver: r })).toBe('unavailable');
    }
    const aFails = resolver({
      resolve4: async () => {
        throw dnsError('ESERVFAIL');
      },
    });
    expect(await checkEmailDomain('a@example.com', { resolver: aFails })).toBe('unavailable');
  });

  test('ค้างเกินเวลา (timeout) -> unavailable', async () => {
    const r = resolver({ resolveMx: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await checkEmailDomain('a@example.com', { resolver: r, timeoutMs: 50 })).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test.each(['a@host.local', 'a@db.internal', 'a@x.localhost', 'a@printer.lan', 'a@nas.home.arpa', 'a@x.corp'])(
    'โดเมนภายใน %s -> no_mx โดยไม่ถามเครือข่าย',
    async (email) => {
      const r = resolver({
        resolveMx: async () => {
          throw new Error('ต้องไม่ถูกเรียก');
        },
      });
      expect(await checkEmailDomain(email, { resolver: r })).toBe('no_mx');
    }
  );

  test('รูปแบบอีเมลไม่ถูกต้อง -> unavailable (ไม่ค้น DNS)', async () => {
    expect(await checkEmailDomain('ไม่ใช่อีเมล', { resolver: resolver({}) })).toBe('unavailable');
  });

  test('isBlockedDomain', () => {
    expect(isBlockedDomain('example.com')).toBe(false);
    expect(isBlockedDomain('localhost')).toBe(true);
    expect(isBlockedDomain('a.b.internal')).toBe(true);
  });

  test('ข้อความไทยครบ', () => {
    expect(MESSAGES.ok).toBe('รูปแบบถูกต้องและโดเมนรับอีเมลได้');
    expect(MESSAGES.no_mx).toBe('โดเมนนี้ไม่มีเซิร์ฟเวอร์รับอีเมล');
    expect(MESSAGES.unavailable).toBe('ตรวจสอบไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง');
  });
});

describe('createRateLimiter', () => {
  test('เกิน max ในหน้าต่างเวลา -> ปฏิเสธ แล้วผ่านอีกเมื่อพ้นหน้าต่าง; แยกตาม key', () => {
    let t = 1000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60000, now: () => t });
    expect([1, 2, 3].map(() => limiter.allow('s1'))).toEqual([true, true, true]);
    expect(limiter.allow('s1')).toBe(false);
    expect(limiter.allow('s2')).toBe(true);
    t += 60001;
    expect(limiter.allow('s1')).toBe(true);
  });
});
