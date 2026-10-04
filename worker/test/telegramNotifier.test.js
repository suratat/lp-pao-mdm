const http = require('node:http');
const { createTelegramNotifier, buildMessage } = require('../src/services/telegramNotifier');
const { makeFakePid } = require('../../api/src/security/pid');

// ส่ง Telegram จริงไม่ได้ในเทสต์ - ใช้ mock server ในเครื่องแทน api.telegram.org (ผ่าน apiBaseUrl) เพื่อตรวจคำขอที่ส่งออกจริง

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const alert = {
  alert_id: 42,
  rule_code: 'BULK_VIEW',
  severity: 'HIGH',
  actor_sub: '7d2f6f3e-8c1a-4a5b-9f10-2b6d1c3e4a55',
  actor_client: 'hr-console',
  window_start: new Date('2032-03-02T04:50:00Z'),
  window_end: new Date('2032-03-02T05:00:00Z'),
  metric_count: 31,
  threshold: 30,
};

function startMock(statusCode = 200) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: statusCode === 200 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () =>
      resolve({
        received,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

describe('telegramNotifier', () => {
  test('ส่ง POST ไป /bot<token>/sendMessage พร้อม chat_id และข้อความ; ข้อความมีกฎ/จำนวน/ช่วงเวลาไทย/actor/ลิงก์', async () => {
    const mock = await startMock();
    const notifier = createTelegramNotifier({ botToken: TOKEN, chatId: '-1001234567890', consoleBaseUrl: 'https://dpo.lp-pao.go.th', apiBaseUrl: mock.baseUrl });
    const result = await notifier.notify(alert);
    await mock.close();

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mock.received).toHaveLength(1);
    expect(mock.received[0].method).toBe('POST');
    expect(mock.received[0].url).toBe(`/bot${TOKEN}/sendMessage`);
    const { chat_id: chatId, text } = mock.received[0].body;
    expect(chatId).toBe('-1001234567890');
    expect(text).toContain('#42');
    expect(text).toContain('เปิดดูข้อมูลบุคคลจำนวนมากในเวลาสั้น');
    expect(text).toContain('31 (เกณฑ์ 30)');
    expect(text).toContain(alert.actor_sub);
    expect(text).toContain('hr-console');
    expect(text).toContain('https://dpo.lp-pao.go.th/dpo/alerts');
    expect(text).toMatch(/11:50.*12:00/); // 04:50Z-05:00Z = 11:50-12:00 เวลาไทย
  });

  test('ข้อความไม่มี pid/ชื่อ: แม้ actor_sub จะมีเลข 13 หลักหลุดมา (กรองซ้ำ) และไม่มี personId ใดๆ ในข้อความ', () => {
    const pid = makeFakePid();
    const text = buildMessage({ ...alert, actor_sub: `user-${pid}` }, null);
    expect(text).not.toContain(pid);
    expect(text).not.toMatch(/\d{13}/);
    expect(Object.keys(alert)).not.toContain('subject_person_id');
  });

  test('ไม่ตั้ง consoleBaseUrl = ไม่มีบรรทัดลิงก์', () => {
    expect(buildMessage(alert, null)).not.toContain('/dpo/alerts');
  });

  test('HTTP ไม่ใช่ 2xx: คืน ok=false ไม่ throw และ log เฉพาะสถานะ (ไม่มี token)', async () => {
    const mock = await startMock(401);
    const logger = { error: jest.fn() };
    const notifier = createTelegramNotifier({ botToken: TOKEN, chatId: '-100', apiBaseUrl: mock.baseUrl, logger });
    const result = await notifier.notify(alert);
    await mock.close();
    expect(result).toEqual({ ok: false, status: 401 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
  });

  test('เครือข่ายล้มเหลว: ไม่ throw และ error ที่มี URL (ซึ่งมี token ในพาธ) ไม่ถูกพิมพ์', async () => {
    const logger = { error: jest.fn() };
    const fetchImpl = jest.fn().mockRejectedValue(Object.assign(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`), { name: 'TypeError' }));
    const notifier = createTelegramNotifier({ botToken: TOKEN, chatId: '-100', fetchImpl, logger });
    await expect(notifier.notify(alert)).resolves.toEqual({ ok: false, status: null });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('api.telegram.org');
  });
});
