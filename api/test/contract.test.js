const request = require('supertest');
const { buildTestApp } = require('./testApp');
const { operations } = require('./operations');

let ctx;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.pool.end();
});

// express-openapi-validator ตั้ง validateResponses: true ไว้แล้วใน src/app.js - ถ้า response ไม่ตรง schema
// ของ personnel-mdm-openapi.yaml มันจะโยน error ซึ่งกลายเป็น 500 ผ่าน problemJsonErrorHandler
// ดังนั้นการ assert ว่า status ตรงกับที่คาด (ไม่ใช่ 500) ก็คือการยืนยันว่า response ตรงตามสัญญาจริงแล้ว
describe.each(operations)('$method $path ($name)', (op) => {
  test(`ตอบ ${op.expectStatus} ตาม schema ใน OpenAPI`, async () => {
    let req = request(ctx.app)[op.method](`/api/v1${op.path}`);

    if (op.query) req = req.query(op.query);

    if (!op.noAuth) {
      const token = await ctx.auth.signToken({ scope: op.scope, personId: op.personId });
      req = req.set('Authorization', `Bearer ${token}`);
    }

    if (op.body !== undefined) {
      req = req.send(op.body);
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
