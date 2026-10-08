const { formatThaiDate, formatThaiDateTime, todayBangkok, thaiInputToIso, renderDateInput, BE_DATE_SCRIPT } = require('../src/thaiTime');

// ต้องผ่านไม่ว่า TZ ของเครื่องเป็นอะไร (รันด้วย TZ=UTC และ TZ=Asia/Bangkok)
describe('thaiTime helper (hr-console)', () => {
  test.each([
    ['2026-10-08T14:18:42Z', '8 ต.ค. 2569 21:18:42'],
    ['2026-10-08T18:30:00Z', '9 ต.ค. 2569 01:30:00'],
    ['2026-12-31T17:00:00Z', '1 ม.ค. 2570 00:00:00'],
  ])('วันเวลา %s -> %s', (input, expected) => expect(formatThaiDateTime(input)).toBe(expected));

  test.each([[null], [undefined], [''], ['x']])('วันเวลา %p -> "-"', (v) => expect(formatThaiDateTime(v)).toBe('-'));

  test.each([
    ['2026-10-08', '8 ต.ค. 2569'],
    ['2024-01-01', '1 ม.ค. 2567'],
    ['1900-01-01', '1 ม.ค. 2443'],
    ['2026-12-31', '31 ธ.ค. 2569'],
  ])('วันที่ %s -> %s (ไม่เลื่อนวัน)', (input, expected) => expect(formatThaiDate(input)).toBe(expected));

  test.each([[null], [undefined], ['']])('วันที่ %p -> "-"', (v) => expect(formatThaiDate(v)).toBe('-'));

  test('วันที่ที่อ่านไม่ได้คืนค่าเดิม (ไม่ซ่อนข้อมูลผิดปกติ)', () => expect(formatThaiDate('abc')).toBe('abc'));

  test('todayBangkok: ข้ามวันตามเวลาไทย', () => {
    expect(todayBangkok(new Date('2026-10-08T18:30:00Z'))).toBe('2026-10-09');
    expect(todayBangkok(new Date('2026-10-08T16:59:59Z'))).toBe('2026-10-08');
  });

  test('thaiInputToIso: ไม่มี timezone = เวลาไทย', () => expect(thaiInputToIso('2026-10-08T00:00')).toBe('2026-10-07T17:00:00.000Z'));

  test('renderDateInput: ยังเป็น input type=date ค่า YYYY-MM-DD + ข้อความ พ.ศ. ตั้งต้น; ไม่มีค่า = span ว่าง; escape', () => {
    const withValue = renderDateInput({ name: 'birthDate', value: '1990-05-17', required: true, min: '1900-01-01', max: '2026-10-08' });
    expect(withValue).toContain('<input name="birthDate" type="date" required min="1900-01-01" max="2026-10-08" value="1990-05-17" />');
    expect(withValue).toContain('<span class="be-date" data-for="birthDate">17 พ.ค. 2533</span>');
    expect(renderDateInput({ name: 'x' })).toContain('data-for="x"></span>');
    expect(renderDateInput({ name: 'x', value: '"><script>' })).not.toContain('"><script>');
  });

  test('BE_DATE_SCRIPT: ไม่ใช้ library, มีเดือนไทยครบ และ regex วันที่ถูกต้องหลัง escape', () => {
    expect(BE_DATE_SCRIPT).toContain('"ต.ค."');
    expect(BE_DATE_SCRIPT).toContain('/^(\\d{4})-(\\d{2})-(\\d{2})$/');
    expect(() => new Function(BE_DATE_SCRIPT.replace(/^<script>|<\/script>$/g, ''))).not.toThrow();
  });
});
