const crypto = require('node:crypto');
const request = require('supertest');
const { SignJWT } = require('jose');
const { Pool } = require('pg');
const { buildTestApp } = require('./testApp');
const { MIGRATOR_DATABASE_URL } = require('./config');

// T9: ตรวจกลไก X-Acting-Person (ทางเลือก B, §0.3) ที่ mdm-portal ใช้แทน person_id claim ในตัว token เอง
// ต้องไม่กระทบ token แบบ A (person_id claim ในตัว token) ที่ T2/T5 ใช้อยู่แล้ว

const SECRET = 'test-acting-assertion-secret-please-rotate';
const ALLOWED_AZP = ['mdm-portal'];

let ctx;
let adminPool;
let personId;

beforeAll(async () => {
  ctx = await buildTestApp({ actingAssertion: { secret: SECRET, allowedAzp: ALLOWED_AZP } });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });

  personId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), now(), 1)`,
    [personId, crypto.randomBytes(32).toString('hex')]
  );
  await adminPool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาง', 'ทดสอบ', 'T9', '1990-01-01', 'F', now())`,
    [personId]
  );
});

afterAll(async () => {
  await ctx.pool.end();
  await adminPool.end();
});

async function signActingPerson({ sub = personId, issuer = 'mdm-portal', audience = 'mdm-api', secret = SECRET, expiresIn = '30s' } = {}) {
  const key = new TextEncoder().encode(secret);
  let jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setSubject(sub).setExpirationTime(expiresIn);
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  return jwt.sign(key);
}

async function portalToken(scope = 'personnel:self') {
  // token ของ client mdm-portal (service account) - ไม่มี person_id claim เพราะเป็นทางเลือก B
  return ctx.auth.signToken({ scope, sub: 'mdm-portal', azp: 'mdm-portal' });
}

describe('X-Acting-Person (ทางเลือก B, §0.3)', () => {
  test('200 และเห็นข้อมูลของ personId ใน assertion เมื่อ token+assertion ถูกต้อง', async () => {
    const token = await portalToken();
    const assertion = await signActingPerson();
    const res = await request(ctx.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-Person', assertion);
    expect(res.status).toBe(200);
    expect(res.body.personId).toBe(personId);
  });

  test('403 user-context-required เมื่อไม่มี X-Acting-Person เลย (token เป็น service account ล้วน)', async () => {
    const token = await portalToken();
    const res = await request(ctx.app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('401 เมื่อ assertion เซ็นด้วย secret ผิด', async () => {
    const token = await portalToken();
    const assertion = await signActingPerson({ secret: 'wrong-secret' });
    const res = await request(ctx.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-Person', assertion);
    expect(res.status).toBe(401);
    expect(res.body.type ?? res.body.title).toBeDefined();
  });

  test('401 เมื่อ assertion หมดอายุ', async () => {
    const token = await portalToken();
    const assertion = await signActingPerson({ expiresIn: '-1s' });
    const res = await request(ctx.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-Person', assertion);
    expect(res.status).toBe(401);
  });

  test('401 เมื่อ issuer ของ assertion ไม่ใช่ mdm-portal', async () => {
    const token = await portalToken();
    const assertion = await signActingPerson({ issuer: 'someone-else' });
    const res = await request(ctx.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-Person', assertion);
    expect(res.status).toBe(401);
  });

  test('403 เมื่อ azp ของ Bearer token ไม่อยู่ใน allowlist แม้ assertion จะถูกต้อง (กัน client อื่นสวมรอย)', async () => {
    const token = await ctx.auth.signToken({ scope: 'personnel:self', sub: 'eoffice', azp: 'eoffice' });
    const assertion = await signActingPerson();
    const res = await request(ctx.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-Person', assertion);
    expect(res.status).toBe(403);
  });

  test('403 เมื่อ scope ไม่มี personnel:self แม้ azp จะอยู่ใน allowlist', async () => {
    const token = await portalToken('personnel:read:basic');
    const assertion = await signActingPerson();
    const res = await request(ctx.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acting-Person', assertion);
    expect(res.status).toBe(403);
  });

  test('ไม่มีผลกับ token แบบ A (person_id claim ในตัว token เอง) แม้จะไม่ได้ตั้งค่า actingAssertion', async () => {
    const noAssertionCtx = await buildTestApp();
    try {
      const token = await noAssertionCtx.auth.signToken({ scope: 'personnel:self', personId });
      const res = await request(noAssertionCtx.app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.personId).toBe(personId);
    } finally {
      await noAssertionCtx.pool.end();
    }
  });

  test('X-Acting-Person ถูกเพิกเฉยเมื่อ deployment ไม่ได้ตั้ง secret ไว้ (ปิดเงียบ)', async () => {
    const noAssertionCtx = await buildTestApp();
    try {
      const token = await noAssertionCtx.auth.signToken({ scope: 'personnel:self', sub: 'mdm-portal', azp: 'mdm-portal' });
      const assertion = await signActingPerson();
      const res = await request(noAssertionCtx.app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Acting-Person', assertion);
      expect(res.status).toBe(403); // ไม่มี person_id claim และ assertion ไม่ถูกตรวจเลย
    } finally {
      await noAssertionCtx.pool.end();
    }
  });
});
