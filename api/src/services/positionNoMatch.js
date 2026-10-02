// เลขที่ตำแหน่ง (position_no) จากไฟล์ HR เดิมบางแถวมีรูปแบบที่ต่างกันแค่การเว้นวรรค/อักขระที่มองไม่เห็น
// (เช่น "52-1-06-4201-048  (ถ)" เทียบกับของจริงใน mdm.position ที่อาจพิมพ์ต่างกันเล็กน้อย) ทำให้การเทียบแบบ
// exact string จับไม่ได้ว่าเป็นตำแหน่งเดียวกัน ไฟล์นี้จึงแยก normalize ออกมาเป็น pure function ใช้ร่วมกันทั้งสองฝั่ง
// (เลขจากไฟล์ และเลขใน mdm.position) - ตัดสินใจโดยเจ้าของระบบ (ยืนยันจากฐานข้อมูลจริงแล้วว่า normalize แล้วเทียบ
// แบบหนึ่งต่อหนึ่งได้ ไม่มีตำแหน่งใดชนกัน): ห้ามใช้ regex จำกัดรูปแบบเลขที่ตำแหน่งเป็นตัวกัน (มีเลขล้วนไม่มีขีด
// เช่น "2", "50" เป็นตำแหน่งจริง) - ให้อาศัยการเทียบกับตำแหน่งที่มีอยู่จริงแทน
//
// ค่าที่ normalizePositionNo() คืน ใช้เป็น "กุญแจเทียบ" เท่านั้น ห้ามนำไปเขียนทับ position_no ที่เก็บจริงไม่ว่าฝั่งใด

// ตัดคำต่อท้าย "(ถ)" ท้ายเลขที่ตำแหน่ง - รองรับวงเล็บเต็มความกว้าง (（）) และช่องว่างได้ทั้งก่อนวงเล็บเปิด/รอบตัว "ถ"
// (เลือก regex นี้โดยเจ้าของระบบ แก้จากที่เสนอไปเพื่อ escape วงเล็บให้ถูกและรองรับวงเล็บเต็มความกว้างด้วย)
const TRAILING_THO_SUFFIX = /\s*[(（]\s*ถ\s*[)）]$/u;

/**
 * normalize เลขที่ตำแหน่งให้เป็นกุญแจสำหรับเทียบ (ไม่ใช่ค่าที่เก็บจริง)
 * ขั้นที่ 1: ยุบช่องว่างทุกชนิด (รวม NBSP, tab, newline, CR) เหลือช่องเดียว + trim - ต้องทำขั้นนี้ก่อนขั้นที่ 2 เสมอ
 *   เพราะ tab/newline/CR อยู่ในหมวดอักขระควบคุม (\p{Cc}) เหมือนกัน ถ้าลบทิ้งก่อนยุบช่องว่าง อักขระเหล่านี้จะถูกลบ
 *   ไปเฉยๆ โดยไม่เหลือช่องว่างคั่น ทำให้ตัวเลขสองท่อนที่เดิมคั่นด้วย tab/newline ถูกเชื่อมติดกันโดยไม่ตั้งใจ
 *   (เช่น "52-1-06\n4201-048" จะกลายเป็น "52-1-064201-048" แทนที่จะเป็น "52-1-06 4201-048" ที่ถูกต้อง)
 * ขั้นที่ 2: ลบอักขระที่เหลือซึ่งเป็นอักขระควบคุม/มองไม่เห็นจริงๆ ที่ไม่ใช่ช่องว่าง (เช่น zero-width space) ออก
 *   (อักขระกลุ่มนี้ไม่ถูกจับโดย \s ในขั้นที่ 1 จึงต้องลบแยกขั้นนี้)
 * ขั้นที่ 3: ตัดคำต่อท้าย "(ถ)" ท้ายข้อความ (ถ้ามี) ตามรูปแบบด้านบน
 * @param {unknown} raw ค่า position_no ดิบ (จากไฟล์ HR หรือจาก mdm.position)
 * @returns {string|null} กุญแจ normalize แล้ว หรือ null ถ้าไม่มีค่า/เป็นสตริงว่างหลัง normalize
 */
function normalizePositionNo(raw) {
  if (raw === undefined || raw === null) return null;

  let text = String(raw)
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();

  text = text.replace(TRAILING_THO_SUFFIX, '').trim();

  return text === '' ? null : text;
}

function defaultGetPositionNo(item) {
  return typeof item === 'string' ? item : item?.position_no;
}

/**
 * สร้าง index (Map) จากรายการตำแหน่ง โดยคีย์เป็นเลขที่ตำแหน่งที่ normalize แล้ว ใช้เทียบหาตำแหน่งที่ "เหมือนกัน
 * หลัง normalize" เท่านั้น ไม่ได้แก้ไขค่า position_no เดิมของแต่ละ item
 *
 * ถ้าพบว่าสอง item (เลขที่ตำแหน่งต่างกันจริง) normalize แล้วได้กุญแจชนกัน ถือเป็นข้อมูลตำแหน่งที่ขัดแย้งกันเอง -
 * throw ทันที (ไม่ resolve ให้อัตโนมัติ) เพื่อให้มนุษย์ตรวจข้อมูลต้นทางก่อน ไม่ silently เลือกตัวใดตัวหนึ่ง
 *
 * @param {Array} items รายการตำแหน่ง (เช่น แถวจาก mdm.position) หรือสตริงเลขที่ตำแหน่งล้วน
 * @param {(item: unknown) => unknown} [getPositionNo] ฟังก์ชันดึงเลขที่ตำแหน่งดิบจาก item แต่ละตัว
 *   (ค่าเริ่มต้น: ถ้า item เป็นสตริงใช้ตรงๆ ไม่งั้นอ่านจาก item.position_no)
 * @returns {Map<string, unknown>} Map<กุญแจ normalize แล้ว, item เดิม>
 */
function buildPositionNoIndex(items, getPositionNo = defaultGetPositionNo) {
  const index = new Map();

  for (const item of items) {
    const raw = getPositionNo(item);
    const key = normalizePositionNo(raw);
    if (key === null) continue; // ไม่มีเลขที่ตำแหน่ง - ไม่ขึ้น index (ไม่ถือเป็นการชนกัน)

    if (index.has(key)) {
      const existingRaw = getPositionNo(index.get(key));
      const error = new Error(
        `เลขที่ตำแหน่ง "${existingRaw}" และ "${raw}" normalize แล้วได้กุญแจเดียวกัน ("${key}") - ` +
          'ข้อมูลตำแหน่งขัดแย้งกันเอง ต้องตรวจแก้ข้อมูลต้นทางก่อน ไม่ auto-resolve'
      );
      error.code = 'POSITION_NO_KEY_COLLISION';
      error.key = key;
      error.existingPositionNo = existingRaw;
      error.incomingPositionNo = raw;
      throw error;
    }

    index.set(key, item);
  }

  return index;
}

module.exports = { normalizePositionNo, buildPositionNoIndex };
