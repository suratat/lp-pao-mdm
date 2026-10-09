const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');
const { isValidPid, pidHash } = require('../security/pid');
const { loadAndPresentPerson } = require('./personPresenter');
const { closeAndOpenEmployment, withCurrentEmployeeNo } = require('./employmentShared');
const { writeChangeLog, writeChangeLogs, actorFromAuth } = require('./changeLogWriter');
const { composeReason } = require('./reason');
const { assertBirthDateInRange } = require('./personManageService');

const PID_KEY_NAME = 'mdm-pid';

function logEmploymentChanges(client, personId, changes, reason, actor) {
  return writeChangeLogs(client, { personId, tableName: 'employment', changes, changedBy: 'HR', actor, reason });
}

// POST /persons (HR pre-provision) - §3.4: "HR provision ผ่าน POST /persons ... PENDING_CLAIM (มี
// pid_hash/pid_enc, employment, ชื่อที่คาดไว้)" - เข้ารหัส pid_enc ทันที (ต่างจาก T3 ที่เข้ารหัสตอน claim
// เพราะตอนนั้นยังไม่มี endpoint นี้)
async function provisionPerson({ pool, vault, pepper }, body, auth) {
  const actor = actorFromAuth(auth);
  const { pid, expectedFirstNameTh, expectedLastNameTh, expectedBirthDate, employment, externalIds } = body;

  if (!isValidPid(pid)) {
    throw new HttpProblem(400, 'invalid-pid', 'เลขบัตรประชาชนไม่ถูกต้อง', 'pid ไม่ผ่านการตรวจ checksum (mod 11)');
  }
  // เหตุผลบังคับ (422 ถ้าว่าง/มีเลข 13 หลัก) - ตรวจก่อนแตะ DB ทุกอย่าง
  const reason = composeReason(body.reason, employment?.referenceDocument);
  assertBirthDateInRange(expectedBirthDate);

  const hash = pidHash(pid, pepper);

  return withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query(`SELECT person_id FROM mdm.person WHERE pid_hash = $1`, [hash]);
    if (existing.length > 0) {
      throw new HttpProblem(409, 'duplicate-pid', 'มี record ของ pid นี้อยู่แล้ว', undefined, {
        existingPersonId: existing[0].person_id,
      });
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO mdm.person (pid_hash, status, verification_status, expected_first_name_th, expected_last_name_th, expected_birth_date)
       VALUES ($1, 'PENDING_CLAIM', 'UNVERIFIED', $2, $3, $4)
       RETURNING person_id`,
      [hash, expectedFirstNameTh, expectedLastNameTh, expectedBirthDate ?? null]
    );
    const personId = inserted[0].person_id;
    // ข้อมูลที่ HR กรอกตอนสร้างก็ต้องมีร่องรอย (ค่าเดิมไม่มี -> ค่าใหม่) ใน transaction เดียวกัน
    for (const [column, value] of [
      ['expected_first_name_th', expectedFirstNameTh],
      ['expected_last_name_th', expectedLastNameTh],
      ['expected_birth_date', expectedBirthDate ?? null],
    ]) {
      if (value === null) continue;
      // eslint-disable-next-line no-await-in-loop
      await writeChangeLog(client, { personId, tableName: 'person', fieldName: `person.${column}`, newValue: value, changedBy: 'HR', actor, reason });
    }

    const { ciphertext, keyId } = await vault.encrypt(PID_KEY_NAME, Buffer.from(pid, 'utf8'), personId);
    await client.query(`UPDATE mdm.person SET pid_enc = $2, key_id = $3 WHERE person_id = $1`, [
      personId,
      Buffer.from(ciphertext, 'utf8'),
      keyId,
    ]);

    const { changes } = await closeAndOpenEmployment(client, personId, employment, 'HR');
    await logEmploymentChanges(client, personId, changes, reason, actor);

    if (Array.isArray(externalIds)) {
      for (const ext of externalIds) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO mdm.external_identifier (person_id, system_code, external_value) VALUES ($1, $2, $3)`,
          [personId, ext.systemCode, ext.value]
        );
      }
    }

    // ไม่ส่ง outbox_event: บุคคลยังไม่ claim จึงยังไม่มีตัวตนที่ระบบปลายทางควรรับรู้ (สอดคล้องกับ seq-01
    // ที่ event แรกของบุคคลคือ PERSON_CLAIMED ตอน login ThaID ครั้งแรก ไม่ใช่ตอน provision)
    // notifyEmail ใน request ไม่ได้เก็บเป็นข้อมูลติดต่อ (ระบุไว้ใน schema) - การส่งคำเชิญจริงเป็นงาน Portal (T9)

    return loadAndPresentPerson(client, personId);
  });
}

// POST /persons/{id}/deactivate (§3.4, seq-01)
async function deactivatePerson(pool, personId, body, auth) {
  const actor = actorFromAuth(auth);
  const reason = composeReason(body.reason, body.referenceDocument);
  const separationReason = composeReason(body.reason);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT version, status FROM mdm.person WHERE person_id = $1 FOR UPDATE`, [
      personId,
    ]);
    if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');
    if (rows[0].status === 'INACTIVE') {
      throw new HttpProblem(409, 'already-inactive', 'บุคคลนี้ถูกระงับสถานะไปแล้ว');
    }
    // optimistic lock (เหมือน reactivate/PUT employment): หน้าจอที่เปิดค้างไว้ก่อนมีคนอื่นแก้ต้องไม่เขียนทับ
    if (body.expectedVersion !== undefined && body.expectedVersion !== rows[0].version) {
      throw new HttpProblem(409, 'version-conflict', 'version ไม่ตรงกับปัจจุบัน', `expectedVersion=${body.expectedVersion} แต่ปัจจุบันคือ ${rows[0].version}`);
    }

    const { rows: currentEmployment } = await client.query(
      `SELECT employment_id, employment_status FROM mdm.employment WHERE person_id = $1 AND is_current = true`,
      [personId]
    );

    if (currentEmployment.length > 0) {
      await client.query(
        `UPDATE mdm.employment
         SET is_current = false, employment_status = $2, separation_date = $3, separation_reason = $4, effective_to = $3
         WHERE employment_id = $1`,
        [currentEmployment[0].employment_id, body.employmentStatus, body.separationDate, separationReason]
      );
      await writeChangeLog(client, {
        personId,
        tableName: 'employment',
        fieldName: 'employment_status',
        oldValue: currentEmployment[0].employment_status,
        newValue: body.employmentStatus,
        changedBy: 'HR',
        actor,
        reason,
      });
    }

    const newVersion = rows[0].version + 1;
    await client.query(
      `UPDATE mdm.person SET status = 'INACTIVE', deleted_at = now(), version = $2 WHERE person_id = $1`,
      [personId, newVersion]
    );
    await writeChangeLog(client, {
      personId,
      tableName: 'person',
      fieldName: 'status',
      oldValue: rows[0].status,
      newValue: 'INACTIVE',
      changedBy: 'HR',
      actor,
      reason,
    });

    await client.query(
      `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
       VALUES ($1, 'PERSON_DEACTIVATED', $2, $3, $4)`,
      [
        personId,
        JSON.stringify(['person.status', 'employment.employment_status']),
        JSON.stringify({ personId, version: newVersion, status: 'INACTIVE', verificationStatus: null }),
        newVersion,
      ]
    );

    return loadAndPresentPerson(client, personId);
  });
}

// POST /persons/{id}/reactivate (§3.4: "ตั้ง verification_status = STALE เพื่อบังคับผ่าน ThaID ใหม่")
async function reactivatePerson(pool, personId, body, auth) {
  const actor = actorFromAuth(auth);
  const reason = composeReason(body.reason, body.referenceDocument);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT version, status FROM mdm.person WHERE person_id = $1 FOR UPDATE`, [
      personId,
    ]);
    if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');

    if (body.expectedVersion !== undefined && body.expectedVersion !== rows[0].version) {
      throw new HttpProblem(409, 'version-conflict', 'version ไม่ตรงกับปัจจุบัน');
    }

    const { changes } = await closeAndOpenEmployment(client, personId, await withCurrentEmployeeNo(client, personId, body), 'HR');
    await logEmploymentChanges(client, personId, changes, reason, actor);

    const newVersion = rows[0].version + 1;
    await client.query(
      `UPDATE mdm.person
       SET status = 'ACTIVE', verification_status = 'STALE', deleted_at = NULL, version = $2
       WHERE person_id = $1`,
      [personId, newVersion]
    );
    await writeChangeLog(client, {
      personId,
      tableName: 'person',
      fieldName: 'status',
      oldValue: rows[0].status,
      newValue: 'ACTIVE',
      changedBy: 'HR',
      actor,
      reason,
    });

    await client.query(
      `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
       VALUES ($1, 'PERSON_REACTIVATED', $2, $3, $4)`,
      [
        personId,
        JSON.stringify(['person.status', ...changes.map((c) => c.fieldKey)]),
        JSON.stringify({ personId, version: newVersion, status: 'ACTIVE', verificationStatus: 'STALE' }),
        newVersion,
      ]
    );

    return loadAndPresentPerson(client, personId);
  });
}

// POST /persons/{id}/reverify - เพียงตั้ง flag ให้เข้ารอบ reverify-scan (worker, T4) รอบถัดไป (seq-02
// Phase C) ไม่มี data_change_log/outbox ตามที่ sequence diagram ระบุ (เป็น workflow flag ไม่ใช่ข้อมูล
// บุคคลที่ field_policy คุ้มครอง)
async function requestReverify(pool, personId) {
  const { rows } = await pool.query(
    `UPDATE mdm.person SET reverify_requested_at = now() WHERE person_id = $1 RETURNING person_id`,
    [personId]
  );
  if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');
}

function presentClaimRequest(row) {
  return {
    claimRequestId: row.claim_request_id,
    displayName: row.display_name,
    status: row.status,
    attemptCount: row.attempt_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedPersonId: row.resolved_person_id,
    resolvedBy: row.resolved_by,
    // resolvedAt เป็น {type: [string,'null'], format: date-time} (nullable แบบ array) - ต้องแปลง Date
    // เป็น ISO string เอง เพราะ express-openapi-validator แปลงให้อัตโนมัติเฉพาะ {type: string} เดี่ยวๆ
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

async function listClaimRequests(pool, { status = 'PENDING_HR', cursor, limit }) {
  const conditions = ['status = $1'];
  const params = [status];
  if (cursor) {
    params.push(cursor);
    conditions.push(`claim_request_id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT * FROM mdm.claim_request WHERE ${conditions.join(' AND ')} ORDER BY claim_request_id LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: page.map(presentClaimRequest),
    page: { nextCursor: hasMore ? page[page.length - 1].claim_request_id : null, limit },
  };
}

// POST /claim-requests/{id}/resolve
async function resolveClaimRequest({ pool, vault, pepper }, claimRequestId, body, auth) {
  const actor = auth;
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query(`SELECT * FROM mdm.claim_request WHERE claim_request_id = $1 FOR UPDATE`, [
      claimRequestId,
    ]);
    if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบ claim request นี้');
    const claim = rows[0];

    if (claim.status !== 'PENDING_HR') {
      throw new HttpProblem(409, 'already-resolved', 'claim request นี้ถูกดำเนินการไปแล้ว');
    }

    if (body.action === 'REJECT') {
      await client.query(
        `UPDATE mdm.claim_request SET status = 'REJECTED', resolved_by = $2, resolved_at = now() WHERE claim_request_id = $1`,
        [claimRequestId, actor.sub || null]
      );
    } else if (body.action === 'PROVISION') {
      if (!body.employment) {
        throw new HttpProblem(400, 'bad-request', 'ต้องระบุ employment สำหรับ action=PROVISION');
      }
      // ตรวจก่อนเขียน DB ทุกอย่าง (ไม่ปล่อยให้ชน person_pid_hash_uk แล้วหลุดเป็น 500):
      // (1) มี person ที่ pid_hash เดียวกันอยู่แล้ว (เช่น นำเข้าจาก HR หลังคนนั้นเคยล็อกอินจนเกิด claim_request) -> 409 เหมือน POST /persons
      const { rows: existing } = await client.query(`SELECT person_id FROM mdm.person WHERE pid_hash = $1`, [claim.pid_hash]);
      if (existing.length > 0) {
        throw new HttpProblem(409, 'duplicate-pid', 'มี record ของ pid นี้อยู่แล้ว', undefined, {
          existingPersonId: existing[0].person_id,
        });
      }
      // (2) employeeNo = เลขบัตรประชาชนเสมอ (employee_no is pid) ต้อง hash แล้วตรงกับคำขอที่กำลังอนุมัติ ไม่งั้น HR พิมพ์เลขผิดคนแล้ว
      // เลขบัตรของอีกคนจะถูกเก็บลง employment.employee_no - ข้อความ error ห้ามมีค่าที่ส่งมา (กฎข้อ 1)
      if (typeof body.employment.employeeNo !== 'string' || pidHash(body.employment.employeeNo, pepper) !== claim.pid_hash) {
        throw new HttpProblem(
          422,
          'employee-no-pid-mismatch',
          'เลขประจำตัวไม่ตรงกับคำขอ',
          'employeeNo (เลขบัตรประชาชน) ไม่ตรงกับผู้ที่ล็อกอินตามคำขอนี้ ตรวจสอบเลขที่กรอกอีกครั้ง'
        );
      }
      // pid_enc ยังเข้ารหัสไม่ได้ตรงนี้เพราะ claim_request ไม่เก็บ pid จริง (มีแต่ pid_hash) - จะเข้ารหัส
      // ตอน login ThaID ครั้งแรก (T3 syncService.handleClaim) เหมือนกรณีทั่วไป
      const { rows: inserted } = await client.query(
        `INSERT INTO mdm.person (pid_hash, status, verification_status)
         VALUES ($1, 'PENDING_CLAIM', 'UNVERIFIED') RETURNING person_id`,
        [claim.pid_hash]
      );
      const personId = inserted[0].person_id;

      const { changes } = await closeAndOpenEmployment(client, personId, body.employment, 'HR');
      await logEmploymentChanges(client, personId, changes, body.note, actorFromAuth(auth));

      await client.query(
        `UPDATE mdm.claim_request SET status = 'LINKED', resolved_person_id = $2, resolved_by = $3, resolved_at = now()
         WHERE claim_request_id = $1`,
        [claimRequestId, personId, actor.sub || null]
      );
    } else if (body.action === 'LINK') {
      if (!body.personId) {
        throw new HttpProblem(400, 'bad-request', 'ต้องระบุ personId สำหรับ action=LINK');
      }
      const { rows: personRows } = await client.query(
        `SELECT person_id, pid_hash FROM mdm.person WHERE person_id = $1 FOR UPDATE`,
        [body.personId]
      );
      if (personRows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลตาม personId ที่ระบุ');
      if (personRows[0].pid_hash !== null) {
        throw new HttpProblem(409, 'already-linked', 'บุคคลนี้มี pid_hash ผูกอยู่แล้ว เชื่อมซ้ำไม่ได้');
      }

      // field_policy: person.pid_hash log_values_in_audit=false - บันทึกเฉพาะชื่อฟิลด์ที่เปลี่ยน ไม่บันทึกค่า
      await client.query(`UPDATE mdm.person SET pid_hash = $2 WHERE person_id = $1`, [body.personId, claim.pid_hash]);
      await writeChangeLog(client, {
        personId: body.personId,
        tableName: 'person',
        fieldName: 'pid_hash',
        changedBy: 'HR',
        actor: actorFromAuth(auth),
        reason: body.note,
      });

      await client.query(
        `UPDATE mdm.claim_request SET status = 'LINKED', resolved_person_id = $2, resolved_by = $3, resolved_at = now()
         WHERE claim_request_id = $1`,
        [claimRequestId, body.personId, actor.sub || null]
      );
    } else {
      throw new HttpProblem(400, 'bad-request', 'action ไม่ถูกต้อง');
    }

    const { rows: fresh } = await client.query(`SELECT * FROM mdm.claim_request WHERE claim_request_id = $1`, [
      claimRequestId,
    ]);
    return presentClaimRequest(fresh[0]);
  });
}

// GET /reverify/stale (HR dashboard)
// includeInactive=false (token ไม่มี personnel:read:inactive): ตัดบุคคล INACTIVE ออกจากรายการเงียบๆ (ไม่ 403 ทั้ง list) ใน SQL เพื่อให้ cursor/limit ถูกต้อง
async function listStalePersons(pool, { verificationStatus, orgUnitId, cursor, limit, includeInactive = false }) {
  const statuses = verificationStatus && verificationStatus.length > 0 ? verificationStatus : ['STALE', 'EXPIRED'];
  const conditions = ['p.verification_status = ANY($1::text[])'];
  const params = [statuses];
  let join = '';

  if (!includeInactive) conditions.push("p.status <> 'INACTIVE'");
  if (orgUnitId) {
    join = 'JOIN mdm.employment e ON e.person_id = p.person_id AND e.is_current = true';
    params.push(orgUnitId);
    conditions.push(`e.org_unit_id = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`p.person_id > $${params.length}`);
  }
  params.push(limit + 1);

  const { rows } = await pool.query(
    `SELECT DISTINCT p.person_id FROM mdm.person p ${join}
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.person_id
     LIMIT $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const data = [];
  for (const row of page) {
    // eslint-disable-next-line no-await-in-loop
    data.push(await loadAndPresentPerson(pool, row.person_id));
  }

  return { data, page: { nextCursor: hasMore ? page[page.length - 1].person_id : null, limit } };
}

module.exports = {
  provisionPerson,
  deactivatePerson,
  reactivatePerson,
  requestReverify,
  listClaimRequests,
  resolveClaimRequest,
  listStalePersons,
};
