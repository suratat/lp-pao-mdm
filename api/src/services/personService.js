const { HttpProblem } = require('../security/httpProblem');
const { isValidPid, pidHash } = require('../security/pid');
const { loadAndPresentPerson } = require('./personPresenter');
const { resolvePurposeCode } = require('./purposeCode');

const PHOTO_KEY_NAME = 'mdm-photo';

// ค้นหาแบบง่าย: filter หลายเงื่อนไข + cursor pagination ด้วย person_id (เรียงลำดับคงที่ ไม่ใช่ offset)
async function searchPersons(
  pool,
  { q, orgUnitId, includeChildUnits, positionId, personnelType, status, updatedSince, cursor, limit }
) {
  const conditions = [];
  const params = [];

  const statuses = status && status.length > 0 ? status : ['ACTIVE'];
  params.push(statuses);
  conditions.push(`p.status = ANY($${params.length}::text[])`);

  if (q) {
    params.push(`${q}%`);
    const qIdx = params.length;
    conditions.push(
      `(pi.first_name_th ILIKE $${qIdx} OR pi.last_name_th ILIKE $${qIdx} OR e.employee_no ILIKE $${qIdx})`
    );
  }

  if (orgUnitId) {
    if (includeChildUnits) {
      params.push(orgUnitId);
      conditions.push(`e.org_unit_id IN (
        WITH RECURSIVE descendants AS (
          SELECT org_unit_id FROM mdm.org_unit WHERE org_unit_id = $${params.length}
          UNION ALL
          SELECT ou.org_unit_id FROM mdm.org_unit ou JOIN descendants d ON ou.parent_id = d.org_unit_id
        )
        SELECT org_unit_id FROM descendants
      )`);
    } else {
      params.push(orgUnitId);
      conditions.push(`e.org_unit_id = $${params.length}`);
    }
  }

  if (positionId) {
    params.push(positionId);
    conditions.push(`e.position_id = $${params.length}`);
  }

  if (personnelType) {
    params.push(personnelType);
    conditions.push(`e.personnel_type = $${params.length}`);
  }

  if (updatedSince) {
    params.push(updatedSince);
    conditions.push(`p.updated_at > $${params.length}`);
  }

  if (cursor) {
    params.push(cursor);
    conditions.push(`p.person_id > $${params.length}`);
  }

  params.push(limit + 1);
  const limitIdx = params.length;

  const { rows } = await pool.query(
    `SELECT p.person_id
     FROM mdm.person p
     LEFT JOIN mdm.person_identity pi ON pi.person_id = p.person_id
     LEFT JOIN mdm.employment e ON e.person_id = p.person_id AND e.is_current = true
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.person_id
     LIMIT $${limitIdx}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const data = [];
  for (const row of page) {
    // eslint-disable-next-line no-await-in-loop
    data.push(await loadAndPresentPerson(pool, row.person_id));
  }

  const nextCursor = hasMore ? page[page.length - 1].person_id : null;
  return { data, page: { nextCursor, limit } };
}

async function getPerson(pool, personId) {
  const person = await loadAndPresentPerson(pool, personId);
  if (!person) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้', undefined);
  return person;
}

// POST /persons/lookup - คืนเฉพาะ personId/status บันทึก access_log พร้อม justification เสมอ
// (การ rate-limit ที่เข้มงวดกว่า endpoint อื่นตามที่ระบุยังไม่ implement ในสเกลตันนี้)
async function lookupPersonByPid(pool, pid, justification, { actor, requestMeta }) {
  if (!isValidPid(pid)) {
    throw new HttpProblem(400, 'invalid-pid', 'เลขบัตรประชาชนไม่ถูกต้อง', 'pid ไม่ผ่านการตรวจ checksum (mod 11)');
  }

  const pepper = requestMeta.pepper;
  const hash = pidHash(pid, pepper);
  const { rows } = await pool.query(`SELECT person_id, status FROM mdm.person WHERE pid_hash = $1`, [hash]);

  const purposeCode = await resolvePurposeCode(pool, actor.azp);
  await pool.query(
    `INSERT INTO audit.access_log
      (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
       fields_returned, purpose_code, justification, request_id, client_ip, response_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      rows[0]?.person_id || null,
      actor.personId ? 'USER' : 'SERVICE',
      actor.sub || null,
      actor.azp || null,
      requestMeta.endpoint,
      requestMeta.httpMethod,
      JSON.stringify(['personId', 'status']),
      purposeCode,
      justification,
      requestMeta.requestId || null,
      requestMeta.clientIp || null,
      rows.length > 0 ? 200 : 404,
    ]
  );

  if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้', undefined);
  return { personId: rows[0].person_id, status: rows[0].status };
}

// คืน { buffer, mimeType, sha256 } ของรูปปัจจุบัน - เขียน access_log เอง (endpoint นี้คืน binary
// ไม่ผ่าน res.json จึง middleware กลางของ T2 ไม่ทำงาน) ตามกฎข้อ 6
async function getPersonPhoto(pool, vault, personId, { actor, requestMeta }) {
  const { rows } = await pool.query(
    `SELECT image_enc, sha256, mime_type FROM mdm.person_photo WHERE person_id = $1 AND is_current = true`,
    [personId]
  );
  if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบรูปถ่าย', undefined);

  const ciphertext = Buffer.from(rows[0].image_enc).toString('utf8');
  const buffer = await vault.decrypt(PHOTO_KEY_NAME, ciphertext, personId);

  const purposeCode = await resolvePurposeCode(pool, actor.azp);
  await pool.query(
    `INSERT INTO audit.access_log
      (subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method,
       fields_returned, purpose_code, justification, request_id, client_ip, response_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      personId,
      actor.personId ? 'USER' : 'SERVICE',
      actor.sub || null,
      actor.azp || null,
      requestMeta.endpoint,
      requestMeta.httpMethod,
      JSON.stringify(['photo']),
      purposeCode,
      null,
      requestMeta.requestId || null,
      requestMeta.clientIp || null,
      200,
    ]
  );

  return { buffer, mimeType: rows[0].mime_type, sha256: rows[0].sha256 };
}

module.exports = { searchPersons, getPerson, getPersonPhoto, lookupPersonByPid };
