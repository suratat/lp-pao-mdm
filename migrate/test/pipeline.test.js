const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { buildTestApp } = require('../../api/test/testApp');
const { pidHash } = require('../../api/src/security/pid');
const { DATABASE_URL, MIGRATOR_DATABASE_URL } = require('./config');
const { loadBatch } = require('../src/loader/loadBatch');
const { runQualityCheck } = require('../src/quality/rules');
const { runImport } = require('../src/import/runImport');
const { reconcileBatch } = require('../src/reconcile/reconcile');
const { writeReport } = require('../src/report/writeReport');
const { buildCsv, validRow, defaultColumnMap, makePosition, FIXTURE_ORG_UNIT_CODE } = require('./fixtures');

const FIXTURE_ORG_UNIT_ID = '00000000-0000-0000-0000-000000000003'; // seed T1: ฝ่ายบริหารงานทั่วไป

let pool;
let adminPool;
let apiCtx;
let server;
let apiBaseUrl;
let token;
let reportDir;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  adminPool = new Pool({ connectionString: MIGRATOR_DATABASE_URL });

  apiCtx = await buildTestApp();
  server = apiCtx.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  apiBaseUrl = `http://127.0.0.1:${port}/api/v1`;

  token = await apiCtx.auth.signToken({ scope: 'personnel:import' });
  reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stg-hr-reports-'));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await apiCtx.pool.end();
  await pool.end();
  await adminPool.end();
});

describe('T8 pipeline: load -> check-quality -> DRY_RUN -> APPLY -> reconcile (§5.3 ระยะ 1 และ 3)', () => {
  test('แถวถูกต้องครบ -> DRY_RUN ไม่บันทึกจริง, APPLY สร้างคน PENDING_CLAIM, reconcile ตรงกับไฟล์ต้นทาง 100%', async () => {
    const positionNo = await makePosition(adminPool, FIXTURE_ORG_UNIT_ID);
    const row = validRow({ rowRef: 'r1', positionNo, orgUnitCode: FIXTURE_ORG_UNIT_CODE });
    const csv = buildCsv([row]);

    const { batchId } = await loadBatch(pool, {
      csvContent: csv,
      columnMap: defaultColumnMap,
      sourceFilename: 'pipeline.csv',
      importedBy: 'tester',
    });

    const qualitySummary = await runQualityCheck(pool, batchId);
    expect(qualitySummary.ok).toBe(1);
    expect(qualitySummary.error).toBe(0);

    const dryRun = await runImport(pool, {
      apiBaseUrl,
      token,
      batchId,
      mode: 'DRY_RUN',
      createIfMissing: true,
    });
    expect(dryRun).toEqual({ mode: 'DRY_RUN', total: 1, created: 1, updated: 0, unchanged: 0, errors: [] });

    // DRY_RUN ต้อง rollback จริง - ยังไม่มี person ที่ pid_hash นี้
    const pepper = await apiCtx.vault.getPepper();
    const hash = pidHash(row.pid, pepper);
    const beforeApply = await adminPool.query(`SELECT 1 FROM mdm.person WHERE pid_hash = $1`, [hash]);
    expect(beforeApply.rows).toHaveLength(0);

    const apply = await runImport(pool, {
      apiBaseUrl,
      token,
      batchId,
      mode: 'APPLY',
      createIfMissing: true,
    });
    expect(apply).toEqual({ mode: 'APPLY', total: 1, created: 1, updated: 0, unchanged: 0, errors: [] });

    const person = await adminPool.query(
      `SELECT status FROM mdm.person WHERE pid_hash = $1`,
      [hash]
    );
    expect(person.rows).toHaveLength(1);
    expect(person.rows[0].status).toBe('PENDING_CLAIM');

    const employment = await adminPool.query(
      `SELECT e.employee_no, e.org_unit_id, p.position_no
       FROM mdm.employment e JOIN mdm.position p ON p.position_id = e.position_id
       WHERE e.employee_no = $1`,
      [row.employeeNo]
    );
    expect(employment.rows).toHaveLength(1);
    expect(employment.rows[0].org_unit_id).toBe(FIXTURE_ORG_UNIT_ID);
    expect(employment.rows[0].position_no).toBe(positionNo);

    const reconciliation = await reconcileBatch(pool, batchId);
    expect(reconciliation.isFullyReconciled).toBe(true);
    expect(reconciliation.matched).toBe(1);
    expect(reconciliation.mismatches).toEqual([]);

    // รายงานทุกไฟล์ต้องไม่มีเลขบัตรจริงหลุดออกมา (กฎข้อ 1 ของ CLAUDE.md)
    const qualityReportPath = await writeReport(reportDir, `quality-${batchId}.json`, qualitySummary);
    const dryRunReportPath = await writeReport(reportDir, `dry-run-${batchId}.json`, dryRun);
    const applyReportPath = await writeReport(reportDir, `apply-${batchId}.json`, apply);
    const reconcileReportPath = await writeReport(reportDir, `reconcile-${batchId}.json`, reconciliation);

    for (const reportPath of [qualityReportPath, dryRunReportPath, applyReportPath, reconcileReportPath]) {
      const content = await fs.readFile(reportPath, 'utf8');
      expect(content).not.toContain(row.pid);
    }
  });

  test('แถวที่มีปัญหาคุณภาพ -> ไม่ถูกส่งเข้า import เลย (กรองก่อนถึง API)', async () => {
    const badRow = validRow({ rowRef: 'bad', orgUnitCode: 'NO-SUCH-UNIT' });
    const csv = buildCsv([badRow]);

    const { batchId } = await loadBatch(pool, {
      csvContent: csv,
      columnMap: defaultColumnMap,
      sourceFilename: 'bad.csv',
      importedBy: 'tester',
    });

    const qualitySummary = await runQualityCheck(pool, batchId);
    expect(qualitySummary.ok).toBe(0);
    expect(qualitySummary.error).toBe(1);

    const dryRun = await runImport(pool, { apiBaseUrl, token, batchId, mode: 'DRY_RUN', createIfMissing: true });
    expect(dryRun.total).toBe(0);
  });
});
