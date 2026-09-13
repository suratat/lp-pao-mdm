const { parse } = require('csv-parse/sync');

// อ่าน CSV (มี header row) แล้ว map หัวคอลัมน์จริง -> ชื่อฟิลด์ตรรกะภายในตาม columnMap.columns
// (migrate/config/column-map.json) คอลัมน์ที่ไม่ได้ map ไว้ถูกละทิ้ง (ยังเก็บอยู่ใน source_data เต็มแถวเสมอ)
function mapRow(rawRecord, columns, index) {
  const logical = {};
  for (const [logicalField, sourceHeader] of Object.entries(columns)) {
    const value = rawRecord[sourceHeader];
    logical[logicalField] = value === undefined || value === '' ? null : String(value).trim();
  }
  if (!logical.rowRef) logical.rowRef = String(index + 1);
  return { logical, raw: rawRecord };
}

// csvContent: string (UTF-8) - รูปแบบไฟล์จริงจาก LHR/Excel ฝ่ายบุคคลยังไม่ยืนยัน (ภาคผนวก ง ข้อ 2)
// จึงรองรับเฉพาะ CSV มาตรฐาน (UTF-8, มี header row) ตาม decision ที่ยืนยันไว้สำหรับ T8
function parseCsv(csvContent, columnMap) {
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  return records.map((record, index) => mapRow(record, columnMap.columns, index));
}

module.exports = { parseCsv };
