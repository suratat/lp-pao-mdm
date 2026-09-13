// ตัดฟิลด์ที่ผู้เรียกไม่มีสิทธิ์ออกจาก response ตาม x-required-scope ที่ประกาศไว้ใน schema ของ OpenAPI เอง
// (§2.2 ข้อ 2-3: "แต่ละกลุ่มฟิลด์ระบุ scope ที่ต้องใช้ไว้ใน x-required-scope ของ schema... ฟิลด์ที่ไม่มีสิทธิ์จะถูกตัดออก
// จาก response ไม่ใช่ null") schema ที่ส่งเข้ามาต้องผ่าน dereferenceSchema() มาก่อน ($ref/allOf ต้องคลี่แล้ว)
function maskBySchema(schema, data, scopes) {
  if (data === null || data === undefined || !schema) return data;

  if (Array.isArray(data)) {
    const itemSchema = schema.items;
    return data.map((item) => maskBySchema(itemSchema, item, scopes));
  }

  if (typeof data !== 'object' || !schema.properties) return data;

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in data)) continue;

    const requiredScope = propSchema['x-required-scope'];
    if (requiredScope && !scopes.includes(requiredScope)) {
      delete data[key];
      continue;
    }

    if (data[key] !== null && typeof data[key] === 'object') {
      data[key] = maskBySchema(propSchema, data[key], scopes);
    }
  }

  return data;
}

module.exports = { maskBySchema };
