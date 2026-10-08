const { isValidPid, normalizePidInput, looksLikePid, PID_LIKE } = require('../src/pid');
const { messageFor, failureMessage, renderFailure, statusFor, isVersionConflict, isRemoteFailure } = require('../src/apiErrors');
const { MdmApiError } = require('../src/mdmClient');
const { renderHistory, fieldLabel } = require('../src/historyView');
const apiPid = require('../../api/src/security/pid');
const { containsPidLike } = require('../../api/src/security/redact');

// ส่วนที่ไม่ต้องใช้ HTTP: ตัวตรวจเลขบัตรของหน้าจอต้องตรงกับของ API, การแปล error ของ API เป็นข้อความไทย, การแสดงประวัติ

describe('pid.js ตรงกับ api/src/security/pid.js', () => {
  test('เลขที่ผ่าน checksum ของ API (makeFakePid 3,000 ค่า) ผ่านด้วย และเลขที่เปลี่ยนหลักสุดท้ายไม่ผ่านทั้งสองฝั่ง', () => {
    for (let i = 0; i < 3000; i += 1) {
      const pid = apiPid.makeFakePid();
      expect(isValidPid(pid)).toBe(true);
      const wrong = `${pid.slice(0, 12)}${(Number(pid[12]) + 1) % 10}`;
      expect(isValidPid(wrong)).toBe(apiPid.isValidPid(wrong));
      expect(isValidPid(wrong)).toBe(false);
    }
  });

  test.each([undefined, null, 1234567890123, '', '123', '12345678901234', 'abcdefghijklm', '1234567890 23'])('ค่า %p ไม่ผ่านเหมือน API', (value) => {
    expect(isValidPid(value)).toBe(apiPid.isValidPid(value));
    expect(isValidPid(value)).toBe(false);
  });

  test('normalizePidInput ตัดช่องว่าง/ขีด แต่ไม่ตัดอักขระอื่น', () => {
    expect(normalizePidInput(' 1-2345-67890-12-3 ')).toBe('1234567890123');
    expect(normalizePidInput('1 2345 67890 12 3')).toBe('1234567890123');
    expect(normalizePidInput('12a')).toBe('12a');
    expect(normalizePidInput(undefined)).toBe('');
  });

  test('looksLikePid ให้ผลเท่ากับ containsPidLike ของ API (ถ้า API เปลี่ยนกติกา เทสต์นี้ต้องล้ม)', () => {
    expect(PID_LIKE.source).toBe(/\d(?:[ -]?\d){12}/.source);
    for (const text of ['1234567890123', '1-2345-67890-12-3', '1 2345 67890 12 3', '123456789012', '12345678 9012 3', 'เลข 1234567890123 ครับ', 'ไม่มีตัวเลข', '08123456789']) {
      expect(looksLikePid(text)).toBe(containsPidLike(text));
    }
  });
});

describe('apiErrors: ข้อความไทยจาก problem type ของ MDM API', () => {
  const err = (status, type, detail) => new MdmApiError(status, { type: `https://mdm.lp-pao.go.th/problems/${type}`, detail });

  test.each([
    [403, 'insufficient-role', 'hr_master_data_admin'],
    [403, 'insufficient-scope', 'เข้าสู่ระบบใหม่'],
    [409, 'version-conflict', 'ถูกแก้ไขโดยผู้อื่น'],
    [409, 'duplicate-pid', 'เลขบัตรประชาชนนี้อยู่ในระบบแล้ว'],
    [422, 'reason-contains-pid', 'ห้ามมีเลขบัตรประชาชน'],
    [422, 'reason-required', 'กรุณาระบุเหตุผล'],
    [422, 'effective-from-before-current', 'ไม่ก่อนวันที่มีผล'],
    [409, 'position-occupied', 'มีผู้ครองอยู่แล้ว'],
    [422, 'org-unit-invalid', 'หน่วยงาน'],
    [409, 'already-inactive', 'พ้นสภาพไปแล้ว'],
  ])('%s %s -> ข้อความไทยที่รู้จัก', (status, type, fragment) => {
    const text = messageFor(err(status, type, 'English detail that must not be shown'));
    expect(text).toContain(fragment);
    expect(text).not.toContain('English detail');
  });

  test('type ที่ไม่รู้จัก: ใช้ detail ของ API ถ้าเป็นภาษาไทย ไม่งั้นข้อความกลางๆ ตามสถานะ (ไม่โชว์อังกฤษ/ภายในระบบ)', () => {
    expect(messageFor(err(422, 'something-new', 'ข้อมูลไม่ถูกต้องเพราะเหตุผลใหม่'))).toBe('ข้อมูลไม่ถูกต้องเพราะเหตุผลใหม่');
    expect(messageFor(err(422, 'something-new', 'internal stack trace here'))).toContain('ไม่ผ่านการตรวจสอบ');
    expect(messageFor(err(400, 'bad-request', 'must be string'))).toContain('ข้อมูลที่ส่งไม่ถูกต้อง');
    expect(messageFor(err(409, 'other', 'x'))).toContain('ขัดแย้ง');
    expect(messageFor(err(500, 'internal-error', 'boom'))).toContain('ระบบ MDM ขัดข้อง');
    expect(messageFor(new MdmApiError(401, null))).toContain('เซสชันหมดอายุ');
  });

  test('statusFor: 4xx คงสถานะเดิม, 5xx/เครือข่าย -> 502; isRemoteFailure แยก fetch ล้มเหลวจาก bug ของโค้ดเรา', () => {
    expect(statusFor(err(409, 'x'))).toBe(409);
    expect(statusFor(err(422, 'x'))).toBe(422);
    expect(statusFor(err(500, 'x'))).toBe(502);
    expect(statusFor(new TypeError('fetch failed'))).toBe(502);
    expect(isRemoteFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isRemoteFailure(new TypeError('x is not a function'))).toBe(false);
    expect(failureMessage(new TypeError('fetch failed'))).toContain('เชื่อมต่อระบบ MDM ไม่ได้');
  });

  test('renderFailure: version-conflict มีปุ่มโหลดข้อมูลล่าสุด (เฉพาะเมื่อมี reloadUrl), error อื่นไม่มีปุ่ม; escape URL', () => {
    const conflict = renderFailure(err(409, 'version-conflict'), { reloadUrl: '/hr/persons/x/employment/edit', backUrl: '/hr/persons/x' });
    expect(isVersionConflict(err(409, 'version-conflict'))).toBe(true);
    expect(conflict).toContain('class="button"');
    expect(conflict).toContain('href="/hr/persons/x/employment/edit"');
    expect(renderFailure(err(422, 'reason-required'), { reloadUrl: '/x' })).not.toContain('class="button"');
    expect(renderFailure(err(409, 'version-conflict'), {})).not.toContain('class="button"');
    expect(renderFailure(err(422, 'x'), { backUrl: '/a"><script>' })).not.toContain('<script>');
  });
});

describe('historyView', () => {
  const lookups = { orgUnits: new Map([['org-1', 'A-1 — กองคลัง']]), positions: new Map() };
  const entry = (over) => ({ logId: 1, changedAt: '2026-10-08T03:04:05.000Z', fieldKey: 'status', oldValue: 'ACTIVE', newValue: 'INACTIVE', valuesHidden: false, changedBy: 'HR', actorSub: 'u-1', reason: 'ลาออก', ...over });

  test('ป้ายฟิลด์ไทย, แปล id หน่วยงาน/สถานะ, ปกปิดค่า, ไม่ทราบผู้กระทำ, escape ข้อความ', () => {
    const html = renderHistory({
      entries: [
        entry({}),
        entry({ fieldKey: 'employment.org_unit_id', oldValue: 'org-1', newValue: 'org-unknown' }),
        entry({ fieldKey: 'person.expected_birth_date', oldValue: null, newValue: null, valuesHidden: true }),
        entry({ actorSub: null, reason: '<img src=x onerror=alert(1)>' }),
      ],
      nextCursor: '77',
      personId: 'p-1',
      lookups,
    });
    expect(html).toContain('สถานะบุคคล');
    expect(html).toContain('ใช้งาน');
    expect(html).toContain('พ้นสภาพ');
    expect(html).toContain('A-1 — กองคลัง');
    expect(html).toContain('org-unknown'); // ไม่รู้จัก -> แสดง id เดิม
    expect(html).toContain('<em>(ปกปิด)</em>');
    expect(html).toContain('ไม่ทราบผู้กระทำ');
    expect(html).not.toContain('<img');
    expect(html).toContain('historyCursor=77');
    expect(fieldLabel('contact.mobile_phone')).toContain('ข้อมูลติดต่อ');
  });

  test('ค่า/เหตุผลที่ดูเหมือนเลขบัตรไม่แสดง แม้ API ปกปิดพลาด', () => {
    const html = renderHistory({ entries: [entry({ oldValue: '1234567890123', reason: 'อ้างถึง 1-2345-67890-12-3' })], personId: 'p', lookups });
    expect(html).not.toMatch(/\d{13}/);
    expect(html).not.toContain('1-2345-67890-12-3');
  });
});
