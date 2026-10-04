const { maskBySchema } = require('../security/fieldMask');
const { getResponseSchemaForOperation } = require('../openapiSpec');
const { resolvePurposeCode } = require('../services/purposeCode');

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
  'provisionPerson',
  'deactivatePerson',
  'reactivatePerson',
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

// operation ที่คืนรายการบุคคล (ไม่มี personId เดียวใน path) - เขียน access_log หนึ่งแถวต่อบุคคลที่อยู่ในผลลัพธ์
// ไม่งั้นการค้นหาแล้วเห็นข้อมูลคนทั้งหน้าจะไม่มีร่องรอยใน audit เลย
const LIST_OPERATIONS = new Set(['searchPersons']);

// ?pidFormat=masked = ผู้เรียกขอไม่รับเลขเต็มแม้มี personnel:read:pid -> ตัดฟิลด์ที่ผูกกับ scope นั้นออกเหมือนไม่มี scope
function effectiveScopes(req) {
  const scopes = req.auth?.scope || [];
  return req.query?.pidFormat === 'masked' ? scopes.filter((s) => s !== 'personnel:read:pid') : scopes;
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
            finalBody = maskBySchema(schema, finalBody, effectiveScopes(req));
          }
        }
        if (
          operationId &&
          PERSONAL_DATA_OPERATIONS.has(operationId) &&
          req.auth &&
          res.statusCode < 400
        ) {
          const subjects = LIST_OPERATIONS.has(operationId)
            ? (Array.isArray(finalBody?.data) ? finalBody.data : [])
                .filter((item) => item?.personId)
                .map((item) => ({ personId: item.personId, fields: flattenFieldPaths(item) }))
            : [extractSubjectPersonId(req, finalBody)]
                .filter(Boolean)
                .map((personId) => ({ personId, fields: flattenFieldPaths(finalBody) }));

          if (subjects.length > 0) {
            const purposeCode = await resolvePurposeCode(pool, req.auth.azp);
            // แถวเดียวต่อบุคคล ใน query เดียว (ผลค้นหาหนึ่งหน้า <= 100 แถว)
            const values = [];
            const placeholders = subjects.map((subject, i) => {
              const base = i * 2;
              values.push(subject.personId, JSON.stringify(subject.fields));
              return `($${base + 1}, $${base + 2})`;
            });
            const shared = values.length;
            await pool.query(
              `INSERT INTO audit.access_log
                (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
                 fields_returned, purpose_code, justification, request_id, client_ip, response_status)
               SELECT v.subject_person_id::uuid, $${shared + 1}::text, $${shared + 2}::text, $${shared + 3}::text, $${shared + 4}::text, $${shared + 5}::text,
                      v.fields_returned::jsonb, $${shared + 6}::text, $${shared + 7}::text, $${shared + 8}::text, $${shared + 9}::inet, $${shared + 10}::int
               FROM (VALUES ${placeholders.join(', ')}) AS v(subject_person_id, fields_returned)`,
              [
                ...values,
                req.auth.personId ? 'USER' : 'SERVICE',
                req.auth.sub || null,
                req.auth.azp || null,
                req.originalUrl,
                req.method,
                purposeCode,
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
