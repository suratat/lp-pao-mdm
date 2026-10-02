const { chunkByBytes, envelopeBytesFor } = require('../src/import/chunkByBytes');
const { toImportRow } = require('../src/mapping/toImportRow');
const { MAX_BODY_BYTES, MAX_ROWS_PER_REQUEST } = require('../src/import/runImport');
const { makeFakePid } = require('../../api/src/security/pid');
const crypto = require('node:crypto');

// limit จริงของ API: express.json() ค่าเริ่มต้น 100 KB (api/src/app.js) - นับเป็นไบต์ของ body (UTF-8)
const API_BODY_LIMIT_BYTES = 100 * 1024;

const th = (n) => 'ก'.repeat(n); // อักษรไทยสังเคราะห์ 3 ไบต์/ตัวใน UTF-8

function syntheticRow(i, { name = 8, job = 20, email = 25 } = {}) {
  return {
    row_ref: String(i),
    pid_plaintext: makeFakePid(),
    expected_first_name_th: th(name),
    expected_last_name_th: th(name),
    personnel_type_raw: 'พนักงานจ้าง',
    level_code: 'ชำนาญการ',
    job_title_text: job ? th(job) : null,
    appointed_date_raw: '01/10/2560',
    effective_from_raw: '01/10/2560',
    email_work: email ? `${'x'.repeat(email - 18)}@example.invalid` : null,
    resolved_position_id: null,
    resolved_org_unit_id: crypto.randomUUID(),
  };
}

const META = { mode: 'APPLY', createIfMissing: true, sourceSystem: 'LHR' };
const bodyBytes = (rows) => Buffer.byteLength(JSON.stringify({ ...META, rows }));

function split(rows, overrides = {}) {
  const importRows = rows.map(toImportRow);
  return {
    importRows,
    ...chunkByBytes(importRows, { envelopeBytes: envelopeBytesFor(META), ...overrides }),
  };
}

describe('MAX_BODY_BYTES', () => {
  test('เป็น 60% ของ express.json() default limit (100 KB) และมีเหลือเผื่อ', () => {
    expect(MAX_BODY_BYTES).toBe(61440);
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(API_BODY_LIMIT_BYTES * 0.6);
    expect(MAX_ROWS_PER_REQUEST).toBe(2000);
  });
});

describe('chunkByBytes', () => {
  test('800 แถวสังเคราะห์ -> หลาย chunk, ทุก chunk ไม่เกินงบ, ต่อกันแล้วได้ลำดับเดิมครบไม่ซ้ำไม่ตกหล่น', () => {
    const rows = Array.from({ length: 800 }, (_, i) => syntheticRow(i + 1));
    const { importRows, chunks, oversized } = split(rows);

    expect(chunks.length).toBeGreaterThan(1);
    expect(oversized).toEqual([]);
    for (const c of chunks) {
      expect(bodyBytes(c.items)).toBe(c.bytes); // bytes ที่ประเมินตรงกับ body จริงเป๊ะ
      expect(c.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
      expect(c.bytes).toBeLessThan(API_BODY_LIMIT_BYTES);
    }
    expect(chunks.flatMap((c) => c.items)).toEqual(importRows);
  });

  test('แถวใหญ่สุดที่เป็นไปได้ (ชื่อ/ตำแหน่ง/อีเมลเต็ม 255) 800 แถว -> ทุก chunk ยังไม่เกินงบ', () => {
    const rows = Array.from({ length: 800 }, (_, i) => syntheticRow(i + 1, { name: 255, job: 255, email: 255 }));
    const { importRows, chunks, oversized } = split(rows);

    expect(oversized).toEqual([]);
    expect(chunks.length).toBeGreaterThan(20);
    for (const c of chunks) expect(c.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(chunks.flatMap((c) => c.items)).toEqual(importRows);
  });

  test('จำนวนแถวต่อ chunk ไม่เกิน maxItems แม้ไบต์ยังเหลือ', () => {
    const rows = Array.from({ length: 10 }, (_, i) => syntheticRow(i + 1));
    const { chunks } = split(rows, { maxItems: 3 });
    expect(chunks.map((c) => c.items.length)).toEqual([3, 3, 3, 1]);
  });

  test('แถวเดียวเกินงบ -> แยกเป็น oversized ไม่ทำให้แถวอื่นหาย', () => {
    const rows = [syntheticRow(1), syntheticRow(2), syntheticRow(3)];
    const importRows = rows.map(toImportRow);
    const { chunks, oversized } = chunkByBytes(importRows, {
      envelopeBytes: envelopeBytesFor(META),
      maxBytes: 1200,
      sizeOf: (row) => (row.rowRef === '2' ? 5000 : Buffer.byteLength(JSON.stringify(row))),
    });

    expect(oversized.map((r) => r.rowRef)).toEqual(['2']);
    expect(chunks.flatMap((c) => c.items.map((r) => r.rowRef))).toEqual(['1', '3']);
  });

  test('อินพุตว่าง -> ไม่มี chunk', () => {
    expect(split([])).toMatchObject({ chunks: [], oversized: [] });
  });
});
