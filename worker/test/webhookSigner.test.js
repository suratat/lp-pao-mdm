const { signPayload, verifySignature } = require('../src/services/webhookSigner');

describe('webhookSigner (§2.3: X-MDM-Signature)', () => {
  test('verifySignature ผ่านเมื่อ secret/timestamp/body ตรงกัน', () => {
    const secret = 'test-secret';
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ hello: 'world' });
    const signature = signPayload(secret, timestamp, body);

    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(secret, timestamp, body, signature)).toBe(true);
  });

  test('ปฏิเสธเมื่อ secret ผิด', () => {
    const timestamp = new Date().toISOString();
    const body = '{}';
    const signature = signPayload('correct-secret', timestamp, body);
    expect(verifySignature('wrong-secret', timestamp, body, signature)).toBe(false);
  });

  test('ปฏิเสธเมื่อ body ถูกแก้ระหว่างทาง', () => {
    const secret = 'test-secret';
    const timestamp = new Date().toISOString();
    const signature = signPayload(secret, timestamp, '{"amount":100}');
    expect(verifySignature(secret, timestamp, '{"amount":999}', signature)).toBe(false);
  });

  test('ปฏิเสธเมื่อ timestamp เก่าเกิน 5 นาที (กัน replay)', () => {
    const secret = 'test-secret';
    const body = '{}';
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signature = signPayload(secret, oldTimestamp, body);
    expect(verifySignature(secret, oldTimestamp, body, signature)).toBe(false);
  });
});
