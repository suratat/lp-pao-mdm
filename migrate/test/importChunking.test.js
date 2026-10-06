const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { buildTestApp } = require('../../api/test/testApp');
const { makeFakePid } = require('../../api/src/security/pid');
const { DATABASE_URL, MIGRATOR_DATABASE_URL } = require('./config');
const { runImport, ImportError, MAX_BODY_BYTES } = require('../src/import/runImport');
const { cmdImport } = require('../src/cli');
const { reconcileBatch } = require('../src/reconcile/reconcile');
const { makeOrgUnit } = require('./fixtures');

// ทดสอบการแบ่ง chunk ตามไบต์ของ runImport (ไม่ขยาย limit ของ API): ข้อมูลทั้งหมดเป็นข้อมูลสังเคราะห์ (makeFakePid)
// และ DB ต้องเป็น container ในเครื่อง (ดู assertLocalDatabase) ห้ามชี้ VPN-MDM

const API_BODY_LIMIT_BYTES = 100 * 1024; // express.json() default (api/src/app.js)
const th = (n) => 'ก'.repeat(n);

let pool;
let adminPool;
let apiCtx;
let server;
let apiBaseUrl;
let token;
let orgUnit;

function assertLocalDatabase(url) {
  const { hostname } = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error(`DATABASE_URL ของเทสต์ต้องชี้เครื่องนี้เท่านั้น (ห้ามชี้ VPN-MDM) แต่ได้ host=${hostname}`);
  }
}

beforeAll(async () => {
  assertLocalDatabase(DATABASE_URL);
  assertLocalDatabase(MIGRATOR_DATABASE_URL);

  pool = new Pool({ connectionString: DATABASE_URL });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });

  apiCtx = await buildTestApp();
  server = apiCtx.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  apiBaseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  token = await apiCtx.auth.signToken({ scope: 'personnel:import' });

  orgUnit = await makeOrgUnit(adminPool);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await apiCtx.pool.end();
  await pool.end();
  await adminPool.end();
});

// สร้าง batch ที่ผ่านตรวจคุณภาพแล้ว (quality_status = OK) ด้วยข้อมูลสังเคราะห์ ประเภท "พนักงานจ้าง" (ไม่ต้องมีเลขที่ตำแหน่ง)
async function seedBatch(count, { jobTitleLength = 40, oversizedRowRef = null } = {}) {
  const {
    rows: [{ batch_id: batchId }],
  } = await adminPool.query(
    `INSERT INTO stg_hr.import_batch (source_filename, imported_by, status)
     VALUES ('synthetic.csv', 'tester', 'QUALITY_CHECKED') RETURNING batch_id`
  );
  const rowRefs = Array.from({ length: count }, (_, i) => String(i + 1).padStart(4, '0'));
  const pids = rowRefs.map(() => makeFakePid());
  const jobTitles = rowRefs.map((ref) => (ref === oversizedRowRef ? 'x'.repeat(70000) : th(jobTitleLength)));

  await adminPool.query(
    `INSERT INTO stg_hr.raw_row (
       batch_id, row_ref, pid_plaintext, pid_loaded_at, expected_first_name_th, expected_last_name_th,
       personnel_type_raw, org_unit_code, job_title_text, appointed_date_raw, effective_from_raw,
       quality_status, resolved_org_unit_id, source_data)
     SELECT $1, t.ref, t.pid, now(), 'ทดสอบ', 'นำเข้า', 'พนักงานจ้าง', $4, t.job, '01/10/2560', '01/10/2560',
            'OK', $5, '{}'::jsonb
     FROM unnest($2::text[], $3::text[], $6::text[]) AS t(ref, pid, job)`,
    [batchId, rowRefs, pids, orgUnit.code, orgUnit.orgUnitId, jobTitles]
  );
  return { batchId, rowRefs, pids };
}

const jsonRes = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const okResult = (body, overrides = {}) => ({
  mode: body.mode,
  total: body.rows.length,
  created: body.rows.length,
  updated: 0,
  unchanged: 0,
  errors: [],
  ...overrides,
});

// stub ของ fetch: บันทึกทุกคำขอ และจำลอง 413 ของ express.json() เมื่อ body เกิน 100 KB
function makeStubFetch(handler = (call) => jsonRes(200, okResult(call.body))) {
  const calls = [];
  const chunkOrder = []; // firstRowRef ของแต่ละ chunk ตามลำดับที่ถูกส่งครั้งแรก (ใช้ระบุ chunk ที่ retry ซ้ำ)
  const stub = async (url, init) => {
    const bytes = Buffer.byteLength(init.body);
    const body = JSON.parse(init.body);
    const firstRowRef = body.rows[0]?.rowRef;
    if (!chunkOrder.includes(firstRowRef)) chunkOrder.push(firstRowRef);
    const call = {
      url,
      bytes,
      body,
      headers: init.headers,
      firstRowRef,
      chunkOrdinal: chunkOrder.indexOf(firstRowRef) + 1,
      attemptOfChunk: calls.filter((c) => c.firstRowRef === firstRowRef).length + 1,
    };
    calls.push(call);
    if (bytes > API_BODY_LIMIT_BYTES) return jsonRes(413, { status: 413 });
    return handler(call);
  };
  stub.calls = calls;
  return stub;
}

const run = (batchId, fetchImpl, opts = {}) =>
  runImport(pool, { apiBaseUrl: 'http://stub.invalid/api/v1', token: 'stub-token-value', batchId, mode: 'APPLY', createIfMissing: true, retryDelayMs: 0, fetchImpl, ...opts });

const batchStatus = async (batchId) =>
  (await adminPool.query(`SELECT status FROM stg_hr.import_batch WHERE batch_id = $1`, [batchId])).rows[0].status;

describe('runImport: แบ่ง chunk ตามไบต์ และรวมผล', () => {
  test('PR-D1: ทุก request ส่ง reason ระดับ batch "HR_IMPORT batch <batchId>" อัตโนมัติ (API บังคับ) และ body ยังไม่เกินงบไบต์ (envelope นับ reason แล้ว)', async () => {
    const { batchId } = await seedBatch(400);
    const stub = makeStubFetch();
    await run(batchId, stub);
    expect(stub.calls.length).toBeGreaterThan(1);
    for (const call of stub.calls) {
      expect(call.body.reason).toBe(`HR_IMPORT batch ${batchId}`);
      expect(call.body.reason).not.toMatch(/\d{13}/); // batchId เป็น UUID ไม่ใช่เลขบัตร
      expect(call.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
    }
    // DRY_RUN ก็ต้องส่ง (API บังคับทุก mode)
    const dryStub = makeStubFetch();
    await run(batchId, dryStub, { mode: 'DRY_RUN' });
    expect(dryStub.calls.every((c) => c.body.reason === `HR_IMPORT batch ${batchId}`)).toBe(true);
  });

  test('800 แถวสังเคราะห์ -> หลาย request, ไม่มี request ใดเกิน limit, รวมผลถูกต้อง, บันทึกเวลาต่อ chunk', async () => {
    const { batchId } = await seedBatch(800);
    const stub = makeStubFetch();

    const summary = await run(batchId, stub);

    expect(stub.calls.length).toBeGreaterThan(1);
    for (const call of stub.calls) {
      expect(call.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
      expect(call.bytes).toBeLessThan(API_BODY_LIMIT_BYTES);
    }
    expect(stub.calls.flatMap((c) => c.body.rows.map((r) => r.rowRef))).toHaveLength(800);
    expect(new Set(stub.calls.flatMap((c) => c.body.rows.map((r) => r.rowRef))).size).toBe(800);

    expect(summary).toMatchObject({ mode: 'APPLY', total: 800, created: 800, updated: 0, unchanged: 0, errors: [] });
    expect(summary.chunks).toHaveLength(stub.calls.length);
    expect(summary.chunks.reduce((n, c) => n + c.rows, 0)).toBe(800);
    summary.chunks.forEach((c, i) => {
      expect(c).toMatchObject({ index: i + 1, attempts: 1 });
      expect(c.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
      expect(c.bytes).toBe(stub.calls[i].bytes);
      expect(Number.isInteger(c.durationMs)).toBe(true);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
    });
    expect(Number.isInteger(summary.elapsedMs)).toBe(true);

    // Idempotency-Key ต่างกันทุก request (API ยังไม่ implement - ดูแผน: ใช้ random ต่อ request)
    expect(new Set(stub.calls.map((c) => c.headers['Idempotency-Key'])).size).toBe(stub.calls.length);
    expect(await batchStatus(batchId)).toBe('APPLIED');
  });

  test('ผลต่าง chunk ต่างกัน (updated/unchanged/errors) -> รวมถูกและ errors ต่อกันครบ, import_result_code ถูกบันทึก', async () => {
    const { batchId } = await seedBatch(300);
    const stub = makeStubFetch((call) => {
      const [first, ...rest] = call.body.rows;
      rest.shift();
      if (call.chunkOrdinal === 1) {
        return jsonRes(200, okResult(call.body, {
          created: 0, updated: 1, unchanged: rest.length,
          errors: [{ rowRef: first.rowRef, code: 'ORG_UNIT_NOT_FOUND', message: 'ไม่พบสังกัด' }],
          total: call.body.rows.length,
        }));
      }
      return jsonRes(200, okResult(call.body));
    });

    const summary = await run(batchId, stub);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ code: 'ORG_UNIT_NOT_FOUND' });
    expect(summary.created + summary.updated + summary.unchanged + summary.errors.length).toBe(300);
    expect(summary.updated).toBe(1);

    const { rows } = await adminPool.query(
      `SELECT import_result_code FROM stg_hr.raw_row WHERE batch_id = $1 AND row_ref = $2`,
      [batchId, summary.errors[0].rowRef]
    );
    expect(rows[0].import_result_code).toBe('ORG_UNIT_NOT_FOUND');
  });

  test('แถวเดียวเกินงบ -> รายงาน ROW_TOO_LARGE ไม่ส่ง แต่แถวอื่นยังส่งครบและรวมผลครบทุกแถว', async () => {
    const { batchId } = await seedBatch(50, { oversizedRowRef: '0007' });
    const stub = makeStubFetch();

    const summary = await run(batchId, stub);

    expect(summary.total).toBe(50);
    expect(summary.created).toBe(49);
    expect(summary.errors).toEqual([expect.objectContaining({ rowRef: '0007', code: 'ROW_TOO_LARGE' })]);
    expect(stub.calls.flatMap((c) => c.body.rows.map((r) => r.rowRef))).not.toContain('0007');
    const { rows } = await adminPool.query(
      `SELECT import_result_code FROM stg_hr.raw_row WHERE batch_id = $1 AND row_ref = '0007'`,
      [batchId]
    );
    expect(rows[0].import_result_code).toBe('ROW_TOO_LARGE');
  });

  test('ผลของ API ที่ตัวเลขไม่รวมเท่าจำนวนแถวที่ส่ง -> ล้มด้วย IMPORT_RESULT_MISMATCH ไม่รายงานผลเงียบๆ', async () => {
    const { batchId } = await seedBatch(20);
    const stub = makeStubFetch((call) => jsonRes(200, okResult(call.body, { created: call.body.rows.length - 1 })));

    await expect(run(batchId, stub)).rejects.toMatchObject({ code: 'IMPORT_RESULT_MISMATCH' });
    expect(await batchStatus(batchId)).toBe('QUALITY_CHECKED');
  });
});

describe('runImport: retry และการล้มกลางทาง', () => {
  test('5xx ที่ chunk กลางทาง 2 ครั้งแล้วสำเร็จ -> นับแถวจากคำขอที่สำเร็จครั้งสุดท้ายเท่านั้น ไม่นับซ้ำจาก retry', async () => {
    const { batchId } = await seedBatch(300);
    const stub = makeStubFetch((call) => {
      if (call.chunkOrdinal === 2 && call.attemptOfChunk <= 2) return jsonRes(503, { status: 503 });
      return jsonRes(200, okResult(call.body));
    });

    const summary = await run(batchId, stub);

    expect(summary).toMatchObject({ total: 300, created: 300, errors: [] });
    expect(summary.chunks[1].attempts).toBe(3);
    expect(stub.calls.length).toBe(summary.chunks.length + 2);
  });

  test('network error 1 ครั้งแล้วสำเร็จ -> retry ได้', async () => {
    const { batchId } = await seedBatch(300);
    let thrown = false;
    const inner = makeStubFetch();
    const flaky = async (url, init) => {
      if (!thrown) {
        thrown = true;
        throw new TypeError('fetch failed');
      }
      return inner(url, init);
    };

    const summary = await run(batchId, flaky);

    expect(summary).toMatchObject({ total: 300, created: 300 });
    expect(summary.chunks[0].attempts).toBe(2);
  });

  test('5xx ตลอด (retry ครบ 2 ครั้ง) ที่ chunk 2 ใน APPLY -> ล้มพร้อมผลบางส่วน, ไม่ตั้ง APPLIED, บอกว่า chunk ก่อนหน้า commit แล้ว', async () => {
    const { batchId } = await seedBatch(300);
    const stub = makeStubFetch((call) =>
      call.chunkOrdinal === 2 ? jsonRes(500, { status: 500 }) : jsonRes(200, okResult(call.body))
    );

    const error = await run(batchId, stub).catch((e) => e);

    expect(error).toBeInstanceOf(ImportError);
    expect(error.code).toBe('IMPORT_CHUNK_FAILED');
    expect(stub.calls.filter((c) => c.chunkOrdinal === 2)).toHaveLength(3); // 1 + retry 2 ครั้ง
    expect(stub.calls.filter((c) => c.chunkOrdinal > 2)).toHaveLength(0); // ไม่ส่ง chunk ถัดไปต่อ
    expect(error.message).toContain('commit แล้ว');

    const partial = error.partialSummary;
    const firstChunkRows = stub.calls[0].body.rows.length;
    expect(partial).toMatchObject({ status: 'PARTIAL', mode: 'APPLY', created: firstChunkRows });
    expect(partial.failedChunk).toMatchObject({ index: 2, httpStatus: 500 });
    expect(partial.rowsSent).toBe(firstChunkRows);
    expect(partial.rowsNotSent).toBe(300 - firstChunkRows);
    expect(partial.chunks).toHaveLength(1);
    expect(await batchStatus(batchId)).toBe('QUALITY_CHECKED');
  });

  test('401 กลางทาง -> ล้มทันที (ไม่ retry) ข้อความบอก token หมดอายุ + แถวก่อนหน้า commit แล้ว (APPLY) / ไม่ commit (DRY_RUN)', async () => {
    for (const [mode, expected] of [['APPLY', 'commit แล้ว'], ['DRY_RUN', 'ไม่ถูก commit']]) {
      const { batchId } = await seedBatch(300);
      const stub = makeStubFetch((call) =>
        call.chunkOrdinal === 2 ? jsonRes(401, { status: 401 }) : jsonRes(200, okResult(call.body, { mode }))
      );

      const error = await run(batchId, stub, { mode }).catch((e) => e);

      expect(error.code).toBe('TOKEN_EXPIRED');
      expect(error.message).toContain('token หมดอายุ');
      expect(error.message).toContain(expected);
      expect(error.message).not.toContain('stub-token-value');
      expect(stub.calls.filter((c) => c.chunkOrdinal === 2)).toHaveLength(1);
      expect(error.partialSummary.status).toBe('PARTIAL');
    }
  });

  test('413 / 4xx อื่น -> ไม่ retry ล้มทันทีด้วย IMPORT_CHUNK_REJECTED', async () => {
    const { batchId } = await seedBatch(300);
    const stub = makeStubFetch((call) => (call.chunkOrdinal === 1 ? jsonRes(413, { status: 413 }) : jsonRes(200, okResult(call.body))));

    const error = await run(batchId, stub).catch((e) => e);

    expect(error.code).toBe('IMPORT_CHUNK_REJECTED');
    expect(error.partialSummary.failedChunk).toMatchObject({ index: 1, httpStatus: 413 });
    expect(stub.calls).toHaveLength(1);
  });
});

describe('กับ API จริง', () => {
  test('PR-D1: API จริงรับ batch ที่ runImport ส่ง (มี reason) และเก็บ reason เป็น "HR_IMPORT batch <id>" ในทุกแถว data_change_log (changed_by HR_IMPORT)', async () => {
    const { batchId } = await seedBatch(5);
    const summary = await runImport(pool, { apiBaseUrl, token, batchId, mode: 'APPLY', createIfMissing: true, retryDelayMs: 0 });
    expect(summary).toMatchObject({ total: 5, created: 5, errors: [] });
    const { rows } = await adminPool.query(
      `SELECT changed_by, actor_sub, count(*)::int AS n FROM audit.data_change_log WHERE reason = $1 GROUP BY 1, 2`,
      [`HR_IMPORT batch ${batchId}`]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changed_by: 'HR_IMPORT', actor_sub: 'system:hr-import' });
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });

  test('API จริงตอบ 413 เมื่อ body เกิน 100 KB (ยืนยันสมมติฐาน limit ที่ไม่ขยาย)', async () => {
    const row = { rowRef: '1', pid: makeFakePid(), expectedFirstNameTh: th(255), expectedLastNameTh: th(255) };
    const body = JSON.stringify({ mode: 'DRY_RUN', rows: Array.from({ length: 120 }, () => row) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(API_BODY_LIMIT_BYTES);

    const res = await fetch(`${apiBaseUrl}/sync/hr/employment-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
    expect(res.status).toBe(413);
  });

  test('APPLY ล้มที่ chunk 3 แล้วรันซ้ำกับ batch เดิม -> ไม่มีบุคคล/employment ซ้ำ, ผลรวมรอบสองถูก, reconcile ตรง 100%', async () => {
    const { batchId, pids } = await seedBatch(300);

    // ส่งผ่าน API จริง แต่ chunk ที่ 3 ตอบ 500 ตลอด (ไม่ถึง API)
    const seen = [];
    const failChunk3 = async (url, init) => {
      const first = JSON.parse(init.body).rows[0].rowRef;
      if (!seen.includes(first)) seen.push(first);
      if (seen.indexOf(first) === 2) return jsonRes(500, { status: 500 });
      return fetch(url, init);
    };

    const error = await runImport(pool, {
      apiBaseUrl, token, batchId, mode: 'APPLY', createIfMissing: true, retryDelayMs: 0, fetchImpl: failChunk3,
    }).catch((e) => e);
    expect(error.code).toBe('IMPORT_CHUNK_FAILED');
    const committedFirstRun = error.partialSummary.rowsSent;
    expect(committedFirstRun).toBeGreaterThan(0);
    expect(committedFirstRun).toBeLessThan(300);
    expect(await batchStatus(batchId)).toBe('QUALITY_CHECKED');

    const countEmployment = async () =>
      (await adminPool.query(
        `SELECT count(*)::int AS rows, count(DISTINCT person_id)::int AS persons,
                count(*) FILTER (WHERE is_current)::int AS current
         FROM mdm.employment WHERE employee_no = ANY($1::text[])`,
        [pids]
      )).rows[0];
    expect(await countEmployment()).toEqual({ rows: committedFirstRun, persons: committedFirstRun, current: committedFirstRun });

    // รันซ้ำกับ batch เดิม ด้วย fetch ปกติ
    const second = await runImport(pool, { apiBaseUrl, token, batchId, mode: 'APPLY', createIfMissing: true });

    expect(second.total).toBe(300);
    expect(second.errors).toEqual([]);
    expect(second.unchanged).toBe(committedFirstRun); // แถวที่ commit ไปแล้วกลายเป็น unchanged ไม่สร้างซ้ำ
    expect(second.created).toBe(300 - committedFirstRun);
    expect(await countEmployment()).toEqual({ rows: 300, persons: 300, current: 300 });
    expect(await batchStatus(batchId)).toBe('APPLIED');

    const reconciliation = await reconcileBatch(pool, batchId);
    expect(reconciliation.isFullyReconciled).toBe(true);
    expect(reconciliation.matched).toBe(300);
  });
});

describe('cmdImport: รายงานบางส่วนเมื่อล้มกลางทาง', () => {
  test('401 ที่ request ที่ 2 -> เขียนรายงาน -partial ที่ไม่มี token/เลขบัตร แล้วโยน error ต่อ (exit code ไม่เป็น 0)', async () => {
    const { batchId, pids } = await seedBatch(300);
    let requestCount = 0;
    const stubServer = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        requestCount += 1;
        if (requestCount === 2) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end('{"status":401}');
          return;
        }
        const body = JSON.parse(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(okResult(body)));
      });
    });
    await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-partial-'));

    try {
      await expect(
        cmdImport(pool, {
          batch: batchId,
          mode: 'APPLY',
          'api-base-url': `http://127.0.0.1:${stubServer.address().port}`,
          token: 'stub-token-value',
          'out-dir': outDir,
        })
      ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    } finally {
      await new Promise((resolve) => stubServer.close(resolve));
    }

    const content = await fs.readFile(path.join(outDir, `apply-report-${batchId}-partial.json`), 'utf8');
    const report = JSON.parse(content);
    expect(report).toMatchObject({ status: 'PARTIAL', mode: 'APPLY' });
    expect(report.failedChunk).toMatchObject({ index: 2, httpStatus: 401 });
    expect(content).not.toContain('stub-token-value');
    for (const pid of pids.slice(0, 20)) expect(content).not.toContain(pid);
  });
});
