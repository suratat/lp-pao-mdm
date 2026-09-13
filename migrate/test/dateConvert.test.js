const { convertToIsoDate } = require('../src/quality/dateConvert');

describe('convertToIsoDate (§5.4 "แปลง พ.ศ. -> ค.ศ.")', () => {
  test('DD/MM/YYYY พ.ศ. -> ISO ค.ศ. (ลบ 543)', () => {
    expect(convertToIsoDate('01/10/2560')).toEqual({ isoDate: '2017-10-01' });
  });

  test('YYYY-MM-DD พ.ศ. -> ISO ค.ศ.', () => {
    expect(convertToIsoDate('2560-10-01')).toEqual({ isoDate: '2017-10-01' });
  });

  test('ปีที่เป็น ค.ศ. อยู่แล้ว (< 2400) ไม่ถูกแปลงซ้ำ', () => {
    expect(convertToIsoDate('2017-10-01')).toEqual({ isoDate: '2017-10-01' });
  });

  test('รูปแบบไม่รู้จัก -> DATE_FORMAT_INVALID', () => {
    expect(convertToIsoDate('October 1, 2017')).toEqual({ error: 'DATE_FORMAT_INVALID' });
  });

  test('ว่าง/undefined -> DATE_FORMAT_INVALID', () => {
    expect(convertToIsoDate('')).toEqual({ error: 'DATE_FORMAT_INVALID' });
    expect(convertToIsoDate(null)).toEqual({ error: 'DATE_FORMAT_INVALID' });
  });

  test('วันที่ไม่มีจริงในปฏิทิน (31/02) -> DATE_FORMAT_INVALID', () => {
    expect(convertToIsoDate('31/02/2560')).toEqual({ error: 'DATE_FORMAT_INVALID' });
  });

  test('ปีนอกช่วงที่สมเหตุสมผล -> DATE_OUT_OF_RANGE', () => {
    expect(convertToIsoDate('01/01/1800')).toEqual({ error: 'DATE_OUT_OF_RANGE' });
  });
});
