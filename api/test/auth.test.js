const request = require('supertest');
const { buildTestApp } = require('./testApp');

let ctx;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.pool.end();
});

describe('การตรวจ JWT (§2.2 ข้อ 1: RS256 เท่านั้น, ตรวจ iss/aud)', () => {
  test('401 เมื่อไม่ส่ง token', async () => {
    const res = await request(ctx.app).get('/api/v1/org-units');
    expect(res.status).toBe(401);
    expect(res.type).toBe('application/problem+json');
  });

  test('401 เมื่อ token เซ็นด้วย HS256 แทน RS256 (alg confusion)', async () => {
    const token = await ctx.auth.signHs256Token({ scope: 'personnel:read:basic' });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('401 เมื่อ token ใช้ alg=none', async () => {
    const token = ctx.auth.buildNoneAlgToken({ scope: 'personnel:read:basic' });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('401 เมื่อ issuer ไม่ตรงกับ realm ที่กำหนด', async () => {
    const token = await ctx.auth.signToken({
      issuer: 'https://evil.example/realms/fake',
      scope: 'personnel:read:basic',
    });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('401 เมื่อ audience ไม่มี mdm-api', async () => {
    const token = await ctx.auth.signToken({ audience: 'some-other-api', scope: 'personnel:read:basic' });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('401 เมื่อ token หมดอายุแล้ว', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic', expiresIn: '-1s' });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test('403 เมื่อ token ถูกต้องแต่ scope ไม่พอ', async () => {
    const token = await ctx.auth.signToken({ scope: 'events:read' });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.type).toBe('application/problem+json');
  });

  test('200 เมื่อ token ถูกต้องครบทุกเงื่อนไข (RS256, iss/aud ตรง, scope พอ)', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:read:basic' });
    const res = await request(ctx.app).get('/api/v1/org-units').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
