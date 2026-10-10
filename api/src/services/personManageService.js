const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');
const { redactPidText } = require('../security/redact');
const { presentContact, presentEmergencyContacts } = require('./personPresenter');
const { writeChangeLog, actorFromAuth } = require('./changeLogWriter');
const { assertReason } = require('./reason');
const { validateContactFields } = require('../security/contactFields');
const { applyEmergencyContacts, CONTACT_FIELD_KEYS } = require('./meService');
const { presentChangeValues } = require('./auditService');

// PR-D2: HR (role hr_master_data_admin + scope personnel:manage:person) จัดการข้อมูลบุคคลที่ "ไม่ใช่ของ ThaID"
//  - ข้อมูลระบุตัวตนที่ HR คาดไว้ (expected_*) ของคนที่ยังไม่เคยยืนยัน ThaID: ThaID เป็นหลักเสมอ ค่าที่ HR กรอกถูกเขียนทับตอน claim ไม่แจ้งเตือน
//  - ข้อมูลติดต่อ + ผู้ติดต่อฉุกเฉิน (แก้ได้ตลอด ทั้ง HR และเจ้าตัวผ่าน portal)
// ทุกการเขียน: expectedVersion บังคับ (409 version-conflict), reason บังคับ (reason.js), ล็อกแถว person FOR UPDATE, data_change_log ผ่าน changeLogWriter
// (actor_sub/actor_client จาก token) ใน transaction เดียวกับการเปลี่ยนข้อมูล; บุคคลที่ยัง PENDING_CLAIM ไม่ส่ง outbox (เหมือน provision)

const SQLSTATE_IDENTITY_LOCKED = 'MD001'; // trigger mdm.guard_expected_identity (migration 051)
const MIN_BIRTH_DATE = '1900-01-01';

function identityLockedProblem() {
  return new HttpProblem(
    409,
    'identity-locked',
    'แก้ข้อมูลระบุตัวตนไม่ได้',
    'บุคคลนี้เคยยืนยันตัวตนผ่าน ThaID แล้ว (หรือไม่ได้อยู่ในสถานะ PENDING_CLAIM) ข้อมูลระบุตัวตนมาจาก ThaID เป็นหลักและแก้ด้วยมือไม่ได้'
  );
}

// เคยยืนยันแล้ว = มีเวลายืนยัน/claim หรือสถานะไม่ใช่ PENDING_CLAIM (เงื่อนไขเดียวกับ trigger ใน DB)
function identityLockReason(person) {
  if (person.thaid_verified_at || person.claimed_at) return 'THAID_VERIFIED';
  if (person.status !== 'PENDING_CLAIM') return 'NOT_PENDING_CLAIM';
  return null;
}

function assertVersion(person, expectedVersion) {
  if (expectedVersion !== person.version) {
    throw new HttpProblem(409, 'version-conflict', 'version ไม่ตรงกับปัจจุบัน', `expectedVersion=${expectedVersion} แต่ปัจจุบันคือ ${person.version}`);
  }
}

// checkVersion=false: ผู้เรียกตรวจ version เองทีหลัง (expected-identity ตรวจ "เคยยืนยันแล้ว" ก่อน เพราะ claim เพิ่ม version ด้วย - ถ้าตรวจ version ก่อน
// คนที่เพิ่งถูก claim จะได้ version-conflict ทั้งที่เหตุจริงคือ identity-locked)
async function lockPerson(client, personId, expectedVersion, { checkVersion = true } = {}) {
  const { rows } = await client.query(
    `SELECT person_id, status, version, thaid_verified_at, claimed_at,
            expected_first_name_th, expected_last_name_th, expected_birth_date::text AS expected_birth_date
     FROM mdm.person WHERE person_id = $1 FOR UPDATE`,
    [personId]
  );
  if (rows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');
  if (checkVersion) assertVersion(rows[0], expectedVersion);
  return rows[0];
}

async function loadProfile(client, personId) {
  const { rows } = await client.query(
    `SELECT p.person_id, p.status, p.version, p.updated_at, p.thaid_verified_at, p.claimed_at,
            p.expected_first_name_th, p.expected_last_name_th, p.expected_birth_date::text AS expected_birth_date,
            pc.mobile_phone, pc.phone_alt, pc.email_personal, pc.line_id, pc.same_as_registered,
            pc.cur_house_no, pc.cur_moo, pc.cur_soi, pc.cur_road, pc.cur_address_text,
            pc.cur_subdistrict_code, pc.cur_district_code, pc.cur_province_code, pc.cur_postcode,
            pc.updated_by AS contact_updated_by, pc.updated_at AS contact_updated_at
     FROM mdm.person p LEFT JOIN mdm.person_contact pc ON pc.person_id = p.person_id
     WHERE p.person_id = $1`,
    [personId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const { rows: emergency } = await client.query(
    `SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact WHERE person_id = $1 ORDER BY priority`,
    [personId]
  );
  const lockedReason = identityLockReason(row);
  const profile = {
    personId: row.person_id,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
    // ข้อมูลที่ HR กรอก "รอยืนยันด้วย ThaID" - ไม่ใช่ค่าจาก ThaID (ค่าจริงของคนที่ยืนยันแล้วอยู่ที่ GET /persons/{id} ตาม scope เดิม)
    expectedIdentity: {
      firstNameTh: row.expected_first_name_th ?? undefined,
      lastNameTh: row.expected_last_name_th ?? undefined,
      birthDate: row.expected_birth_date ?? undefined,
      editable: lockedReason === null,
      lockedReason,
    },
    emergencyContacts: presentEmergencyContacts(emergency),
  };
  const contact = presentContact(row.contact_updated_at != null || row.mobile_phone != null ? row : null);
  if (contact) profile.contact = contact;
  return profile;
}

// GET /persons/{id}/manage-profile - ข้อมูลสำหรับฟอร์มแก้ไข (ค่าเต็ม) เขียน access_log โดย middleware (operation อยู่ใน PERSONAL_DATA_OPERATIONS)
async function getManageProfile(pool, personId) {
  const profile = await loadProfile(pool, personId);
  if (!profile) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');
  return profile;
}

function assertBirthDateInRange(value) {
  if (value === null || value === undefined) return;
  const today = new Date().toISOString().slice(0, 10);
  if (value < MIN_BIRTH_DATE || value > today) {
    throw new HttpProblem(422, 'birth-date-out-of-range', 'วันเกิดไม่ถูกต้อง', `วันเกิดต้องอยู่ระหว่าง ${MIN_BIRTH_DATE} ถึงวันนี้`);
  }
}

// PATCH /persons/{id}/expected-identity - ส่งเฉพาะฟิลด์ที่แก้ (firstNameTh, lastNameTh, birthDate; birthDate=null ล้างค่า)
async function patchExpectedIdentity(pool, personId, body, auth) {
  const actor = actorFromAuth(auth);
  const reason = assertReason(body.reason);
  const fields = {};
  if ('firstNameTh' in body) fields.expected_first_name_th = body.firstNameTh?.trim();
  if ('lastNameTh' in body) fields.expected_last_name_th = body.lastNameTh?.trim();
  if ('birthDate' in body) fields.expected_birth_date = body.birthDate ?? null;
  if (Object.keys(fields).length === 0) {
    throw new HttpProblem(422, 'no-changes-requested', 'ไม่ได้ระบุฟิลด์ที่จะแก้', 'ต้องส่ง firstNameTh, lastNameTh หรือ birthDate อย่างน้อยหนึ่งฟิลด์');
  }
  for (const key of ['expected_first_name_th', 'expected_last_name_th']) {
    if (key in fields && !fields[key]) throw new HttpProblem(422, 'name-required', 'ชื่อ/นามสกุลห้ามว่าง', 'firstNameTh/lastNameTh ต้องไม่ว่างหลังตัดช่องว่าง');
    if (key in fields && /\d(?:[ -]?\d){12}/.test(fields[key])) {
      throw new HttpProblem(422, 'name-contains-pid', 'ชื่อ/นามสกุลมีเลข 13 หลัก', 'firstNameTh/lastNameTh ห้ามมีเลข 13 หลัก');
    }
  }
  assertBirthDateInRange(fields.expected_birth_date);

  try {
    await withTransaction(pool, async (client) => {
      const person = await lockPerson(client, personId, body.expectedVersion, { checkVersion: false });
      // ตรวจ "เคยยืนยันแล้ว" ใน transaction เดียวกับที่ล็อกแถว (sync ล็อกแถวเดียวกัน FOR UPDATE จึงเห็นผลของอีกฝั่งเสมอ ไม่มีช่องให้แข่งกัน)
      if (identityLockReason(person)) throw identityLockedProblem();
      assertVersion(person, body.expectedVersion);

      const changes = Object.entries(fields)
        .map(([column, next]) => ({ column, fieldKey: `person.${column}`, old: person[column] ?? null, next }))
        .filter((c) => c.old !== c.next);
      if (changes.length === 0) return;

      const sets = changes.map((c, i) => `${c.column} = $${i + 3}`);
      await client.query(
        `UPDATE mdm.person SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE person_id = $1 AND version = $2`,
        [personId, person.version, ...changes.map((c) => c.next)]
      );
      for (const c of changes) {
        // eslint-disable-next-line no-await-in-loop
        await writeChangeLog(client, { personId, tableName: 'person', fieldName: c.fieldKey, oldValue: c.old, newValue: c.next, changedBy: 'HR', actor, reason });
      }
    });
  } catch (err) {
    // trigger ใน DB กันซ้ำ (ชั้นที่สอง): ถ้าหลุดมาถึงตรงนี้ให้ตอบเหมือนการตรวจใน API
    if (err.code === SQLSTATE_IDENTITY_LOCKED) throw identityLockedProblem();
    throw err;
  }
  return getManageProfile(pool, personId);
}

// ---- PATCH /persons/{id}/contact -----------------------------------------------------------------------------------------------------------------

const CONTACT_COLUMN_OF = {
  mobilePhone: 'mobile_phone',
  phoneAlt: 'phone_alt',
  emailPersonal: 'email_personal',
  lineId: 'line_id',
};
// คอลัมน์ที่อยู่ปัจจุบัน/same_as_registered เลิกรับจาก request แล้ว แต่ต้องอยู่ในรายการเพื่อคงค่าเดิมไว้ตอน upsert (ไม่ถูกล้าง)
const KEPT_ADDRESS_COLUMNS = [
  'same_as_registered', 'cur_house_no', 'cur_moo', 'cur_soi', 'cur_road', 'cur_subdistrict_code', 'cur_district_code',
  'cur_province_code', 'cur_postcode', 'cur_address_text',
];
const CONTACT_COLUMNS = [...Object.values(CONTACT_COLUMN_OF), ...KEPT_ADDRESS_COLUMNS];

// คืน { column: ค่าใหม่ } เฉพาะ key ที่ "ส่งมา" (null = ล้างค่า, ไม่ส่ง = ไม่แตะ); สตริงว่าง/ช่องว่างล้วน = ล้างค่า
function contactPatchFrom(body) {
  const patch = {};
  const clean = (v) => (typeof v === 'string' ? v.trim() || null : v);
  for (const [key, column] of Object.entries(CONTACT_COLUMN_OF)) if (key in body) patch[column] = clean(body[key]);
  return patch;
}

async function patchContact(pool, personId, body, auth) {
  const actor = actorFromAuth(auth);
  const reason = assertReason(body.reason);
  const patch = contactPatchFrom(body);
  if (Object.keys(patch).length === 0) {
    throw new HttpProblem(422, 'no-changes-requested', 'ไม่ได้ระบุฟิลด์ที่จะแก้', 'ต้องส่งฟิลด์ข้อมูลติดต่ออย่างน้อยหนึ่งฟิลด์');
  }

  await withTransaction(pool, async (client) => {
    const person = await lockPerson(client, personId, body.expectedVersion);
    const { rows } = await client.query(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [personId]);
    const existing = rows[0] || null;

    // ตรวจรูปแบบเบอร์/อีเมลเฉพาะฟิลด์ที่ส่งมาและต่างจากค่าเดิม แล้วใช้ค่าที่ normalize แล้ว (เบอร์ = ตัวเลขล้วน) แทนค่าที่พิมพ์มา
    const checked = validateContactFields(body, existing);
    for (const [key, column] of [['mobilePhone', 'mobile_phone'], ['phoneAlt', 'phone_alt'], ['emailPersonal', 'email_personal']]) {
      if (key in checked) patch[column] = checked[key];
    }

    const changes = Object.entries(patch)
      .map(([column, next]) => ({ column, old: existing ? (existing[column] ?? null) : column === 'same_as_registered' ? true : null, next }))
      .filter((c) => c.old !== c.next);
    if (changes.length === 0) return;

    const merged = Object.fromEntries(CONTACT_COLUMNS.map((c) => [c, existing ? (existing[c] ?? null) : c === 'same_as_registered' ? true : null]));
    for (const c of changes) merged[c.column] = c.next;
    const cols = CONTACT_COLUMNS;
    await client.query(
      `INSERT INTO mdm.person_contact (person_id, ${cols.join(', ')}, updated_by, updated_at)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, 'HR', now())
       ON CONFLICT (person_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_by = 'HR', updated_at = now()`,
      [personId, ...cols.map((c) => merged[c])]
    );

    const fieldKeyOf = (column) => CONTACT_FIELD_KEYS[column] ?? `contact.${column}`;
    for (const c of changes) {
      // eslint-disable-next-line no-await-in-loop
      await writeChangeLog(client, { personId, tableName: 'person_contact', fieldName: fieldKeyOf(c.column), oldValue: c.old, newValue: c.next, changedBy: 'HR', actor, reason });
    }

    const newVersion = person.version + 1;
    await client.query(`UPDATE mdm.person SET version = $2, updated_at = now() WHERE person_id = $1`, [personId, newVersion]);
    if (person.status !== 'PENDING_CLAIM') {
      await client.query(
        `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
         VALUES ($1, 'CONTACT_UPDATED', $2, $3, $4)`,
        [personId, JSON.stringify(changes.map((c) => fieldKeyOf(c.column))), JSON.stringify({ personId, version: newVersion, status: person.status }), newVersion]
      );
    }
  });
  return getManageProfile(pool, personId);
}

// PUT /persons/{id}/emergency-contacts - แทนที่ทั้งรายการ (สูงสุด 3) ลง log เฉพาะฟิลด์/ช่องที่เปลี่ยน "ไม่เก็บค่า" เหมือน portal
async function replaceEmergencyContactsByHr(pool, personId, body, auth) {
  const actor = actorFromAuth(auth);
  const reason = assertReason(body.reason);
  await withTransaction(pool, async (client) => {
    const person = await lockPerson(client, personId, body.expectedVersion);
    await applyEmergencyContacts(client, {
      personId,
      personRow: person,
      contacts: body.contacts,
      changedBy: 'HR',
      actor,
      reasonFor: (slot) => `${reason} (ผู้ติดต่อฉุกเฉินลำดับที่ ${slot})`,
      emitOutbox: person.status !== 'PENDING_CLAIM',
    });
  });
  return getManageProfile(pool, personId);
}

// GET /persons/{id}/history - ประวัติการเปลี่ยนแปลงของบุคคลนี้สำหรับ HR เรียงใหม่ -> เก่า ค่าของฟิลด์ชั้น CONFIDENTIAL/SENSITIVE/RESTRICTED ปกปิด
// (เหมือนหน้า DPO: เห็นว่าฟิลด์ไหนเปลี่ยน ใคร เมื่อไหร่ เพราะอะไร) actor_sub แสดงเป็นรหัสบัญชี
async function getPersonHistory(pool, personId, { cursor, limit }) {
  const { rows: exists } = await pool.query(`SELECT 1 FROM mdm.person WHERE person_id = $1`, [personId]);
  if (exists.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');

  const params = [personId];
  let cursorSql = '';
  if (cursor) {
    params.push(cursor);
    cursorSql = `AND dcl.log_id < $${params.length}`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT dcl.log_id, dcl.changed_at, dcl.table_name, dcl.field_name, dcl.old_value, dcl.new_value, dcl.changed_by,
            dcl.actor_sub, dcl.actor_client, dcl.sync_event_id, dcl.reason, fp.classification
     FROM audit.data_change_log dcl
     LEFT JOIN mdm.field_policy fp ON fp.field_key = dcl.field_name
     WHERE dcl.person_id = $1 ${cursorSql}
     ORDER BY dcl.log_id DESC
     LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const data = page.map((r) => ({
    logId: Number(r.log_id),
    changedAt: r.changed_at,
    fieldKey: r.field_name,
    ...presentChangeValues(r.classification, r.old_value, r.new_value),
    changedBy: r.changed_by,
    actorSub: r.actor_sub,
    actorClient: r.actor_client,
    syncEventId: r.sync_event_id,
    reason: r.reason === null ? null : redactPidText(r.reason),
  }));
  return { data, page: { nextCursor: hasMore ? String(page[page.length - 1].log_id) : null, limit } };
}

module.exports = {
  assertBirthDateInRange,
  getManageProfile,
  patchExpectedIdentity,
  patchContact,
  replaceEmergencyContactsByHr,
  getPersonHistory,
};
