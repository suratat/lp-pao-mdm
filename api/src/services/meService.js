const { withTransaction } = require('../db/transaction');
const { presentContact, presentEmergencyContacts } = require('./personPresenter');

function jsonOrNull(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
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
async function updateMyContact(pool, personId, body) {
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
        await client.query(
          `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by)
           VALUES ($1, 'person_contact', $2, $3, $4, 'SELF')`,
          [personId, fieldKey, jsonOrNull(oldValue), jsonOrNull(newValue)]
        );
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

// แทนที่ทั้งรายการ (สูงสุด 3) - emergency_contact ไม่ใช่ข้อมูลหลักที่ต้องคง audit trail ตลอดไป จึงลบ
// แถวเดิมได้จริง (ดูเหตุผลใน migration 1700000000025_emergency_contact_delete_grant.js)
async function replaceMyEmergencyContacts(pool, personId, contacts) {
  return withTransaction(pool, async (client) => {
    await client.query(`DELETE FROM mdm.emergency_contact WHERE person_id = $1`, [personId]);

    for (const [index, contact] of contacts.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO mdm.emergency_contact (person_id, full_name, relationship, phone, priority)
         VALUES ($1, $2, $3, $4, $5)`,
        [personId, contact.fullName, contact.relationship, contact.phone, contact.priority ?? index + 1]
      );
    }

    const { rows } = await client.query(
      `SELECT full_name, relationship, phone, priority FROM mdm.emergency_contact WHERE person_id = $1 ORDER BY priority`,
      [personId]
    );
    return presentEmergencyContacts(rows);
  });
}

// รับแจ้งเฉยๆ ไม่มีที่เก็บถาวรในตารางเฉพาะ (เอกสารไม่ได้กำหนด schema ตารางสำหรับเรื่องนี้) - บันทึกเป็น
// data_change_log พร้อม reason เพื่อให้ HR ตรวจสอบย้อนหลังได้ผ่าน GET .../change-log (changed_by=SELF,
// ไม่มี old_value/new_value เพราะไม่ใช่การเปลี่ยนค่าจริง เป็นเพียงคำร้อง)
async function reportIdentityIssue(pool, personId, { fieldKey, description }) {
  await pool.query(
    `INSERT INTO audit.data_change_log (person_id, table_name, field_name, old_value, new_value, changed_by, reason)
     VALUES ($1, 'person_identity', $2, NULL, NULL, 'SELF', $3)`,
    [personId, fieldKey, description]
  );
}

module.exports = { updateMyContact, replaceMyEmergencyContacts, reportIdentityIssue };
