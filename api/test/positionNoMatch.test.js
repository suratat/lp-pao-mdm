const { normalizePositionNo, buildPositionNoIndex } = require('../src/services/positionNoMatch');

describe('normalizePositionNo (ตัดคำต่อท้าย "(ถ)" + ยุบช่องว่าง - ใช้เป็นกุญแจเทียบเท่านั้น)', () => {
  test('เว้นวรรค 2 ช่องก่อน "(ถ)" -> ยุบช่องว่างแล้วตัดคำต่อท้ายออก', () => {
    expect(normalizePositionNo('52-1-06-4201-048  (ถ)')).toBe('52-1-06-4201-048');
  });

  test('ไม่มีช่องว่างก่อน "(ถ)" -> ตัดคำต่อท้ายออกเหมือนกัน', () => {
    expect(normalizePositionNo('52-1-06-4201-048(ถ)')).toBe('52-1-06-4201-048');
  });

  test('มี NBSP แทนช่องว่างปกติก่อน "(ถ)" -> ยุบเป็นช่องว่างแล้วตัดคำต่อท้ายออก', () => {
    expect(normalizePositionNo('52-1-06-4201-048 (ถ)')).toBe('52-1-06-4201-048');
  });

  test('มี zero-width space แทรกอยู่ -> ตัดอักขระที่มองไม่เห็นออกก่อนแล้วตัดคำต่อท้ายได้ปกติ', () => {
    expect(normalizePositionNo('52-1-06-4201-048​(ถ)')).toBe('52-1-06-4201-048');
  });

  test('เลขล้วนไม่มีขีด ("2") -> คงค่าเดิม ไม่ถูกตัดหรือแก้รูปแบบ', () => {
    expect(normalizePositionNo('2')).toBe('2');
  });

  test('เลขล้วนไม่มีขีด ("50") -> คงค่าเดิม ไม่ถูกตัดหรือแก้รูปแบบ', () => {
    expect(normalizePositionNo('50')).toBe('50');
  });

  test('มีตัว "ถ" แต่ไม่มีวงเล็บล้อมรอบ -> ไม่ถูกตัดออก (ไม่ใช่คำต่อท้ายที่ตั้งใจจับ)', () => {
    expect(normalizePositionNo('52-1-06-ถ-048')).toBe('52-1-06-ถ-048');
  });

  test('ลงท้ายด้วย "ถ" แบบไม่มีวงเล็บ -> ไม่ถูกตัดออก', () => {
    expect(normalizePositionNo('52-1-06-4201-048 ถ')).toBe('52-1-06-4201-048 ถ');
  });

  test('"EX-003" -> คงค่าเดิมทุกตัวอักษร', () => {
    expect(normalizePositionNo('EX-003')).toBe('EX-003');
  });

  test('มี newline คั่นกลางเลข -> ต้องยุบเป็นช่องว่าง 1 ช่อง ห้ามเชื่อมตัวเลขสองท่อนติดกัน', () => {
    // ป้องกัน regression ของลำดับขั้นตอน: ถ้าลบ \p{Cc}\p{Cf} ก่อนยุบช่องว่าง newline จะถูกลบทิ้งเฉยๆ
    // ทำให้ "06" กับ "4201" เชื่อมกันเป็น "064201" ซึ่งเป็นกุญแจคนละค่ากับที่ควรจะเป็น
    expect(normalizePositionNo('52-1-06\n4201-048')).toBe('52-1-06 4201-048');
  });

  test('มี tab คั่นกลางเลข -> ต้องยุบเป็นช่องว่าง 1 ช่อง เช่นเดียวกับ newline', () => {
    expect(normalizePositionNo('52-1-06\t4201-048')).toBe('52-1-06 4201-048');
  });

  test('วงเล็บเต็มความกว้าง "（ถ）" -> ตัดคำต่อท้ายออกเหมือนวงเล็บปกติ', () => {
    expect(normalizePositionNo('52-1-06-4201-048（ถ）')).toBe('52-1-06-4201-048');
  });

  test('ช่องว่างรอบตัว "ถ" ภายในวงเล็บ -> ยังตัดคำต่อท้ายออกได้', () => {
    expect(normalizePositionNo('52-1-06-4201-048 ( ถ )')).toBe('52-1-06-4201-048');
  });

  test('null/undefined -> null', () => {
    expect(normalizePositionNo(null)).toBeNull();
    expect(normalizePositionNo(undefined)).toBeNull();
  });

  test('สตริงว่าง/มีแต่ช่องว่าง -> null', () => {
    expect(normalizePositionNo('')).toBeNull();
    expect(normalizePositionNo('   ')).toBeNull();
  });
});

describe('buildPositionNoIndex (ใช้ normalize เป็นกุญแจเท่านั้น ไม่เขียนทับ position_no เดิม)', () => {
  test('สร้าง index จากรายการ item ที่มี position_no ได้ถูกต้อง และ item เดิมไม่ถูกแก้ไข', () => {
    const items = [
      { position_no: '52-1-06-4201-048  (ถ)', title: 'นักวิเคราะห์' },
      { position_no: 'EX-003', title: 'ผู้เชี่ยวชาญ' },
    ];
    const index = buildPositionNoIndex(items);

    expect(index.get('52-1-06-4201-048')).toBe(items[0]);
    expect(index.get('EX-003')).toBe(items[1]);
    // ยืนยันว่า position_no ดิบของ item เดิมไม่ถูกเขียนทับด้วยค่าที่ normalize แล้ว
    expect(items[0].position_no).toBe('52-1-06-4201-048  (ถ)');
  });

  test('รองรับรายการที่เป็นสตริงเลขที่ตำแหน่งล้วน (ไม่ต้องผ่าน getPositionNo)', () => {
    const index = buildPositionNoIndex(['2', '50', 'EX-003']);
    expect([...index.keys()].sort()).toEqual(['2', '50', 'EX-003'].sort());
  });

  test('รองรับ getPositionNo กำหนดเอง สำหรับ item ที่ field ชื่ออื่น', () => {
    const items = [{ no: '52-1-06-4201-048(ถ)' }];
    const index = buildPositionNoIndex(items, (item) => item.no);
    expect(index.get('52-1-06-4201-048')).toBe(items[0]);
  });

  test('item ที่ไม่มีเลขที่ตำแหน่ง (null) ถูกข้าม ไม่ขึ้น index และไม่ถือเป็นการชนกัน', () => {
    const items = [{ position_no: null }, { position_no: '2' }, { position_no: undefined }];
    const index = buildPositionNoIndex(items);
    expect(index.size).toBe(1);
    expect(index.get('2')).toBe(items[1]);
  });

  test('สองตำแหน่งที่เลขจริงต่างกัน แต่ normalize แล้วได้กุญแจชนกัน -> throw พร้อม code POSITION_NO_KEY_COLLISION', () => {
    const items = [
      { position_no: '52-1-06-4201-048  (ถ)' },
      { position_no: '52-1-06-4201-048(ถ)' }, // normalize แล้วได้กุญแจเดียวกับตัวแรก
    ];

    let thrown;
    try {
      buildPositionNoIndex(items);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('POSITION_NO_KEY_COLLISION');
    expect(thrown.key).toBe('52-1-06-4201-048');
    expect(thrown.existingPositionNo).toBe('52-1-06-4201-048  (ถ)');
    expect(thrown.incomingPositionNo).toBe('52-1-06-4201-048(ถ)');
  });
});
