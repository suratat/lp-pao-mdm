const { withTransaction } = require('../db/transaction');
const { HttpProblem } = require('../security/httpProblem');
const { presentContact, presentEmergencyContacts } = require('./personPresenter');
const { writeChangeLog, actorFromSelf } = require('./changeLogWriter');

// actor ของงานในไฟล์นี้คือเจ้าของข้อมูลเอง (ผ่าน portal): sub ใน Bearer token เป็น service account ของ portal จึงใช้ personId แทน
function selfActor(personId, auth) {
  return actorFromSelf({ personId, azp: auth?.azp });
}

const CONTACT_FIELD_KEYS = {
  mobile_phone: 'contact.mobile_phone',
  phone_alt: 'contact.phone_alt',
  email_personal: 'contact.email_personal',
  line_id: 'contact.line_id',
  cur_house_no: 'contact.cur_house_no',
  cur_moo: 'contact.cur_moo',
  cur_soi: 'contact.cur_soi',
  cur_road: 'contact.cur_road',
  cur_subdistrict_code: 'contact.cur_subdistrict_code',
  cur_district_code: 'contact.cur_district_code',
  cur_province_code: 'contact.cur_province_code',
  cur_postcode: 'contact.cur_postcode',
  cur_address_text: 'contact.cur_address_text',
};

// PUT เป็นการแทนที่ทั้ง resource (ฟิลด์ที่ไม่ได้ส่งมา = null) ตรงตามความหมายของ PUT ตามหลัก REST
// เจ้าของข้อมูลแก้ไขได้เฉพาะฟิลด์ที่ไม่ได้มาจาก ThaID และไม่ใช่ข้อมูลการปฏิบัติงาน (ตรงตาม description
// ของ operation นี้อยู่แล้ว เพราะ ContactUpdate schema ไม่มีฟิลด์เหล่านั้นให้ส่งมาตั้งแต่แรก)
async function updateMyContact(pool, personId, body, auth) {
  const actor = selfActor(personId, auth);
  return withTransaction(pool, async (client) => {
    const { rows: existingRows } = await client.query(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [
      personId,
    ]);
    const existing = existingRows[0] || null;
    const addr = body.currentAddress || {};

    const newValues = {
      mobile_phone: body.mobilePhone ?? null,
      phone_alt: body.phoneAlt ?? null,
      email_personal: body.emailPersonal ?? null,
      line_id: body.lineId ?? null,
      cur_house_no: addr.houseNo ?? null,
      cur_moo: addr.moo ?? null,
      cur_soi: addr.soi ?? null,
      cur_road: addr.road ?? null,
      cur_subdistrict_code: addr.subdistrict?.code ?? null,
      cur_district_code: addr.district?.code ?? null,
      cur_province_code: addr.province?.code ?? null,
      cur_postcode: addr.postcode ?? null,
      cur_address_text: addr.fullText ?? null,
    };
    const sameAsRegistered = body.sameAsRegistered ?? false;

    await client.query(
      `INSERT INTO mdm.person_contact
        (person_id, mobile_phone, phone_alt, email_personal, line_id, same_as_registered,
         cur_house_no, cur_moo, cur_soi, cur_road, cur_subdistrict_code, cur_district_code, cur_province_code,
         cur_postcode, cur_address_text, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'SELF', now())
       ON CONFLICT (person_id) DO UPDATE SET
         mobile_phone = EXCLUDED.mobile_phone, phone_alt = EXCLUDED.phone_alt,
         email_personal = EXCLUDED.email_personal, line_id = EXCLUDED.line_id,
         same_as_registered = EXCLUDED.same_as_registered,
         cur_house_no = EXCLUDED.cur_house_no, cur_moo = EXCLUDED.cur_moo, cur_soi = EXCLUDED.cur_soi,
         cur_road = EXCLUDED.cur_road, cur_subdistrict_code = EXCLUDED.cur_subdistrict_code,
         cur_district_code = EXCLUDED.cur_district_code, cur_province_code = EXCLUDED.cur_province_code,
         cur_postcode = EXCLUDED.cur_postcode, cur_address_text = EXCLUDED.cur_address_text,
         updated_by = 'SELF', updated_at = now()`,
      [
        personId,
        newValues.mobile_phone,
        newValues.phone_alt,
        newValues.email_personal,
        newValues.line_id,
        sameAsRegistered,
        newValues.cur_house_no,
        newValues.cur_moo,
        newValues.cur_soi,
        newValues.cur_road,
        newValues.cur_subdistrict_code,
        newValues.cur_district_code,
        newValues.cur_province_code,
        newValues.cur_postcode,
        newValues.cur_address_text,
      ]
    );

    const changedFields = [];
    for (const [column, fieldKey] of Object.entries(CONTACT_FIELD_KEYS)) {
      const oldValue = existing ? (existing[column] ?? null) : null;
      const newValue = newValues[column];
      if (oldValue !== newValue) {
        changedFields.push(fieldKey);
        // eslint-disable-next-line no-await-in-loop
        await writeChangeLog(client, {
          personId,
          tableName: 'person_contact',
          fieldName: fieldKey,
          oldValue,
          newValue,
          changedBy: 'SELF',
          actor,
        });
      }
    }

    if (changedFields.length > 0) {
      const { rows: personRows } = await client.query(`SELECT version, status FROM mdm.person WHERE person_id = $1`, [
        personId,
      ]);
      const newVersion = personRows[0].version + 1;
      await client.query(`UPDATE mdm.person SET version = $2 WHERE person_id = $1`, [personId, newVersion]);
      await client.query(
        `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
         VALUES ($1, 'CONTACT_UPDATED', $2, $3, $4)`,
        [
          personId,
          JSON.stringify(changedFields),
          JSON.stringify({ personId, version: newVersion, status: personRows[0].status }),
          newVersion,
        ]
      );
    }

    const { rows: fresh } = await client.query(`SELECT * FROM mdm.person_contact WHERE person_id = $1`, [personId]);
    return presentContact({ ...fresh[0], contact_updated_at: fresh[0].updated_at, contact_updated_by: fresh[0].updated_by });
  });
}

// แทนที่ทั้งรายการ (สูงสุด 3) - emergency_contact ไม่ใช่ข้อมูลหลักที่ต้องคงค่าไว้ตลอดไป จึงลบแถวเดิมได้จริง
// (ดูเหตุผลใน migration 1700000000025_emergency_contact_delete_grant.js) แต่การ "เปลี่ยน" ต้องมีร่องรอยตามกฎข้อ 3 ของ CLAUDE.md:
// data_change_log + outbox_event + version ใน transaction เดียวกัน (เดิมไม่มีทั้งสามอย่าง) โดย "ไม่เก็บค่า" ชื่อ/เบอร์ของบุคคลที่สามลง
// audit แบบ append-only ถาวร (ขัดกับเหตุผลที่อนุญาตให้ลบได้): บันทึกเฉพาะ ผู้กระทำ + ฟิลด์ที่เปลี่ยน + ลำดับช่อง (ใน reason)
const EMERGENCY_FIELDS = [
  ['full_name', 'emergency_contact.full_name'],
  ['relationship', 'emergency_contact.relationship'],
  ['phone', 'emergency_contact.phone'],
];

// เทียบรายการเดิม/ใหม่รายช่อง (priority 1-3) คืนรายการ { slot, fieldKey } ที่เปลี่ยนจริง (เพิ่ม/ลบ/แก้ ช่อง = เปลี่ยนทุกฟิลด์ที่มีค่าฝั่งใดฝั่งหนึ่ง)
function diffEmergencyContacts(oldRows, newRows) {
  const bySlot = (rows) => new Map(rows.map((r) => [r.priority, r]));
  const oldMap = bySlot(oldRows);
  const newMap = bySlot(newRows);
  const changes = [];
  for (const slot of [...new Set([...oldMap.keys(), ...newMap.keys()])].sort((x, y) => x - y)) {
    for (const [column, fieldKey] of EMERGENCY_FIELDS) {
      const before = oldMap.get(slot)?.[column] ?? null;
      const after = newMap.get(slot)?.[column] ?? null;
      if (before !== after) changes.push({ slot, fieldKey });
    }
  }
  return changes;
}

// ตรวจ/ทำให้เป็นรูปเดียวกันก่อนเขียน: priority 1-3 ไม่ซ้ำ (ซ้ำเดิมชน UNIQUE ของ DB แล้วเป็น 500), ไม่เกิน 3 รายการ
function normalizeEmergencyContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length > 3) {
    throw new HttpProblem(422, 'emergency-contacts-invalid', 'รายการผู้ติดต่อฉุกเฉินไม่ถูกต้อง', 'ต้องเป็นรายการไม่เกิน 3 คน');
  }
  const incoming = contacts.map((contact, index) => ({
    full_name: contact.fullName,
    relationship: contact.relationship ?? null,
    phone: contact.phone ?? null,
    priority: contact.priority ?? index + 1,
  }));
  const priorities = incoming.map((c) => c.priority);
  if (priorities.some((p) => !Number.isInteger(p) || p < 1 || p > 3) || new Set(priorities).size !== priorities.length) {
    throw new HttpProblem(422, 'emergency-contacts-invalid', 'ลำดับ (priority) ของผู้ติดต่อฉุกเฉินไม่ถูกต้อง', 'priority ต้องเป็น 1-3 และห้ามซ้ำกัน');
  }
  return incoming;
}

// แกนกลางของการแทนที่ผู้ติดต่อฉุกเฉิน ใช้ร่วมกันทั้ง self-service (portal) และ HR (PR-D2): เรียกใน transaction ที่ล็อกแถว person (FOR UPDATE)
// แล้วด้วย personRow = { version, status } คืนรายการใหม่ (แถวจาก DB) - ไม่เก็บค่าลง audit (ดูหมายเหตุด้านบน)
//  - changedBy 'SELF' | 'HR', reasonFor(slot) สร้าง reason ของแต่ละแถว log, emitOutbox=false สำหรับบุคคลที่ยังไม่ claim (เหมือน provision)
async function applyEmergencyContacts(client, { personId, personRow, contacts, changedBy, actor, reasonFor, emitOutbox = true }) {
  const incoming = normalizeEmergencyContacts(contacts);

  const { rows: before } = await client.query(
    `SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact WHERE person_id = $1`,
    [personId]
  );

  await client.query(`DELETE FROM mdm.emergency_contact WHERE person_id = $1`, [personId]);
  for (const c of incoming) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO mdm.emergency_contact (person_id, full_name, relationship, phone, priority) VALUES ($1, $2, $3, $4, $5)`,
      [personId, c.full_name, c.relationship, c.phone, c.priority]
    );
  }

  const changes = diffEmergencyContacts(before, incoming);
  let newVersion = personRow.version;
  if (changes.length > 0) {
    for (const { slot, fieldKey } of changes) {
      // oldValue/newValue เป็น null เสมอ (ไม่เก็บค่า) - field_policy ตั้ง log_values_in_audit=false ซ้ำอีกชั้น (migration 1700000000049)
      // eslint-disable-next-line no-await-in-loop
      await writeChangeLog(client, { personId, tableName: 'emergency_contact', fieldName: fieldKey, changedBy, actor, reason: reasonFor(slot) });
    }
    newVersion = personRow.version + 1;
    await client.query(`UPDATE mdm.person SET version = $2 WHERE person_id = $1`, [personId, newVersion]);
    if (emitOutbox) {
      const changedFields = [...new Set(changes.map((c) => c.fieldKey))];
      await client.query(
        `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
         VALUES ($1, 'CONTACT_UPDATED', $2, $3, $4)`,
        [personId, JSON.stringify(changedFields), JSON.stringify({ personId, version: newVersion, status: personRow.status }), newVersion]
      );
    }
  }

  const { rows } = await client.query(
    `SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact WHERE person_id = $1 ORDER BY priority`,
    [personId]
  );
  return { rows, changed: changes.length > 0, version: newVersion };
}

async function replaceMyEmergencyContacts(pool, personId, contacts, auth) {
  const actor = selfActor(personId, auth);
  return withTransaction(pool, async (client) => {
    // ล็อกแถว person: เพิ่ม version และกันสอง request แก้พร้อมกัน
    const { rows: personRows } = await client.query(`SELECT version, status FROM mdm.person WHERE person_id = $1 FOR UPDATE`, [personId]);
    if (personRows.length === 0) throw new HttpProblem(404, 'not-found', 'ไม่พบบุคคลนี้');

    const { rows } = await applyEmergencyContacts(client, {
      personId,
      personRow: personRows[0],
      contacts,
      changedBy: 'SELF',
      actor,
      reasonFor: (slot) => `ผู้ติดต่อฉุกเฉินลำดับที่ ${slot}`,
    });
    return presentEmergencyContacts(rows);
  });
}

// รับแจ้งเฉยๆ ไม่มีที่เก็บถาวรในตารางเฉพาะ (เอกสารไม่ได้กำหนด schema ตารางสำหรับเรื่องนี้) - บันทึกเป็น
// data_change_log พร้อม reason เพื่อให้ HR ตรวจสอบย้อนหลังได้ผ่าน GET .../change-log (changed_by=SELF,
// ไม่มี old_value/new_value เพราะไม่ใช่การเปลี่ยนค่าจริง เป็นเพียงคำร้อง)
async function reportIdentityIssue(pool, personId, { fieldKey, description }, auth) {
  await writeChangeLog(pool, {
    personId,
    tableName: 'person_identity',
    fieldName: fieldKey,
    changedBy: 'SELF',
    actor: selfActor(personId, auth),
    reason: description,
  });
}

module.exports = {
  updateMyContact,
  replaceMyEmergencyContacts,
  reportIdentityIssue,
  applyEmergencyContacts,
  normalizeEmergencyContacts,
  diffEmergencyContacts,
  CONTACT_FIELD_KEYS,
};
