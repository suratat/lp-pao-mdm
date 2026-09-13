#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { loadBatch } = require('./loader/loadBatch');
const { runQualityCheck } = require('./quality/rules');
const { runImport } = require('./import/runImport');
const { reconcileBatch } = require('./reconcile/reconcile');
const { writeReport } = require('./report/writeReport');

// CLI ภายใน (ใช้โดยฝ่ายบุคคล/ทีมพัฒนาตอน migrate เท่านั้น ไม่ใช่ endpoint สาธารณะ) - parse argv เองแบบง่าย
// ไม่เพิ่ม dependency คำสั่งบรรทัด (yargs/commander) ตามข้อ 6 ของ CLAUDE.md ("ไม่ติดตั้ง dependency ใหม่
// นอกรายการโดยไม่บอกเหตุผล") เพราะมีแค่ 4 คำสั่ง ไม่คุ้มเพิ่ม dependency
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    }
  }
  return { command, options };
}

async function loadColumnMap(columnMapPath) {
  const resolved = columnMapPath || path.join(__dirname, '..', 'config', 'column-map.json');
  const content = await fs.readFile(resolved, 'utf8');
  return JSON.parse(content);
}

async function cmdLoad(pool, options) {
  const columnMap = await loadColumnMap(options['column-map']);
  const csvContent = await fs.readFile(options.file, 'utf8');
  const result = await loadBatch(pool, {
    csvContent,
    columnMap,
    sourceFilename: path.basename(options.file),
    importedBy: options['imported-by'] || 'unknown',
  });
  console.log(`โหลดสำเร็จ: batch ${result.batchId} (${result.rowCount} แถว)`);
  return result;
}

async function cmdCheckQuality(pool, options) {
  const summary = await runQualityCheck(pool, options.batch);
  const outDir = options['out-dir'] || path.join(process.cwd(), 'reports');
  const filePath = await writeReport(outDir, `quality-report-${options.batch}.json`, summary);
  console.log(`ตรวจคุณภาพเสร็จ: OK=${summary.ok} ERROR=${summary.error} (${filePath})`);
  return summary;
}

async function cmdImport(pool, options) {
  const mode = (options.mode || 'DRY_RUN').toUpperCase();
  const summary = await runImport(pool, {
    apiBaseUrl: options['api-base-url'] || process.env.MDM_API_BASE_URL,
    token: options.token || process.env.MDM_API_TOKEN,
    batchId: options.batch,
    mode,
    createIfMissing: Boolean(options['create-if-missing']),
    sourceSystem: options['source-system'] || 'LHR',
  });
  const outDir = options['out-dir'] || path.join(process.cwd(), 'reports');
  const reportName = mode === 'APPLY' ? `apply-report-${options.batch}.json` : `dry-run-report-${options.batch}.json`;
  const filePath = await writeReport(outDir, reportName, summary);
  console.log(`${mode} เสร็จ: created=${summary.created} updated=${summary.updated} unchanged=${summary.unchanged} errors=${summary.errors.length} (${filePath})`);
  return summary;
}

async function cmdReconcile(pool, options) {
  const result = await reconcileBatch(pool, options.batch);
  const outDir = options['out-dir'] || path.join(process.cwd(), 'reports');
  const filePath = await writeReport(outDir, `reconciliation-report-${options.batch}.json`, result);
  console.log(`Reconcile เสร็จ: matched=${result.matched}/${result.totalSourceRows} mismatches=${result.mismatches.length} (${filePath})`);
  return result;
}

const COMMANDS = { load: cmdLoad, 'check-quality': cmdCheckQuality, import: cmdImport, reconcile: cmdReconcile };

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`คำสั่งไม่ถูกต้อง: ${command ?? '(ไม่ระบุ)'} - ใช้ได้: ${Object.keys(COMMANDS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await handler(pool, options);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, cmdLoad, cmdCheckQuality, cmdImport, cmdReconcile };
