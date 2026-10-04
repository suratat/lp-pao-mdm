const { loadAnomalyConfig, DEFAULTS } = require('../src/anomalyConfig');

// loadAnomalyConfig ตรวจ env ตอนบูต (ค่าผิด = throw -> worker ไม่เริ่ม) - ไม่ต้องใช้ DB แต่ไฟล์นี้อยู่ใต้ jest config ของ worker (มี globalSetup ของ DB)

describe('loadAnomalyConfig: ค่าเริ่มต้น', () => {
  test('ไม่ตั้ง env เลย = ค่าที่ตกลงไว้: 30 คน/10 นาที, 5 ครั้ง/60 นาที, เวลาราชการ 08:30-16:30, เฝ้า hr-console, Telegram ปิด', () => {
    expect(loadAnomalyConfig({})).toEqual({
      monitoredClients: ['hr-console'],
      bulkView: { threshold: 30, windowMin: 10 },
      pidReveal: { threshold: 5, windowMin: 60 },
      offHours: { workStart: '08:30', workEnd: '16:30' },
      offHoursLookbackMin: 30,
      telegram: { enabled: false },
    });
    expect(DEFAULTS.ANOMALY_OFFHOURS_START).toBe('16:30');
    expect(DEFAULTS.ANOMALY_OFFHOURS_END).toBe('08:30');
  });

  test('env ที่เป็นสตริงว่าง (compose ใส่ ${VAR:-} ให้เป็นค่าว่าง) ถือเป็นไม่ตั้ง = ใช้ค่าเริ่มต้น', () => {
    const cfg = loadAnomalyConfig({ ANOMALY_BULK_VIEW_THRESHOLD: '', ANOMALY_MONITORED_CLIENTS: '  ', DPO_TELEGRAM_BOT_TOKEN: '', DPO_TELEGRAM_CHAT_ID: '' });
    expect(cfg.bulkView.threshold).toBe(30);
    expect(cfg.monitoredClients).toEqual(['hr-console']);
    expect(cfg.telegram.enabled).toBe(false);
  });

  test('อ่านค่าจาก env: รายชื่อ client (ตัดช่องว่าง/ซ้ำ), ตัวเลข, เวลาราชการ (START=เลิกงาน, END=เริ่มงาน)', () => {
    const cfg = loadAnomalyConfig({
      ANOMALY_MONITORED_CLIENTS: 'hr-console, dpo-console ,hr-console',
      ANOMALY_BULK_VIEW_THRESHOLD: '50',
      ANOMALY_BULK_VIEW_WINDOW_MIN: '15',
      ANOMALY_PID_REVEAL_THRESHOLD: '3',
      ANOMALY_PID_REVEAL_WINDOW_MIN: '30',
      ANOMALY_OFFHOURS_START: '17:00',
      ANOMALY_OFFHOURS_END: '08:00',
      ANOMALY_SCAN_LOOKBACK_MIN: '20',
    });
    expect(cfg).toMatchObject({
      monitoredClients: ['hr-console', 'dpo-console'],
      bulkView: { threshold: 50, windowMin: 15 },
      pidReveal: { threshold: 3, windowMin: 30 },
      offHours: { workStart: '08:00', workEnd: '17:00' },
      offHoursLookbackMin: 20,
    });
  });
});

describe('loadAnomalyConfig: ค่าผิดรูปแบบ -> throw ตอนบูต (ไม่เดาค่าเอง)', () => {
  test.each([
    ['ANOMALY_BULK_VIEW_THRESHOLD', 'abc'],
    ['ANOMALY_BULK_VIEW_THRESHOLD', '0'],
    ['ANOMALY_BULK_VIEW_THRESHOLD', '-5'],
    ['ANOMALY_BULK_VIEW_THRESHOLD', '3.5'],
    ['ANOMALY_BULK_VIEW_WINDOW_MIN', '0'],
    ['ANOMALY_BULK_VIEW_WINDOW_MIN', '1441'],
    ['ANOMALY_PID_REVEAL_THRESHOLD', '1e3'],
    ['ANOMALY_PID_REVEAL_WINDOW_MIN', 'sixty'],
    ['ANOMALY_SCAN_LOOKBACK_MIN', '5'],
    ['ANOMALY_OFFHOURS_START', '4:30pm'],
    ['ANOMALY_OFFHOURS_START', '24:00'],
    ['ANOMALY_OFFHOURS_END', '08:60'],
    ['ANOMALY_MONITORED_CLIENTS', 'hr console'],
    ['ANOMALY_MONITORED_CLIENTS', "hr-console'; DROP TABLE x"],
    ['ANOMALY_MONITORED_CLIENTS', ','],
  ])('%s=%j', (name, value) => {
    expect(() => loadAnomalyConfig({ [name]: value })).toThrow(name);
  });

  test('เวลาเริ่มงานต้องมาก่อนเวลาเลิกงาน (START <= END ไม่ได้)', () => {
    expect(() => loadAnomalyConfig({ ANOMALY_OFFHOURS_START: '08:30', ANOMALY_OFFHOURS_END: '16:30' })).toThrow(/ANOMALY_OFFHOURS_END/);
    expect(() => loadAnomalyConfig({ ANOMALY_OFFHOURS_START: '09:00', ANOMALY_OFFHOURS_END: '09:00' })).toThrow(/ANOMALY_OFFHOURS_END/);
  });
});

describe('loadAnomalyConfig: Telegram opt-in', () => {
  const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';

  test('ตั้งครบทั้งคู่ = เปิด (chat id ตัวเลขติดลบของกลุ่ม หรือ @ช่อง), DPO_CONSOLE_BASE_URL ตัด / ท้ายออก', () => {
    expect(loadAnomalyConfig({ DPO_TELEGRAM_BOT_TOKEN: TOKEN, DPO_TELEGRAM_CHAT_ID: '-1001234567890' }).telegram).toEqual({
      enabled: true,
      botToken: TOKEN,
      chatId: '-1001234567890',
      consoleBaseUrl: null,
    });
    expect(
      loadAnomalyConfig({ DPO_TELEGRAM_BOT_TOKEN: TOKEN, DPO_TELEGRAM_CHAT_ID: '@dpo_alerts', DPO_CONSOLE_BASE_URL: 'https://dpo.lp-pao.go.th//' }).telegram
    ).toMatchObject({ enabled: true, chatId: '@dpo_alerts', consoleBaseUrl: 'https://dpo.lp-pao.go.th' });
  });

  test('ตั้งแค่ตัวเดียว = throw (ไม่ปล่อยให้เข้าใจว่าเปิดแล้ว) และข้อความ error ไม่มีค่า token', () => {
    expect(() => loadAnomalyConfig({ DPO_TELEGRAM_BOT_TOKEN: TOKEN })).toThrow(/คู่กัน/);
    expect(() => loadAnomalyConfig({ DPO_TELEGRAM_CHAT_ID: '-1001' })).toThrow(/คู่กัน/);
    try {
      loadAnomalyConfig({ DPO_TELEGRAM_BOT_TOKEN: TOKEN });
    } catch (err) {
      expect(err.message).not.toContain(TOKEN);
    }
  });

  test.each([
    ['DPO_TELEGRAM_BOT_TOKEN', 'has space', 'DPO_TELEGRAM_CHAT_ID', '-100'],
    ['DPO_TELEGRAM_BOT_TOKEN', TOKEN, 'DPO_TELEGRAM_CHAT_ID', 'not-a-chat'],
  ])('รูปแบบผิด: %s / %s', (k1, v1, k2, v2) => {
    expect(() => loadAnomalyConfig({ [k1]: v1, [k2]: v2 })).toThrow();
  });

  test('DPO_CONSOLE_BASE_URL ที่ไม่ใช่ http(s) -> throw', () => {
    expect(() => loadAnomalyConfig({ DPO_TELEGRAM_BOT_TOKEN: TOKEN, DPO_TELEGRAM_CHAT_ID: '-100', DPO_CONSOLE_BASE_URL: 'javascript:alert(1)' })).toThrow(
      /DPO_CONSOLE_BASE_URL/
    );
    expect(() => loadAnomalyConfig({ DPO_TELEGRAM_BOT_TOKEN: TOKEN, DPO_TELEGRAM_CHAT_ID: '-100', DPO_CONSOLE_BASE_URL: 'not a url' })).toThrow(
      /DPO_CONSOLE_BASE_URL/
    );
  });
});

describe('บูต worker จริง (src/index.js): ค่า env ผิด -> ออกด้วย exit 1 ก่อนต่อ DB/คิว และไม่พิมพ์ token', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const run = (env) =>
    spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 15000,
    });

  test('threshold ไม่ใช่ตัวเลข', () => {
    const res = run({ ANOMALY_BULK_VIEW_THRESHOLD: 'abc' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('ANOMALY_BULK_VIEW_THRESHOLD');
  });

  test('ตั้ง Telegram ไม่ครบคู่ (ตั้ง token ตัวเดียว) -> exit 1 และข้อความ error ไม่มีค่า token', () => {
    const token = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
    const res = run({ DPO_TELEGRAM_BOT_TOKEN: token });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('DPO_TELEGRAM_CHAT_ID');
    expect(res.stderr).not.toContain(token);
    expect(res.stdout).not.toContain(token);
  });
});
