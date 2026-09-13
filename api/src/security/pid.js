const crypto = require('node:crypto');

// checksum mod 11 ตามภาคผนวก ข ของเอกสารออกแบบ
function isValidPid(pid) {
  if (typeof pid !== 'string' || !/^\d{13}$/.test(pid)) return false;
  const sum = [...pid.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (13 - i), 0);
  return (11 - (sum % 11)) % 10 === Number(pid[12]);
}

// pepper (Buffer 32 ไบต์) มาจาก Vault KV ตอน boot เก็บใน memory เท่านั้น ห้ามเขียนลง disk/log (ภาคผนวก ข)
function pidHash(pid, pepper) {
  return crypto.createHmac('sha256', pepper).update(pid, 'utf8').digest('hex');
}

// ตัด claim ที่ไม่เกี่ยวกับ identity ทิ้ง (เช่น pid - มีเส้นทางจัดการแยกผ่าน pidHash/Vault ไม่ปนกับ
// การ hash เพื่อตรวจการเปลี่ยนแปลง), normalize string ตาม §3.3: Unicode NFC, trim, ยุบช่องว่างซ้ำ, "" -> null
// address ถูกทำให้เป็น object คีย์คงที่ (เก็บเฉพาะรหัสพื้นที่ ไม่เก็บชื่อ - nameTh เป็นข้อมูลอ้างอิงที่ไม่กระทบตัวตน)
const IDENTITY_STRING_FIELDS = ['titleTh', 'firstNameTh', 'middleNameTh', 'lastNameTh', 'titleEn', 'firstNameEn', 'lastNameEn', 'ial'];
const IDENTITY_PASSTHROUGH_FIELDS = ['gender', 'birthDate', 'idCardIssueDate', 'idCardExpireDate'];

function normalizeString(value) {
  if (value === null || value === undefined) return value;
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return normalized === '' ? null : normalized;
}

function normalizeAddress(address) {
  if (address === null || address === undefined) return address;
  return {
    houseNo: normalizeString(address.houseNo) ?? null,
    moo: normalizeString(address.moo) ?? null,
    soi: normalizeString(address.soi) ?? null,
    road: normalizeString(address.road) ?? null,
    subdistrictCode: normalizeString(address.subdistrict?.code) ?? null,
    districtCode: normalizeString(address.district?.code) ?? null,
    provinceCode: normalizeString(address.province?.code) ?? null,
    fullText: normalizeString(address.fullText) ?? null,
  };
}

// เก็บเฉพาะ key ที่มีอยู่จริงในคำขอ (undefined = DOPA ไม่ได้ส่งมา ต้องไม่เขียนทับของเดิม) - ใช้ทั้งสำหรับ
// diff รายฟิลด์และเป็น input ของ snapshotHash
function canonicalizeIdentityClaims(claims) {
  const canonical = {};

  for (const field of IDENTITY_STRING_FIELDS) {
    if (field in claims) canonical[field] = normalizeString(claims[field]);
  }
  for (const field of IDENTITY_PASSTHROUGH_FIELDS) {
    if (field in claims) canonical[field] = claims[field] ?? null;
  }
  if ('registeredAddress' in claims) {
    canonical.registeredAddress = normalizeAddress(claims.registeredAddress);
  }

  return canonical;
}

// แปลง object เป็น JSON string โดยเรียง key ตามตัวอักษร "ทุกชั้น" (recursive)
// หมายเหตุ: ภาคผนวก ข ใช้ JSON.stringify(obj, Object.keys(obj).sort()) ซึ่งไม่ทำงานถูกต้องกับ nested
// object จริง - replacer แบบ array ของ JSON.stringify จะใช้ชุด key เดียวกันกรองทุกชั้นความลึก ทำให้
// field ใน registeredAddress ที่ไม่ตรงกับ key ชั้นบนสุดถูกตัดทิ้งทั้งหมด สร้าง hash ที่ไม่สนใจที่อยู่เลย
// ฟังก์ชันนี้แก้ให้เรียง key แบบ recursive จริง ตรงตามเจตนา "คีย์เรียงตามตัวอักษร" ใน §3.3
function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function snapshotHash(canonicalClaims) {
  return crypto.createHash('sha256').update(canonicalJsonStringify(canonicalClaims), 'utf8').digest('hex');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// --- สำหรับ test/dev เท่านั้น ห้ามใช้ในโค้ด production path ---
// สร้างเลขบัตรปลอมที่ผ่าน checksum (ไม่ใช่เลขบัตรจริงของผู้ใด) ตามกฎข้อ 8 ของ CLAUDE.md
function makeFakePid() {
  const digits = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0);
  const check = (11 - (sum % 11)) % 10;
  return `${digits.join('')}${check}`;
}

module.exports = {
  isValidPid,
  pidHash,
  canonicalizeIdentityClaims,
  canonicalJsonStringify,
  snapshotHash,
  sha256Hex,
  makeFakePid,
  IDENTITY_STRING_FIELDS,
  IDENTITY_PASSTHROUGH_FIELDS,
};
