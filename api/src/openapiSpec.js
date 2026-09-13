const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// สัญญาของ API ห้ามแก้ไขจากฝั่งนี้ (CLAUDE.md ข้อ 1.2) - โหลดจากไฟล์เดียวกับที่ express-openapi-validator ใช้
const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'design', 'personnel-mdm-openapi.yaml');

let cachedSpec = null;

function loadSpec() {
  if (!cachedSpec) {
    cachedSpec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
  }
  return cachedSpec;
}

function resolveRef(spec, ref) {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, key) => node?.[key], spec);
}

const dereferenceCache = new WeakMap();

// แปลง $ref / allOf ในสคีมาให้เป็น object เดียวที่เดินได้ตรงๆ (ใช้กับ fieldMask ที่ต้องอ่าน x-required-scope
// ของฟิลด์ที่ซ้อนอยู่หลังชั้น $ref) มี cache กันประมวลผลซ้ำและกันกรณี schema อ้างวนกัน
function dereferenceSchema(spec, schema) {
  if (!schema || typeof schema !== 'object') return schema;

  if (schema.$ref) {
    return dereferenceSchema(spec, resolveRef(spec, schema.$ref));
  }

  if (dereferenceCache.has(schema)) {
    return dereferenceCache.get(schema);
  }

  const result = { ...schema };
  dereferenceCache.set(schema, result);

  if (Array.isArray(result.allOf)) {
    const mergedProperties = {};
    const mergedRequired = [];
    for (const member of result.allOf) {
      const resolvedMember = dereferenceSchema(spec, member);
      Object.assign(mergedProperties, resolvedMember.properties || {});
      mergedRequired.push(...(resolvedMember.required || []));
    }
    delete result.allOf;
    result.type = result.type || 'object';
    result.properties = { ...mergedProperties, ...(result.properties || {}) };
    result.required = [...new Set([...(result.required || []), ...mergedRequired])];
  }

  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([key, value]) => [key, dereferenceSchema(spec, value)])
    );
  }
  if (result.items) {
    result.items = dereferenceSchema(spec, result.items);
  }

  return result;
}

function getResponseSchemaForOperation(spec, operation, statusCode) {
  if (!operation?.responses) return null;
  const response = operation.responses[String(statusCode)] || operation.responses.default;
  const jsonSchema = response?.content?.['application/json']?.schema;
  if (!jsonSchema) return null;
  return dereferenceSchema(spec, jsonSchema);
}

module.exports = { loadSpec, resolveRef, dereferenceSchema, getResponseSchemaForOperation, SPEC_PATH };
