const { Pool } = require('pg');
const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');
const { buildOperationDescriptors, seedFixtures } = require('./operations');

// §2.3 SSRF allow-list: createWebhookSubscription ต้องมี host นี้อยู่ใน WEBHOOK_ALLOWED_HOSTS จึงจะผ่าน
// validateWebhookUrl() ได้ (ค่านี้อ่านจาก env แบบ dynamic ทุกครั้งที่เรียก ไม่ใช่ตอน boot จึงตั้งได้ที่นี่)
process.env.WEBHOOK_ALLOWED_HOSTS = process.env.WEBHOOK_ALLOWED_HOSTS || 'example.lp-pao.go.th';

// รายการ operation เป็น static (ไม่แตะ DB/vault) เรียกได้ทันทีตอน module load ตามที่ Jest ต้องการสำหรับ
// describe.each - ส่วน ids (person/position/subscription ที่มีอยู่จริงใน DB) ผูกไว้ทีหลังใน beforeAll
// (ดูคอมเมนต์สถาปัตยกรรมใน operations.js)
const operations = buildOperationDescriptors();

let ctx;
let adminPool;
let ids;

beforeAll(async () => {
  ctx = await buildTestApp();
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });
  ids = await seedFixtures({ adminPool, vault: ctx.vault });
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

// express-openapi-validator ตั้ง validateResponses: true ไว้แล้วใน src/app.js - ถ้า response ไม่ตรง schema
// ของ personnel-mdm-openapi.yaml มันจะโยน error ซึ่งกลายเป็น 500 ผ่าน problemJsonErrorHandler
// ดังนั้นการ assert ว่า status ตรงกับที่คาด (ไม่ใช่ 500) ก็คือการยืนยันว่า response ตรงตามสัญญาจริงแล้ว
describe.each(operations)('$method $pathTemplate ($name)', (op) => {
  test(`ตอบ ${op.expectStatus} ตาม schema ใน OpenAPI`, async () => {
    const path = op.path(ids);
    let req = request(ctx.app)[op.method](`/api/v1${path}`);

    if (op.query) req = req.query(op.query);

    if (!op.noAuth) {
      const personId = typeof op.personId === 'function' ? op.personId(ids) : op.personId;
      const token = await ctx.auth.signToken({ scope: op.scope, personId });
      req = req.set('Authorization', `Bearer ${token}`);
    }

    if (op.body !== undefined) {
      const body = typeof op.body === 'function' ? op.body(ids) : op.body;
      req = req.send(body);
    }

    const res = await req;

    if (res.status === 500) {
      // eslint-disable-next-line no-console
      console.error(`${op.name} ล้มเหลว (schema ไม่ตรง หรือ error อื่น):`, res.body);
    }

    expect(res.status).toBe(op.expectStatus);

    if (!op.binary && res.status !== 204 && res.status !== 202) {
      expect(res.type).toMatch(/json/);
    }
  });
});
