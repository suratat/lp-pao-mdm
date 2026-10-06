const crypto = require('node:crypto');
const { toImportRow } = require('../mapping/toImportRow');
const { chunkByBytes, envelopeBytesFor } = require('./chunkByBytes');
const { redact } = require('../util/redact');

const MAX_ROWS_PER_REQUEST = 2000; // maxItems ของ EmploymentImportRow[] ใน personnel-mdm-openapi.yaml

// งบขนาด body ต่อ request = 61440 ไบต์ = 60% ของ limit จริงของ API: express.json() ค่าเริ่มต้น 100 KB (102400 ไบต์)
// ที่ api/src/app.js (ไม่มี client_max_body_size ใน nginx) ตั้งใจไม่ขยาย limit ของ API แต่ปรับฝั่งส่งแทน และเผื่อ
// 40% สำหรับซองคำขอ/ความคลาดเคลื่อนของการประเมิน ถ้า api/src/app.js เปลี่ยน limit ต้องทบทวนค่านี้ด้วย
const MAX_BODY_BYTES = 61440;

// retry เฉพาะ network error และ 5xx (ปลอดภัยเพราะประมวลผลรายแถวแบบ idempotent - บุคคลจับคู่ด้วย pid_hash,
// closeAndOpenEmployment ไม่เปิดแถวใหม่เมื่อข้อมูลไม่เปลี่ยน) 4xx ทุกตัว (รวม 401, 413) ไม่ retry
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

class ImportError extends Error {
  constructor(code, message, partialSummary) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.partialSummary = partialSummary;
  }
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

async function fetchOkRows(pool, batchId) {
  const { rows } = await pool.query(
    `SELECT row_ref, pid_plaintext, expected_first_name_th, expected_last_name_th,
            personnel_type_raw, level_code, job_title_text, appointed_date_raw, effective_from_raw, email_work,
            resolved_org_unit_id, resolved_position_id
     FROM stg_hr.raw_row WHERE batch_id = $1 AND quality_status = 'OK' ORDER BY row_ref`,
    [batchId]
  );
  return rows;
}

// ส่ง chunk เดียว (พร้อม retry) - คืนผลของ request ที่สำเร็จครั้งสุดท้ายเท่านั้น ไม่รวมผลของความพยายามที่ล้มเหลว
async function sendChunk({ fetchImpl, url, token, body, retryDelayMs }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const startedAt = Date.now();
    let res;
    let networkError = null;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body,
      });
    } catch (err) {
      networkError = err;
    }
    const durationMs = Date.now() - startedAt;

    if (res && res.ok) {
      let result;
      try {
        result = await res.json();
      } catch {
        return { failure: { code: 'IMPORT_BAD_RESPONSE', httpStatus: res.status, attempts, durationMs, detail: 'อ่านผลลัพธ์จาก API ไม่ได้' } };
      }
      return { result, attempts, durationMs };
    }

    const httpStatus = res ? res.status : null;
    const retryable = networkError !== null || httpStatus >= 500;
    if (retryable && attempts <= MAX_RETRIES) {
      await sleep(retryDelayMs * attempts);
      continue;
    }

    let detail = networkError ? 'เชื่อมต่อ API ไม่ได้' : '';
    if (res && !retryable && httpStatus !== 401) {
      detail = redact(String(await res.text().catch(() => ''))).slice(0, 300);
    }
    const code = httpStatus === 401 ? 'TOKEN_EXPIRED' : retryable ? 'IMPORT_CHUNK_FAILED' : 'IMPORT_CHUNK_REJECTED';
    return { failure: { code, httpStatus, attempts, durationMs, detail } };
  }
}

async function recordResults(pool, batchId, rowRefs, errorsByRowRef) {
  for (const rowRef of rowRefs) {
    await pool.query(`UPDATE stg_hr.raw_row SET import_result_code = $3 WHERE batch_id = $1 AND row_ref = $2`, [
      batchId,
      rowRef,
      errorsByRowRef.get(rowRef) ?? null,
    ]);
  }
}

// เรียก POST /sync/hr/employment-batch (T4) จริงผ่าน HTTP ตาม §5.3 ระยะ 3 - ไม่ import ฟังก์ชันของ api/
// ตรงๆ (ต่างจาก security/pid.js ซึ่งเป็น pure function ไม่มีสถานะ) เพราะการเขียนบุคคล/employment ต้องผ่าน
// เส้นทาง API เดียวเท่านั้นตามสถาปัตยกรรม แม้จะเป็นเครื่องมือภายในก็ตาม
//
// แบ่ง request ตามขนาด body จริง (MAX_BODY_BYTES) ล้มกลางทาง: chunk ก่อนหน้าที่สำเร็จใน APPLY ถูก commit แล้ว (DRY_RUN ไม่ commit)
// จึงโยน ImportError พร้อม partialSummary และสถานะ batch ไม่เปลี่ยนเป็น APPLIED - รันซ้ำกับ batch เดิมได้ ผลของแถวที่ commit
// ไปแล้วจะกลายเป็น unchanged (ยอด created ของรอบถัดไปจึงน้อยลง) ใช้ reconcile ตรวจความครบถ้วนจริงกับ mdm
async function runImport(
  pool,
  {
    apiBaseUrl,
    token,
    batchId,
    mode,
    createIfMissing = false,
    sourceSystem = 'LHR',
    fetchImpl = fetch,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }
) {
  const startedAt = Date.now();
  const rows = await fetchOkRows(pool, batchId);
  const importRows = rows.map(toImportRow);
  // เหตุผลระดับ batch บังคับที่ API (เก็บเป็น reason ของทุกแถว data_change_log) - ส่งอัตโนมัติ ไม่ต้องให้ผู้รันกรอก (batchId เป็น UUID ไม่ใช่ pid)
  const reason = `HR_IMPORT batch ${batchId}`;
  const envelopeBytes = envelopeBytesFor({ mode, createIfMissing, sourceSystem, reason });
  const { chunks, oversized } = chunkByBytes(importRows, {
    envelopeBytes,
    maxBytes: MAX_BODY_BYTES,
    maxItems: MAX_ROWS_PER_REQUEST,
  });

  const summary = { mode, total: 0, created: 0, updated: 0, unchanged: 0, errors: [], chunks: [] };

  for (const row of oversized) {
    summary.total += 1;
    summary.errors.push({
      rowRef: row.rowRef,
      code: 'ROW_TOO_LARGE',
      message: 'แถวนี้มีขนาดใหญ่เกินงบต่อ request ส่งเข้า API ไม่ได้ ตรวจข้อมูลในไฟล์ต้นทางของแถวนี้',
    });
  }

  const doneRowRefs = oversized.map((row) => row.rowRef);
  let rowsSent = 0;

  const toPartial = (extra) => ({
    ...summary,
    status: 'PARTIAL',
    rowsSent,
    rowsNotSent: importRows.length - oversized.length - rowsSent,
    elapsedMs: Date.now() - startedAt,
    ...extra,
  });

  const abort = async (code, message, partialExtra) => {
    const errorsByRowRef = new Map(summary.errors.map((e) => [e.rowRef, e.code]));
    await recordResults(pool, batchId, doneRowRefs, errorsByRowRef);
    throw new ImportError(code, message, toPartial(partialExtra));
  };

  const committedNote = () => {
    if (rowsSent === 0) return 'ยังไม่มีแถวใดถูกส่งเข้า API';
    return mode === 'APPLY'
      ? `แถวใน chunk ก่อนหน้า (${rowsSent} แถว) ถูก commit แล้ว`
      : `แถวใน chunk ก่อนหน้า (${rowsSent} แถว) ไม่ถูก commit (DRY_RUN)`;
  };

  for (let i = 0; i < chunks.length; i += 1) {
    const index = i + 1;
    const chunk = chunks[i];
    const body = JSON.stringify({ mode, createIfMissing, sourceSystem, reason, rows: chunk.items });

    const sent = await sendChunk({ fetchImpl, url: `${apiBaseUrl}/sync/hr/employment-batch`, token, body, retryDelayMs });

    if (sent.failure) {
      const { code, httpStatus, attempts, durationMs, detail } = sent.failure;
      const where = `chunk ${index}/${chunks.length}`;
      const failedChunk = { index, httpStatus, code, attempts, durationMs, rows: chunk.items.length, bytes: chunk.bytes };
      const messages = {
        TOKEN_EXPIRED: `token หมดอายุหรือไม่ถูกต้อง (401) ที่ ${where} - ${committedNote()} ขอ token ใหม่แล้วรันซ้ำกับ batch เดิมได้`,
        IMPORT_CHUNK_REJECTED: `API ปฏิเสธ ${where} (HTTP ${httpStatus}) ไม่ retry - ${committedNote()}${detail ? `: ${detail}` : ''}`,
        IMPORT_CHUNK_FAILED: `${where} ล้มเหลวหลังลองครบ ${attempts} ครั้ง (${httpStatus ? `HTTP ${httpStatus}` : detail}) - ${committedNote()} รันซ้ำกับ batch เดิมได้`,
        IMPORT_BAD_RESPONSE: `${where}: ${detail} - ${committedNote()}`,
      };
      await abort(code, messages[code], { failedChunk });
    }

    const { result, attempts, durationMs } = sent;
    const accounted = result.created + result.updated + result.unchanged + result.errors.length;
    if (result.total !== chunk.items.length || accounted !== chunk.items.length) {
      await abort(
        'IMPORT_RESULT_MISMATCH',
        `ผลของ chunk ${index}/${chunks.length} ไม่ตรงกับจำนวนแถวที่ส่ง (ส่ง ${chunk.items.length} แถว รวมผลได้ ${accounted}) - ${committedNote()}`,
        { failedChunk: { index, httpStatus: 200, code: 'IMPORT_RESULT_MISMATCH', attempts, durationMs, rows: chunk.items.length, bytes: chunk.bytes } }
      );
    }

    // นับจากผลของ request ที่สำเร็จครั้งสุดท้ายของ chunk เท่านั้น (ความพยายามที่ล้มเหลวไม่เคยถูกนับ)
    summary.total += result.total;
    summary.created += result.created;
    summary.updated += result.updated;
    summary.unchanged += result.unchanged;
    summary.errors.push(...result.errors);
    summary.chunks.push({ index, rows: chunk.items.length, bytes: chunk.bytes, attempts, durationMs });
    rowsSent += chunk.items.length;
    doneRowRefs.push(...chunk.items.map((row) => row.rowRef));
  }

  const accountedTotal = summary.created + summary.updated + summary.unchanged + summary.errors.length;
  if (accountedTotal !== importRows.length || summary.total !== importRows.length) {
    await abort('IMPORT_RESULT_MISMATCH', `ผลรวมของทุก chunk (${accountedTotal}) ไม่ตรงกับจำนวนแถวที่ต้องนำเข้า (${importRows.length})`, {});
  }

  const errorsByRowRef = new Map(summary.errors.map((e) => [e.rowRef, e.code]));
  await recordResults(pool, batchId, doneRowRefs, errorsByRowRef);

  if (mode === 'APPLY') {
    await pool.query(`UPDATE stg_hr.import_batch SET status = 'APPLIED' WHERE batch_id = $1`, [batchId]);
  } else {
    await pool.query(`UPDATE stg_hr.import_batch SET status = 'DRY_RUN_DONE' WHERE batch_id = $1`, [batchId]);
  }

  summary.elapsedMs = Date.now() - startedAt;
  return summary;
}

module.exports = { runImport, ImportError, MAX_ROWS_PER_REQUEST, MAX_BODY_BYTES, MAX_RETRIES };
