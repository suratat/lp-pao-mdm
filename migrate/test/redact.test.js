const { redact } = require('../src/util/redact');

describe('redact (CLAUDE.md กฎข้อ 1: ห้าม pid ปรากฏใน log/error message/รายงาน)', () => {
  test('แทนที่เลข 13 หลักด้วย [REDACTED_PID]', () => {
    expect(redact('พบปัญหากับ 1234567890123 ในแถวนี้')).toBe('พบปัญหากับ [REDACTED_PID] ในแถวนี้');
  });

  test('แทนที่ได้หลายจุดในข้อความเดียว', () => {
    expect(redact('1111111111111 กับ 2222222222222')).toBe('[REDACTED_PID] กับ [REDACTED_PID]');
  });

  test('ไม่แตะเลขที่สั้นกว่า/ยาวกว่า 13 หลัก', () => {
    expect(redact('รหัส 12345')).toBe('รหัส 12345');
  });

  test('ค่าที่ไม่ใช่ string คืนค่าเดิม', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
  });
});
