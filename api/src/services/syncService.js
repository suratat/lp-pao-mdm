const crypto = require('node:crypto');
const { isValidPid, pidHash, canonicalizeIdentityClaims, snapshotHash, sha256Hex } = require('../security/pid');
const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');

const PID_KEY_NAME = 'mdm-pid';
const PHOTO_KEY_NAME = 'mdm-photo';

// mapping ฟิลด์ API (camelCase) -> คอลัมน์ person_identity (snake_case) + field_key ที่ตรงกับ
// mdm.field_policy (T1) ใช้ทั้งตอน diff, INSERT/UPDATE แบบ dynamic และ data_change_log.field_name
const IDENTITY_FIELD_COLUMNS = {
  titleTh: { column: 'title_th', fieldKey: 'identity.title_th' },
  firstNameTh: { column: 'first_name_th', fieldKey: 'identity.first_name_th' },
  middleNameTh: { column: 'middle_name_th', fieldKey: 'identity.middle_name_th' },
  lastNameTh: { column: 'last_name_th', fieldKey: 'identity.last_name_th' },
  titleEn: { column: 'title_en', fieldKey: 'identity.title_en' },
  firstNameEn: { column: 'first_name_en', fieldKey: 'identity.first_name_en' },
  lastNameEn: { column: 'last_name_en', fieldKey: 'identity.last_name_en' },
  birthDate: { column: 'birth_date', fieldKey: 'identity.birth_date' },
  gender: { column: 'gender', fieldKey: 'identity.gender' },
  idCardIssueDate: { column: 'id_card_issue_date', fieldKey: 'identity.id_card_issue_date' },
  idCardExpireDate: { column: 'id_card_expire_date', fieldKey: 'identity.id_card_expire_date' },
  ial: { column: 'ial', fieldKey: 'identity.ial' },
};

const ADDRESS_FIELD_COLUMNS = {
  houseNo: { column: 'reg_house_no', fieldKey: 'identity.reg_house_no' },
  moo: { column: 'reg_moo', fieldKey: 'identity.reg_moo' },
  soi: { column: 'reg_soi', fieldKey: 'identity.reg_soi' },
  road: { column: 'reg_road', fieldKey: 'identity.reg_road' },
  subdistrictCode: { column: 'reg_subdistrict_code', fieldKey: 'identity.reg_subdistrict_code' },
  districtCode: { column: 'reg_district_code', fieldKey: 'identity.reg_district_code' },
  provinceCode: { column: 'reg_province_code', fieldKey: 'identity.reg_province_code' },
  fullText: { column: 'reg_address_text', fieldKey: 'identity.reg_address_text' },
};

function buildDisplayName(claims) {
  return [claims.titleTh, claims.firstNameTh, claims.lastNameTh].filter(Boolean).join('');
}

function normalizeForCompare(value) {
  return (value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
}

function valuesEqual(a, b) {
  if (a instanceof Date) a = a.toISOString().slice(0, 10);
  if (b instanceof Date) b = b.toISOString().slice(0, 10);
  return a === b;
}

// diff เฉพาะฟิลด์ที่ "มีอยู่จริง" ใน canonical (มาจากคำขอ) เทียบกับแถวเดิม (null เมื่อเพิ่ง claim - ทุกฟิลด์
// ที่ canonical ส่งมาจึงกลายเป็น "เปลี่ยนจาก null" โดยอัตโนมัติ ตรงตาม §3.1 ขั้น 23-27)
function diffIdentity(canonical, existingRow) {
  const changes = [];

  for (const [apiField, meta] of Object.entries(IDENTITY_FIELD_COLUMNS)) {
    if (!(apiField in canonical)) continue;
    const newValue = canonical[apiField];
    const oldValue = existingRow ? existingRow[meta.column] : null;
    if (!valuesEqual(oldValue, newValue)) {
      changes.push({ column: meta.column, fieldKey: meta.fieldKey, oldValue, newValue });
    }
  }

  if ('registeredAddress' in canonical) {
    const addr = canonical.registeredAddress || {};
    for (const [apiField, meta] of Object.entries(ADDRESS_FIELD_COLUMNS)) {
      const newValue = addr[apiField] ?? null;
      const oldValue = existingRow ? existingRow[meta.column] : null;
      if (!valuesEqual(oldValue, newValue)) {
        changes.push({ column: meta.column, fieldKey: meta.fieldKey, oldValue, newValue });
      }
    }
  }

  return changes;
}

function buildIdentityInsertColumns(canonical) {
  const names = [];
  const values = [];

  for (const [apiField, meta] of Object.entries(IDENTITY_FIELD_COLUMNS)) {
    if (apiField in canonical) {
      names.push(meta.column);
      values.push(canonical[apiField]);
    }
  }
  if ('registeredAddress' in canonical) {
    const addr = canonical.registeredAddress || {};
    for (const [apiField, meta] of Object.entries(ADDRESS_FIELD_COLUMNS)) {
      names.push(meta.column);
      values.push(addr[apiField] ?? null);
    }
  }

  return { names, values };
}

// payload.data ต้องมี verificationStatus ด้วยตาม §2.3 (webhook data{status, verificationStatus,
// mergedIntoPersonId?}) - ไม่ใช่แค่ status เฉยๆ
async function insertOutboxEvent(client, { personId, eventType, changedFields, version, status, verificationStatus }) {
  await client.query(
    `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      personId,
      eventType,
      JSON.stringify(changedFields),
      JSON.stringify({ personId, version, status, verificationStatus }),
      version,
    ]
  );
}

async function insertChangeLogRows(client, personId, syncEventId, changes) {
  for (const change of changes) {
    await client.query(
      `INSERT INTO audit.data_change_log (person_id, sync_event_id, table_name, field_name, old_value, new_value, changed_by)
       VALUES ($1, $2, 'person_identity', $3, $4, $5, 'THAID_SYNC')`,
      [
        personId,
        syncEventId,
        change.fieldKey,
        change.oldValue === null ? null : JSON.stringify(change.oldValue),
        change.newValue === null ? null : JSON.stringify(change.newValue),
      ]
    );
  }
}

// เส้นทางเดียวในการถอดรหัส/แปลง sub ให้ token claims ของ check.lp-pao.go.th (§2.2 ภาคผนวก ก)
// roles ยังไม่คำนวณจริง (mapping org_unit -> realm role เป็นงานของ mdm-worker ตามภาคผนวก ก ยังไม่ implement)
async function buildTokenClaims(client, personId, claims) {
  const { rows } = await client.query(
    `SELECT e.employee_no, ou.code AS org_unit_code, p.title_th AS position_title
     FROM mdm.employment e
     JOIN mdm.org_unit ou ON ou.org_unit_id = e.org_unit_id
     JOIN mdm.position p ON p.position_id = e.position_id
     WHERE e.person_id = $1 AND e.is_current = true`,
    [personId]
  );
  const employment = rows[0];

  return {
    sub: personId,
    name: buildDisplayName(claims),
    employeeNo: employment?.employee_no,
    orgUnitCode: employment?.org_unit_code,
    positionTitle: employment?.position_title,
    roles: [],
  };
}

async function handleUnmatched(client, { hash, claims, context, trigger }) {
  if (context.audience === 'PERSONNEL') {
    await client.query(
      `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'PENDING_HR', 1, now(), now())
       ON CONFLICT (pid_hash) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         attempt_count = mdm.claim_request.attempt_count + 1,
         last_seen_at = now()`,
      [hash, buildDisplayName(claims)]
    );
  }

  await client.query(
    `INSERT INTO audit.thaid_sync_event (person_id, trigger, result, app_id, audience, ial, aal, client_ip, user_agent)
     VALUES (NULL, $1, 'UNMATCHED', $2, $3, $4, $5, $6, $7)`,
    [
      trigger,
      context.appId,
      context.audience,
      claims.ial ?? null,
      claims.aal ?? null,
      context.clientIp ?? null,
      context.userAgent ?? null,
    ]
  );

  return { httpStatus: 202, body: { result: 'UNMATCHED', personId: null } };
}

async function handleClaim(client, vault, { person, claims, context, trigger, canonical, newSnapshotHash, photo }) {
  const nameMismatchWithHr =
    person.expected_first_name_th != null &&
    person.expected_last_name_th != null &&
    (normalizeForCompare(person.expected_first_name_th) !== normalizeForCompare(claims.firstNameTh) ||
      normalizeForCompare(person.expected_last_name_th) !== normalizeForCompare(claims.lastNameTh));

  const changes = diffIdentity(canonical, null);
  const syncEventId = crypto.randomUUID();

  await client.query(
    `INSERT INTO audit.thaid_sync_event
      (sync_event_id, person_id, trigger, result, app_id, audience, snapshot_hash_before, snapshot_hash_after, changed_fields, ial, aal, client_ip, user_agent)
     VALUES ($1, $2, $3, 'CLAIMED', $4, $5, NULL, $6, $7, $8, $9, $10, $11)`,
    [
      syncEventId,
      person.person_id,
      trigger,
      context.appId,
      context.audience,
      newSnapshotHash,
      JSON.stringify(changes.map((c) => c.fieldKey)),
      claims.ial ?? null,
      claims.aal ?? null,
      context.clientIp ?? null,
      context.userAgent ?? null,
    ]
  );

  const { ciphertext, keyId } = await vault.encrypt(PID_KEY_NAME, Buffer.from(claims.pid, 'utf8'), person.person_id);

  const { names, values } = buildIdentityInsertColumns(canonical);
  const allNames = [...names, 'source_snapshot_hash', 'last_sync_event_id', 'synced_at'];
  const allValues = [...values, newSnapshotHash, syncEventId, new Date()];
  const placeholders = allValues.map((_, i) => `$${i + 2}`);
  await client.query(
    `INSERT INTO mdm.person_identity (person_id, ${allNames.join(', ')}) VALUES ($1, ${placeholders.join(', ')})`,
    [person.person_id, ...allValues]
  );

  if (photo) {
    const photoEnc = await vault.encrypt(PHOTO_KEY_NAME, photo.buffer, person.person_id);
    await client.query(
      `INSERT INTO mdm.person_photo (person_id, image_enc, sha256, mime_type, source, is_current, synced_at)
       VALUES ($1, $2, $3, $4, 'THAID', true, now())`,
      [person.person_id, Buffer.from(photoEnc.ciphertext, 'utf8'), photo.sha256, photo.mimeType]
    );
  }

  await insertChangeLogRows(client, person.person_id, syncEventId, changes);

  await client.query(
    `UPDATE mdm.person
     SET status = 'ACTIVE', claimed_at = now(), thaid_verified_at = now(), verification_status = 'VERIFIED',
         reverify_requested_at = NULL, reverify_due_at = NULL, pid_enc = $2, key_id = $3, version = version + 1
     WHERE person_id = $1`,
    [person.person_id, Buffer.from(ciphertext, 'utf8'), keyId]
  );

  const newVersion = person.version + 1;
  const changedFieldKeys = changes.map((c) => c.fieldKey);
  await insertOutboxEvent(client, {
    personId: person.person_id,
    eventType: 'PERSON_CLAIMED',
    changedFields: changedFieldKeys,
    version: newVersion,
    status: 'ACTIVE',
    verificationStatus: 'VERIFIED',
  });
  if (photo) {
    await insertOutboxEvent(client, {
      personId: person.person_id,
      eventType: 'PHOTO_UPDATED',
      changedFields: ['photo'],
      version: newVersion,
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
    });
  }

  return {
    httpStatus: 200,
    body: {
      result: 'CLAIMED',
      personId: person.person_id,
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      changedFields: photo ? [...changedFieldKeys, 'photo'] : changedFieldKeys,
      nameMismatchWithHr,
      tokenClaims: await buildTokenClaims(client, person.person_id, claims),
    },
  };
}

async function handleActiveSync(client, vault, { person, claims, context, trigger, canonical, newSnapshotHash, photo }) {
  const effectiveTrigger = ['STALE', 'EXPIRED'].includes(person.verification_status) ? 'REVERIFY' : trigger;

  const identityResult = await client.query(`SELECT * FROM mdm.person_identity WHERE person_id = $1`, [
    person.person_id,
  ]);
  const existingIdentity = identityResult.rows[0] || null;
  const oldSnapshotHash = existingIdentity?.source_snapshot_hash ?? null;

  const currentPhotoResult = await client.query(
    `SELECT sha256 FROM mdm.person_photo WHERE person_id = $1 AND is_current = true`,
    [person.person_id]
  );
  const photoChanged = Boolean(photo) && currentPhotoResult.rows[0]?.sha256 !== photo?.sha256;

  const syncEventId = crypto.randomUUID();

  if (newSnapshotHash === oldSnapshotHash && !photoChanged) {
    await client.query(
      `INSERT INTO audit.thaid_sync_event
        (sync_event_id, person_id, trigger, result, app_id, audience, snapshot_hash_before, snapshot_hash_after, changed_fields, ial, aal, client_ip, user_agent)
       VALUES ($1, $2, $3, 'NO_CHANGE', $4, $5, $6, $6, '[]', $7, $8, $9, $10)`,
      [
        syncEventId,
        person.person_id,
        effectiveTrigger,
        context.appId,
        context.audience,
        oldSnapshotHash,
        claims.ial ?? null,
        claims.aal ?? null,
        context.clientIp ?? null,
        context.userAgent ?? null,
      ]
    );

    await client.query(
      `UPDATE mdm.person SET thaid_verified_at = now(), verification_status = 'VERIFIED',
        reverify_requested_at = NULL, reverify_due_at = NULL WHERE person_id = $1`,
      [person.person_id]
    );

    return {
      httpStatus: 200,
      body: {
        result: 'NO_CHANGE',
        personId: person.person_id,
        status: 'ACTIVE',
        verificationStatus: 'VERIFIED',
        changedFields: [],
        nameMismatchWithHr: false,
        tokenClaims: await buildTokenClaims(client, person.person_id, claims),
      },
    };
  }

  // UPDATED
  const changes = diffIdentity(canonical, existingIdentity);

  await client.query(
    `INSERT INTO audit.thaid_sync_event
      (sync_event_id, person_id, trigger, result, app_id, audience, snapshot_hash_before, snapshot_hash_after, changed_fields, ial, aal, client_ip, user_agent)
     VALUES ($1, $2, $3, 'UPDATED', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      syncEventId,
      person.person_id,
      effectiveTrigger,
      context.appId,
      context.audience,
      oldSnapshotHash,
      newSnapshotHash,
      JSON.stringify(changes.map((c) => c.fieldKey)),
      claims.ial ?? null,
      claims.aal ?? null,
      context.clientIp ?? null,
      context.userAgent ?? null,
    ]
  );

  if (changes.length > 0) {
    const setClauses = changes.map((c, i) => `${c.column} = $${i + 4}`);
    await client.query(
      `UPDATE mdm.person_identity
       SET ${setClauses.join(', ')}, source_snapshot_hash = $2, last_sync_event_id = $3, synced_at = now()
       WHERE person_id = $1`,
      [person.person_id, newSnapshotHash, syncEventId, ...changes.map((c) => c.newValue)]
    );
    await insertChangeLogRows(client, person.person_id, syncEventId, changes);
  } else {
    // snapshot ต่าง (เช่น scope เปลี่ยนทำให้ชุดฟิลด์ต่าง) แต่ diff รายฟิลด์ไม่พบความต่างจริง
    await client.query(
      `UPDATE mdm.person_identity SET source_snapshot_hash = $2, last_sync_event_id = $3, synced_at = now()
       WHERE person_id = $1`,
      [person.person_id, newSnapshotHash, syncEventId]
    );
  }

  if (photoChanged) {
    const photoEnc = await vault.encrypt(PHOTO_KEY_NAME, photo.buffer, person.person_id);
    await client.query(
      `UPDATE mdm.person_photo SET is_current = false WHERE person_id = $1 AND is_current = true`,
      [person.person_id]
    );
    await client.query(
      `INSERT INTO mdm.person_photo (person_id, image_enc, sha256, mime_type, source, is_current, synced_at)
       VALUES ($1, $2, $3, $4, 'THAID', true, now())`,
      [person.person_id, Buffer.from(photoEnc.ciphertext, 'utf8'), photo.sha256, photo.mimeType]
    );
  }

  await client.query(
    `UPDATE mdm.person SET version = version + 1, thaid_verified_at = now(), verification_status = 'VERIFIED',
      reverify_requested_at = NULL, reverify_due_at = NULL WHERE person_id = $1`,
    [person.person_id]
  );

  const newVersion = person.version + 1;
  const changedFieldKeys = changes.map((c) => c.fieldKey);

  if (changedFieldKeys.length > 0) {
    await insertOutboxEvent(client, {
      personId: person.person_id,
      eventType: 'IDENTITY_UPDATED',
      changedFields: changedFieldKeys,
      version: newVersion,
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
    });
  }
  if (photoChanged) {
    await insertOutboxEvent(client, {
      personId: person.person_id,
      eventType: 'PHOTO_UPDATED',
      changedFields: ['photo'],
      version: newVersion,
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
    });
  }

  return {
    httpStatus: 200,
    body: {
      result: 'UPDATED',
      personId: person.person_id,
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      changedFields: photoChanged ? [...changedFieldKeys, 'photo'] : changedFieldKeys,
      nameMismatchWithHr: false,
      tokenClaims: await buildTokenClaims(client, person.person_id, claims),
    },
  };
}

async function handleRejectedInactive(client, { person, context, trigger }) {
  await client.query(
    `INSERT INTO audit.thaid_sync_event (person_id, trigger, result, app_id, audience, client_ip, user_agent)
     VALUES ($1, $2, 'REJECTED_INACTIVE', $3, $4, $5, $6)`,
    [person.person_id, trigger, context.appId, context.audience, context.clientIp ?? null, context.userAgent ?? null]
  );

  return { httpStatus: 403, body: { result: 'REJECTED_INACTIVE', personId: person.person_id, status: 'INACTIVE' } };
}

async function syncFromThaid({ pool, vault, pepper }, requestBody) {
  const { claims, context } = requestBody;
  const trigger = requestBody.trigger || 'LOGIN';

  if (!isValidPid(claims.pid)) {
    throw new HttpProblem(400, 'invalid-pid', 'เลขบัตรประชาชนไม่ถูกต้อง', 'pid ไม่ผ่านการตรวจ checksum (mod 11)');
  }

  const hash = pidHash(claims.pid, pepper);
  const canonical = canonicalizeIdentityClaims(claims);
  const newSnapshotHash = snapshotHash(canonical);

  let photo = null;
  if (claims.photo?.base64) {
    const buffer = Buffer.from(claims.photo.base64, 'base64');
    photo = { buffer, sha256: sha256Hex(buffer), mimeType: claims.photo.mimeType };
  }

  return withTransaction(pool, async (client) => {
    const personResult = await client.query(`SELECT * FROM mdm.person WHERE pid_hash = $1 FOR UPDATE`, [hash]);

    if (personResult.rowCount === 0) {
      return handleUnmatched(client, { hash, claims, context, trigger });
    }

    const person = personResult.rows[0];

    if (person.status === 'PENDING_CLAIM') {
      return handleClaim(client, vault, { person, claims, context, trigger, canonical, newSnapshotHash, photo });
    }

    if (person.status === 'ACTIVE') {
      return handleActiveSync(client, vault, { person, claims, context, trigger, canonical, newSnapshotHash, photo });
    }

    return handleRejectedInactive(client, { person, context, trigger });
  });
}

module.exports = { syncFromThaid };
