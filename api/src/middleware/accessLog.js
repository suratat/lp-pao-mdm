const { maskBySchema } = require('../security/fieldMask');
const { getResponseSchemaForOperation } = require('../openapiSpec');

// เฉพาะ operation ที่ในสเกลตันนี้คืนข้อมูลของบุคคลจริงที่มีอยู่ใน DB (ไม่ใช่ stub ที่ยังไม่ได้ต่อ service จริง)
// endpoint ที่เหลือ (provision/deactivate/sync ฯลฯ) เป็น business logic ของ T3-T5 ซึ่งต้องเขียน access_log
// ภายใน transaction เดียวกับการเปลี่ยนข้อมูลตอนนั้น ไม่ใช่ผ่าน middleware ทั่วไปนี้
// §2.1 (Me): "เจ้าของข้อมูลเห็นทุกกลุ่มฟิลด์ของตนเองรวมสถานะการยืนยัน ThaID" - GET /me ไม่ผ่าน field mask ตาม scope
// ปกติ เพราะเจ้าของข้อมูลมีสิทธิ์เห็นข้อมูลของตนเองทุกกลุ่มเสมอ ต่างจากระบบภายนอกที่ต้องมี scope รายกลุ่ม
const BYPASS_MASK_OPERATIONS = new Set(['getMe']);

const PERSONAL_DATA_OPERATIONS = new Set([
  'searchPersons',
  'getPerson',
  'getMe',
  'getEmployment',
  'listStalePersons',
  'getPersonChangeLog',
  'listAccessLogs',
]);

// ไม่ระบุ index ของ array (เช่น emergencyContacts[0].phone) เพื่อไม่ให้ path ยาวเกินจำเป็นและกันข้อมูลระเบิด
function flattenFieldPaths(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    out.push(prefix);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      flattenFieldPaths(v, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

function extractSubjectPersonId(req, body) {
  return req.params.personId || body?.personId || req.auth?.personId || null;
}

// middleware เดียวที่ทำสองหน้าที่ต่อกัน: (1) ตัดฟิลด์นอก scope ด้วย fieldMask (2) บันทึก access_log
// ด้วย fields_returned ของข้อมูล "หลังกรองแล้ว" - ต้อง mask ก่อนคำนวณ fields_returned เสมอ (ตามลำดับในฟังก์ชันนี้)
// ต่างจากการมองว่าเป็น middleware สองตัวแยกกันแล้วต้องมาคอยเรียงลำดับ mount ให้ถูกต้อง
function personalDataResponseMiddleware(spec, pool) {
  return function (req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = async (body) => {
      try {
        const operation = req.openapi?.schema;
        const operationId = operation?.operationId;
        let finalBody = body;

        if (operation && !BYPASS_MASK_OPERATIONS.has(operationId)) {
          const schema = getResponseSchemaForOperation(spec, operation, res.statusCode);
          if (schema) {
            finalBody = maskBySchema(schema, finalBody, req.auth?.scope || []);
          }
        }
        if (
          operationId &&
          PERSONAL_DATA_OPERATIONS.has(operationId) &&
          req.auth &&
          res.statusCode < 400
        ) {
          const subjectPersonId = extractSubjectPersonId(req, finalBody);
          if (subjectPersonId) {
            await pool.query(
              `INSERT INTO audit.access_log
                (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
                 fields_returned, purpose_code, justification, request_id, client_ip, response_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                subjectPersonId,
                req.auth.personId ? 'USER' : 'SERVICE',
                req.auth.sub || null,
                req.auth.azp || null,
                req.originalUrl,
                req.method,
                JSON.stringify(flattenFieldPaths(finalBody)),
                req.query.purposeCode || null,
                req.query.justification || null,
                req.id || null,
                req.ip,
                res.statusCode,
              ]
            );
          }
        }

        originalJson(finalBody);
      } catch (err) {
        next(err);
      }
    };

    next();
  };
}

module.exports = { personalDataResponseMiddleware, flattenFieldPaths, PERSONAL_DATA_OPERATIONS };
