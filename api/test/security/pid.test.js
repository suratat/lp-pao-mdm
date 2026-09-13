const {
  isValidPid,
  pidHash,
  canonicalizeIdentityClaims,
  snapshotHash,
  makeFakePid,
} = require('../../src/security/pid');

describe('isValidPid (checksum mod 11, ภาคผนวก ข)', () => {
  test('ยอมรับเลขที่ผ่าน checksum', () => {
    expect(isValidPid(makeFakePid())).toBe(true);
  });

  test('ปฏิเสธเลขที่ไม่ผ่าน checksum', () => {
    const pid = makeFakePid();
    const lastDigit = Number(pid[12]);
    const corrupted = pid.slice(0, 12) + String((lastDigit + 1) % 10);
    expect(isValidPid(corrupted)).toBe(false);
  });

  test('ปฏิเสธความยาวผิด/ตัวอักษรไม่ใช่ตัวเลข', () => {
    expect(isValidPid('123')).toBe(false);
    expect(isValidPid('123456789012a')).toBe(false);
    expect(isValidPid(null)).toBe(false);
    expect(isValidPid(undefined)).toBe(false);
  });
});

describe('makeFakePid (test-only helper)', () => {
  test('สร้างเลขปลอมที่ผ่าน checksum เสมอ และสุ่มค่าต่างกัน', () => {
    const a = makeFakePid();
    const b = makeFakePid();
    expect(isValidPid(a)).toBe(true);
    expect(isValidPid(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('pidHash (HMAC-SHA256 + pepper)', () => {
  test('deterministic ต่อ pepper เดียวกัน', () => {
    const pepper = Buffer.from('a'.repeat(64), 'hex');
    const pid = makeFakePid();
    expect(pidHash(pid, pepper)).toBe(pidHash(pid, pepper));
  });

  test('pepper ต่างกัน -> hash ต่างกัน', () => {
    const pid = makeFakePid();
    const pepperA = Buffer.from('a'.repeat(64), 'hex');
    const pepperB = Buffer.from('b'.repeat(64), 'hex');
    expect(pidHash(pid, pepperA)).not.toBe(pidHash(pid, pepperB));
  });

  test('pid ต่างกัน -> hash ต่างกัน (คนละคน)', () => {
    const pepper = Buffer.from('a'.repeat(64), 'hex');
    expect(pidHash(makeFakePid(), pepper)).not.toBe(pidHash(makeFakePid(), pepper));
  });
});

describe('canonicalizeIdentityClaims + snapshotHash (§3.3 change detection)', () => {
  test('ฟิลด์ที่ไม่ได้ส่งมา (ไม่มี key) ไม่ปรากฏใน canonical เลย', () => {
    const canonical = canonicalizeIdentityClaims({ firstNameTh: 'สมชาย', lastNameTh: 'ใจดี' });
    expect('titleTh' in canonical).toBe(false);
    expect('registeredAddress' in canonical).toBe(false);
  });

  test('trim/ยุบช่องว่างซ้ำ และ "" -> null', () => {
    const canonical = canonicalizeIdentityClaims({
      firstNameTh: '  สมชาย   ใจดี  ',
      lastNameTh: '',
    });
    expect(canonical.firstNameTh).toBe('สมชาย ใจดี');
    expect(canonical.lastNameTh).toBeNull();
  });

  test('snapshot เท่าเดิมเมื่อ claims เหมือนเดิมทุกประการ', () => {
    const claims = { firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', birthDate: '1990-01-01' };
    const a = snapshotHash(canonicalizeIdentityClaims(claims));
    const b = snapshotHash(canonicalizeIdentityClaims({ ...claims }));
    expect(a).toBe(b);
  });

  test('snapshot เปลี่ยนเมื่อฟิลด์ธรรมดาเปลี่ยน', () => {
    const a = snapshotHash(canonicalizeIdentityClaims({ firstNameTh: 'สมชาย', lastNameTh: 'ใจดี' }));
    const b = snapshotHash(canonicalizeIdentityClaims({ firstNameTh: 'สมหญิง', lastNameTh: 'ใจดี' }));
    expect(a).not.toBe(b);
  });

  test('snapshot เปลี่ยนเมื่อฟิลด์ใน registeredAddress (nested) เปลี่ยน - นี่คือจุดที่ภาคผนวก ข ตัวอย่างเดิมพลาด', () => {
    const base = {
      firstNameTh: 'สมชาย',
      lastNameTh: 'ใจดี',
      registeredAddress: {
        houseNo: '99/1',
        subdistrict: { code: '520101' },
        district: { code: '5201' },
        province: { code: '52' },
      },
    };
    const changed = {
      ...base,
      registeredAddress: { ...base.registeredAddress, houseNo: '99/2' },
    };
    const a = snapshotHash(canonicalizeIdentityClaims(base));
    const b = snapshotHash(canonicalizeIdentityClaims(changed));
    expect(a).not.toBe(b);
  });

  test('key เรียงลำดับต่างกันใน object เดียวกัน -> snapshot เท่ากัน (canonical จริง)', () => {
    const claimsA = { firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', titleTh: 'นาย' };
    const claimsB = { titleTh: 'นาย', lastNameTh: 'ใจดี', firstNameTh: 'สมชาย' };
    expect(snapshotHash(canonicalizeIdentityClaims(claimsA))).toBe(snapshotHash(canonicalizeIdentityClaims(claimsB)));
  });
});
