// แบ่งแถวที่จะส่งเป็นชุดตาม "ขนาด body จริงเป็นไบต์" (UTF-8) ไม่ใช่จำนวนแถว เพราะ limit ของ API คือขนาด body
// (express.json() ใน api/src/app.js) และอักษรไทยเป็น 3 ไบต์/ตัว ขนาดต่อแถวจึงแปรผันมาก (~0.5-3 KB)
//
// ขนาด body = envelopeBytes (ซอง {mode, createIfMissing, sourceSystem, rows: []}) + ผลรวมขนาดแต่ละแถว + ตัวคั่น "," ระหว่างแถว
// ค่า bytes ของแต่ละ chunk จึงตรงกับ Buffer.byteLength(JSON.stringify(body)) เป๊ะ (ทดสอบแล้ว)
const defaultSizeOf = (item) => Buffer.byteLength(JSON.stringify(item));

function envelopeBytesFor(meta) {
  return Buffer.byteLength(JSON.stringify({ ...meta, rows: [] }));
}

// คืน { chunks: [{ items, bytes }], oversized: [item] } - แถวเดียวที่เกินงบแม้ส่งเดี่ยวๆ ถูกแยกเป็น oversized
// (ผู้เรียกรายงานเป็น error รายแถว) ไม่ทำให้แถวอื่นหรือทั้งงานล้ม ลำดับแถวเดิมคงอยู่
function chunkByBytes(items, { envelopeBytes, maxBytes = 61440, maxItems = 2000, sizeOf = defaultSizeOf }) {
  const chunks = [];
  const oversized = [];
  let current = null;

  for (const item of items) {
    const size = sizeOf(item);
    if (envelopeBytes + size > maxBytes) {
      oversized.push(item);
      continue;
    }

    const addedBytes = size + (current && current.items.length > 0 ? 1 : 0);
    if (current && (current.items.length >= maxItems || current.bytes + addedBytes > maxBytes)) {
      chunks.push(current);
      current = null;
    }
    if (!current) {
      current = { items: [], bytes: envelopeBytes };
    }
    current.bytes += size + (current.items.length > 0 ? 1 : 0);
    current.items.push(item);
  }
  if (current) chunks.push(current);

  return { chunks, oversized };
}

module.exports = { chunkByBytes, envelopeBytesFor };
