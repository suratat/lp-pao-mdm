const crypto = require('node:crypto');
const { importReason, PID_LIKE } = require('../src/import/importReason');
const { containsPidLike } = require('../../api/src/security/redact');

// reason ที่ migrate-cli สร้างเองต้องไม่ชนตัวตรวจเลขบัตรของ API ไม่ว่า batch id จะเป็นค่าใด (บั๊กจาก PR-D1: ใส่ UUID ดิบ -> 422 reason-contains-pid แบบสุ่ม)
// ไม่ใช้ DB/ค่าสุ่ม: ทุกค่าที่ทดสอบกำหนดผลได้แน่นอน

const OLD_FORMAT = (batchId) => `HR_IMPORT batch ${batchId}`;

// batch id ที่ "รู้ว่าชน" กับรูปแบบเดิม (ตัวเลขล้วนติดกันหรือคั่นด้วยขีดตัวเดียวรวมกันได้ 13 หลักขึ้นไป)
const KNOWN_COLLIDING = [
  '12345678-1234-4567-8901-234567890123',
  '00000000-0000-4000-8000-000000000000',
  '20261008-1234-4000-8000-123456789012',
  '98765432-1098-4765-9432-109876543210',
];

// UUID ชุดใหญ่ที่สร้างแบบกำหนดผล (sha256 ของลำดับที่) จัดรูปเป็น 8-4-4-4-12 ตัวพิมพ์เล็ก/ใหญ่ปนกัน
function deterministicUuid(i) {
  const hex = crypto.createHash('sha256').update(`batch-${i}`).digest('hex').slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return i % 2 === 0 ? uuid : uuid.toUpperCase();
}

describe('importReason', () => {
  test('รูปแบบเดิม (UUID ดิบ) ชนตัวตรวจของ API จริง -> นี่คือบั๊กที่เคยทำให้นำเข้าล้ม; รูปแบบใหม่ไม่ชน', () => {
    for (const id of KNOWN_COLLIDING) {
      expect(containsPidLike(OLD_FORMAT(id))).toBe(true);
      expect(containsPidLike(importReason(id))).toBe(false);
    }
  });

  test('ผลลัพธ์ = "HR_IMPORT batch " + 8 ตัวแรกของ batch id (ตัวพิมพ์เล็ก) ตามรอยกลับไป stg_hr.import_batch ได้', () => {
    expect(importReason('12345678-1234-4567-8901-234567890123')).toBe('HR_IMPORT batch 12345678');
    expect(importReason('ABCDEF01-0000-4000-8000-000000000000')).toBe('HR_IMPORT batch abcdef01');
  });

  test('ไม่ชนตัวตรวจของ API เลยกับ batch id 20,000 ค่า (กำหนดผลได้) ทั้งที่รูปแบบเดิมชนหลายร้อยค่า', () => {
    let oldCollisions = 0;
    for (let i = 0; i < 20000; i += 1) {
      const id = deterministicUuid(i);
      if (containsPidLike(OLD_FORMAT(id))) oldCollisions += 1;
      expect(containsPidLike(importReason(id))).toBe(false);
    }
    expect(oldCollisions).toBeGreaterThan(100); // ยืนยันว่าชุดทดสอบนี้ "จับ" บั๊กเดิมได้จริง ไม่ใช่ทดสอบที่ไม่เคยชน
  });

  test('พิสูจน์ด้านโครงสร้าง: เลขติดกันในผลลัพธ์ไม่เกิน 8 หลักเสมอ และไม่มีตัวคั่น (เลข 13 หลักจึงเป็นไปไม่ได้)', () => {
    const worst = importReason('99999999-9999-9999-9999-999999999999');
    expect(worst).toBe('HR_IMPORT batch 99999999');
    expect(Math.max(...(worst.match(/\d+/g) || ['']).map((d) => d.length))).toBe(8);
    expect(worst).not.toMatch(/[-]/);
  });

  test('ไม่ใช่ UUID -> throw (ไม่ส่งค่าแปลกๆ ไปให้ API)', () => {
    for (const bad of [undefined, null, '', 'not-a-uuid', '12345678', '12345678-1234-4567-8901-23456789012']) {
      expect(() => importReason(bad)).toThrow('UUID');
    }
  });

  test('ตัวตรวจสำเนาใน migrate ตรงกับของ API (ถ้า API เปลี่ยนกติกา เทสต์นี้ต้องล้มให้มาแก้ importReason ด้วย)', () => {
    const fixtures = ['1234567890123', '1-2345-67890-12-3', '1 2345 67890 12 3', '123456789012', '12345678 9012 3', '12-34-56-78-90-12', 'abc 12345678'];
    for (const text of fixtures) expect(PID_LIKE.test(text)).toBe(containsPidLike(text));
  });
});
