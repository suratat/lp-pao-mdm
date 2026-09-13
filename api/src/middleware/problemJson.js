const crypto = require('node:crypto');
const { HttpProblem } = require('../security/httpProblem');

const PROBLEM_BASE_URI = 'https://mdm.lp-pao.go.th/problems';

// ติด requestId ให้ทุก request (ใช้จับคู่กับ access_log.request_id ตาม §2.4)
function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// ส่งตรงด้วย res.end() แทน res.json() เพราะ express-openapi-validator ผูก hook ไว้ที่ res.json ทุก route
// เพื่อตรวจ response ตาม status code ที่ "ประกาศไว้ในสเปกของ operation นั้น" เท่านั้น - หลาย operation ในสเปก
// ไม่ได้ประกาศ 401/403 ไว้ (อาศัย security requirement ระดับ operation แทน) เรียก res.json ตรงนี้จะถูกปฏิเสธ
// ด้วย "no schema defined for status code" กลายเป็น 500 ซ้อน 500 - error response จึงต้องไม่ผ่าน mask/access-log
// (ถูกต้องอยู่แล้ว เพราะ error ไม่ใช่ข้อมูลส่วนบุคคลที่ต้องกรอง/บันทึก)
function sendProblem(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/problem+json');
  res.end(JSON.stringify(body));
}

// express-openapi-validator โยน error ที่มี .status/.errors อยู่แล้วสำหรับ request ไม่ผ่าน schema
// แปลงทุก error ให้เป็น RFC 9457 เดียวกันหมด ไม่ว่าจะมาจาก validator, HttpProblem, หรือ error ที่ไม่คาดคิด
function problemJsonErrorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const type = err instanceof HttpProblem ? err.type : status === 500 ? 'internal-error' : 'bad-request';
  const title = err instanceof HttpProblem ? err.title : err.message || 'เกิดข้อผิดพลาด';

  const body = {
    type: `${PROBLEM_BASE_URI}/${type}`,
    title,
    status,
    detail: err instanceof HttpProblem ? err.detail : undefined,
    instance: req.originalUrl,
    requestId: req.id,
  };

  // express-openapi-validator ใส่รายละเอียด per-field ไว้ใน err.errors
  if (Array.isArray(err.errors)) {
    body.errors = err.errors.map((e) => ({
      field: e.path,
      code: e.errorCode || e.code,
      message: e.message,
    }));
  }

  if (err instanceof HttpProblem && err.extra) {
    Object.assign(body, err.extra);
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[${req.id}]`, err);
  }

  sendProblem(res, status, body);
}

function notFoundHandler(req, res) {
  sendProblem(res, 404, {
    type: `${PROBLEM_BASE_URI}/not-found`,
    title: 'ไม่พบ endpoint นี้',
    status: 404,
    instance: req.originalUrl,
    requestId: req.id,
  });
}

module.exports = { requestId, problemJsonErrorHandler, notFoundHandler, PROBLEM_BASE_URI };
