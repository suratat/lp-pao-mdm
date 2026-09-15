const crypto = require('node:crypto');
const { makeFakePid, pidHash } = require('../src/security/pid');
const { insertFixtureOrgUnit } = require('./fixtures');

// T5: ทุก endpoint ทำงานจริงแล้ว (ไม่ใช่ stub เหมือน T2) การทดสอบ contract จึงต้องมี fixture จริงที่
// สอดคล้องกับ business rule ของแต่ละ operation (เช่น getPersonPid ต้องมี pid_enc ที่เข้ารหัสด้วย vault
// instance เดียวกับที่แอปใช้จริง, resolveClaimRequest ต้องมี claim_request แถวจริงที่ PENDING_HR ฯลฯ)
//
// สถาปัตยกรรมไฟล์นี้แยกเป็นสองส่วนเพราะข้อจำกัดของ Jest: describe.each/test.each ต้องได้ array แบบ
// synchronous ตอน "collection phase" (ก่อน beforeAll ใดๆ ทำงาน) แต่การสร้าง fixture ต้องใช้ DB connection
// และ vault instance ของแอปที่ทดสอบ (มีเฉพาะหลังเรียก buildTestApp() ใน beforeAll) จึงแยกเป็น:
//   1) buildOperationDescriptors() - รายการ static เรียกได้ทันทีตอน module load (ไม่แตะ DB/vault)
//      path/body/personId ที่ต้องใช้ id จริงเป็น "ฟังก์ชันรับ ids" แทนค่าคงที่
//   2) seedFixtures({ adminPool, vault }) - async เขียนแถวจริงลง DB ผ่าน adminPool (สิทธิ์เต็ม ไม่ผูกกับ
//      privilege ของ mdm_app ที่แอปใช้จริง) และเข้ารหัสผ่าน vault ตัวเดียวกับที่ createApp() ใช้ คืน object
//      "ids" ที่ path/body ด้านบนจะเรียกใช้ตอนรัน test จริง (หลัง beforeAll เสร็จ)
const CONSUMER_SYSTEM_CLIENT_ID = 'test-client'; // ต้องตรงกับ azp default ของ testJwks.signToken()

async function makePosition(adminPool, orgUnitId) {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.position (position_no, title_th, position_type, org_unit_id)
     VALUES ($1, 'ตำแหน่งทดสอบ contract', 'GENERAL', $2) RETURNING position_id`,
    [`POS-CONTRACT-${crypto.randomUUID()}`, orgUnitId]
  );
  return rows[0].position_id;
}

async function makeActivePerson(adminPool, positionId, orgUnitId) {
  const personId = crypto.randomUUID();
  const pidHashValue = crypto.randomBytes(32).toString('hex');
  await adminPool.query(
    `INSERT INTO mdm.person (person_id, pid_hash, status, verification_status, thaid_verified_at, claimed_at, version)
     VALUES ($1, $2, 'ACTIVE', 'VERIFIED', now(), now(), 1)`,
    [personId, pidHashValue]
  );
  await adminPool.query(
    `INSERT INTO mdm.person_identity (person_id, title_th, first_name_th, last_name_th, birth_date, gender, synced_at)
     VALUES ($1, 'นาย', 'ทดสอบ', 'Contract', '1990-01-01', 'M', now())`,
    [personId]
  );
  await adminPool.query(
    `INSERT INTO mdm.employment
      (person_id, employee_no, personnel_type, position_id, org_unit_id, effective_from, is_current, employment_status, updated_by)
     VALUES ($1, $2, 'CIVIL_SERVANT', $3, $4, CURRENT_DATE, true, 'ACTIVE', 'test')`,
    [personId, `EMP-CONTRACT-${crypto.randomUUID()}`, positionId, orgUnitId]
  );
  return personId;
}

// ผูก pid_enc/photo ด้วย vault instance เดียวกับที่ createApp() ของไฟล์ทดสอบนี้ใช้ (ctx.vault) - ciphertext
// ที่เข้ารหัสโดย instance อื่นถอดรหัสไม่ได้ (fake vault client สุ่มคีย์ AES ใหม่ทุกครั้งที่สร้าง instance)
async function attachPidAndPhoto(adminPool, vault, personId) {
  const pid = makeFakePid();
  const pepper = await vault.getPepper();
  const hash = pidHash(pid, pepper);
  const { ciphertext, keyId } = await vault.encrypt('mdm-pid', Buffer.from(pid, 'utf8'), personId);
  await adminPool.query(`UPDATE mdm.person SET pid_hash = $2, pid_enc = $3, key_id = $4 WHERE person_id = $1`, [
    personId,
    hash,
    Buffer.from(ciphertext, 'utf8'),
    keyId,
  ]);

  const photoBytes = Buffer.from('fake-jpeg-bytes-for-contract-test');
  const { ciphertext: photoCiphertext } = await vault.encrypt('mdm-photo', photoBytes, personId);
  await adminPool.query(
    `INSERT INTO mdm.person_photo (person_id, image_enc, sha256, mime_type, source, is_current, synced_at)
     VALUES ($1, $2, $3, 'image/jpeg', 'THAID', true, now())`,
    [personId, Buffer.from(photoCiphertext, 'utf8'), crypto.createHash('sha256').update(photoBytes).digest('hex')]
  );

  return pid;
}

async function insertConsumerSystem(adminPool) {
  const consumerSystemId = crypto.randomUUID();
  await adminPool.query(
    `INSERT INTO mdm.consumer_system (consumer_system_id, keycloak_client_id, name, purpose_code, status)
     VALUES ($1, $2, 'ระบบทดสอบ contract', 'HR_ADMIN', 'ACTIVE')`,
    [consumerSystemId, CONSUMER_SYSTEM_CLIENT_ID]
  );
  return consumerSystemId;
}

async function insertWebhookSubscription(adminPool, vault, consumerSystemId, url) {
  const subscriptionId = crypto.randomUUID();
  const { ciphertext } = await vault.encrypt('mdm-webhook-secret', Buffer.from('test-secret', 'utf8'), subscriptionId);
  await adminPool.query(
    `INSERT INTO integration.webhook_subscription (subscription_id, consumer_system_id, url, secret_enc, event_types, is_active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [subscriptionId, consumerSystemId, url, Buffer.from(ciphertext, 'utf8'), JSON.stringify(['PERSON_DEACTIVATED'])]
  );
  return subscriptionId;
}

// mdm_app (ที่แอปใช้จริง) ไม่มีสิทธิ์ INSERT บน integration.webhook_delivery (มีแต่ SELECT/UPDATE - แถว
// delivery ปกติสร้างโดย worker เท่านั้น) จึงต้อง seed ผ่าน adminPool เพื่อทดสอบ retryWebhookDelivery
async function insertDeadDelivery(adminPool, subscriptionId, personId) {
  const { rows: eventRows } = await adminPool.query(
    `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
     VALUES ($1, 'PERSON_DEACTIVATED', '[]'::jsonb, $2, 1) RETURNING event_id`,
    [personId, JSON.stringify({ personId, version: 1, status: 'INACTIVE' })]
  );
  const { rows: deliveryRows } = await adminPool.query(
    `INSERT INTO integration.webhook_delivery (subscription_id, event_id, status, attempt_count)
     VALUES ($1, $2, 'DEAD', 8) RETURNING delivery_id`,
    [subscriptionId, eventRows[0].event_id]
  );
  return deliveryRows[0].delivery_id;
}

async function insertPendingClaimRequest(adminPool) {
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
     VALUES ($1, 'นายทดสอบ Contract', 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
    [crypto.randomBytes(32).toString('hex')]
  );
  return rows[0].claim_request_id;
}

// เรียกครั้งเดียวใน beforeAll ของ contract.test.js หลังจาก buildTestApp() - ต้องใช้ vault ตัวเดียวกับที่
// createApp() ใช้ (ctx.vault) เพื่อให้ decrypt ตอนรัน test ตรงกับ ciphertext ที่ seed ไว้ที่นี่
async function seedFixtures({ adminPool, vault }) {
  const orgUnitId = await insertFixtureOrgUnit(adminPool);

  const readPositionId = await makePosition(adminPool, orgUnitId);
  const readPersonId = await makeActivePerson(adminPool, readPositionId, orgUnitId);
  const readPid = await attachPidAndPhoto(adminPool, vault, readPersonId);

  const deactivatePositionId = await makePosition(adminPool, orgUnitId);
  const deactivatePersonId = await makeActivePerson(adminPool, deactivatePositionId, orgUnitId);

  const reactivatePositionId = await makePosition(adminPool, orgUnitId);
  const reactivatePersonId = await makeActivePerson(adminPool, reactivatePositionId, orgUnitId);

  const upsertPositionId = await makePosition(adminPool, orgUnitId);
  const upsertPersonId = await makeActivePerson(adminPool, upsertPositionId, orgUnitId);
  const upsertNewPositionId = await makePosition(adminPool, orgUnitId);

  const consumerSystemId = await insertConsumerSystem(adminPool);
  const subscriptionForDeleteId = await insertWebhookSubscription(
    adminPool,
    vault,
    consumerSystemId,
    'https://example.lp-pao.go.th/hooks/delete-me'
  );
  const subscriptionForTestId = await insertWebhookSubscription(
    adminPool,
    vault,
    consumerSystemId,
    // ไม่มีอะไรฟังอยู่จริงที่พอร์ตนี้ - ต้องการแค่ให้ fetch ล้มเหลวเร็ว (ECONNREFUSED) แทนที่จะรอ DNS ของ
    // โดเมนสมมติซึ่งช้า/ไม่แน่นอนกว่าในสภาพแวดล้อมทดสอบที่อาจบล็อค DNS ขาออก
    'https://127.0.0.1:1/hooks/test-me'
  );
  const deadDeliveryId = await insertDeadDelivery(adminPool, subscriptionForTestId, readPersonId);
  const claimRequestId = await insertPendingClaimRequest(adminPool);

  const provisionPositionId = await makePosition(adminPool, orgUnitId);

  return {
    orgUnitId,
    readPersonId,
    readPid,
    deactivatePersonId,
    reactivatePersonId,
    reactivatePositionId,
    upsertPersonId,
    upsertNewPositionId,
    subscriptionForDeleteId,
    subscriptionForTestId,
    deadDeliveryId,
    claimRequestId,
    provisionPositionId,
  };
}

// วันที่ในอนาคตไกลๆ ใช้กับทุก employment upsert/reactivate ที่ทำบนคนที่มี current employment อยู่แล้ว
// (fixture ตั้ง effective_from = CURRENT_DATE) เพราะ closeAndOpenEmployment ปิด record เดิมด้วย
// effective_to = incoming.effectiveFrom โดยไม่เปลี่ยน employment_status (ยังเป็น ACTIVE) - ถ้า
// effectiveFrom ใหม่มาก่อน effective_from เดิม daterange(from, to) จะกลับด้าน (to < from) ซึ่ง Postgres
// ปฏิเสธตอนคำนวณ expression ของ EXCLUDE constraint (ยังต้องคำนวณอยู่เพราะแถวเดิมยังผ่าน WHERE
// employment_status='ACTIVE' ของ partial index) - ไม่ใช่ปัญหาของ business logic แต่เป็นข้อจำกัดของ fixture
const FUTURE_EFFECTIVE_FROM = '2099-01-01';

// รายการ static เรียกได้ทันทีตอน module load (ไม่แตะ DB/vault) - path/body ที่ต้องใช้ id จริงเป็นฟังก์ชัน
// รับ ids (populate แล้วโดย seedFixtures ก่อนที่ test จริงจะรัน) ส่วน pathTemplate มีไว้แสดงชื่อ test เท่านั้น
function buildOperationDescriptors() {
  return [
    { name: 'searchPersons', method: 'get', pathTemplate: '/persons', path: () => '/persons', scope: 'personnel:read:basic', expectStatus: 200 },
    {
      name: 'provisionPerson',
      method: 'post',
      pathTemplate: '/persons',
      path: () => '/persons',
      scope: 'personnel:read:basic personnel:provision',
      body: (ids) => ({
        pid: makeFakePid(),
        expectedFirstNameTh: 'ทดสอบ',
        expectedLastNameTh: 'ระบบ',
        employment: {
          employeeNo: `EMP-PROVISION-${crypto.randomUUID()}`,
          personnelType: 'CIVIL_SERVANT',
          positionId: ids.provisionPositionId,
          orgUnitId: ids.orgUnitId,
          effectiveFrom: '2024-01-01',
        },
      }),
      expectStatus: 201,
    },
    {
      name: 'lookupPersonByPid',
      method: 'post',
      pathTemplate: '/persons/lookup',
      path: () => '/persons/lookup',
      scope: 'personnel:lookup:pid',
      body: (ids) => ({ pid: ids.readPid, justification: 'ทดสอบเหตุผลการค้นหา personId จาก pid' }),
      expectStatus: 200,
    },
    {
      name: 'getPerson',
      method: 'get',
      pathTemplate: '/persons/:personId',
      path: (ids) => `/persons/${ids.readPersonId}`,
      scope: 'personnel:read:basic',
      expectStatus: 200,
    },
    {
      name: 'getPersonPhoto',
      method: 'get',
      pathTemplate: '/persons/:personId/photo',
      path: (ids) => `/persons/${ids.readPersonId}/photo`,
      scope: 'personnel:read:photo',
      expectStatus: 200,
      binary: true,
    },
    {
      name: 'getPersonPid',
      method: 'get',
      pathTemplate: '/persons/:personId/pid',
      path: (ids) => `/persons/${ids.readPersonId}/pid`,
      query: { justification: 'ทดสอบเหตุผลการถอดรหัสเลขบัตร' },
      scope: 'personnel:read:pid',
      expectStatus: 200,
    },
    {
      name: 'getEmployment',
      method: 'get',
      pathTemplate: '/persons/:personId/employment',
      path: (ids) => `/persons/${ids.readPersonId}/employment`,
      scope: 'personnel:read:employment',
      expectStatus: 200,
    },
    {
      name: 'upsertEmployment',
      method: 'put',
      pathTemplate: '/persons/:personId/employment',
      path: (ids) => `/persons/${ids.upsertPersonId}/employment`,
      scope: 'personnel:write:employment',
      body: (ids) => ({
        employeeNo: `EMP-UPSERT-${crypto.randomUUID()}`,
        personnelType: 'CIVIL_SERVANT',
        positionId: ids.upsertNewPositionId,
        orgUnitId: ids.orgUnitId,
        effectiveFrom: FUTURE_EFFECTIVE_FROM,
      }),
      expectStatus: 200,
    },
    {
      name: 'deactivatePerson',
      method: 'post',
      pathTemplate: '/persons/:personId/deactivate',
      path: (ids) => `/persons/${ids.deactivatePersonId}/deactivate`,
      scope: 'personnel:read:basic personnel:write:employment',
      body: { employmentStatus: 'RESIGNED', separationDate: '2024-01-01' },
      expectStatus: 200,
    },
    {
      name: 'reactivatePerson',
      method: 'post',
      pathTemplate: '/persons/:personId/reactivate',
      path: (ids) => `/persons/${ids.reactivatePersonId}/reactivate`,
      scope: 'personnel:read:basic personnel:write:employment',
      body: (ids) => ({
        employeeNo: `EMP-REACT-${crypto.randomUUID()}`,
        personnelType: 'CIVIL_SERVANT',
        positionId: ids.reactivatePositionId,
        orgUnitId: ids.orgUnitId,
        effectiveFrom: FUTURE_EFFECTIVE_FROM,
      }),
      expectStatus: 200,
    },
    {
      name: 'requestReverify',
      method: 'post',
      pathTemplate: '/persons/:personId/reverify',
      path: (ids) => `/persons/${ids.readPersonId}/reverify`,
      scope: 'personnel:write:employment',
      body: { reason: 'ทดสอบ' },
      expectStatus: 202,
    },
    {
      name: 'getPersonChangeLog',
      method: 'get',
      pathTemplate: '/persons/:personId/change-log',
      path: (ids) => `/persons/${ids.readPersonId}/change-log`,
      scope: 'audit:read',
      expectStatus: 200,
    },
    {
      name: 'getMe',
      method: 'get',
      pathTemplate: '/me',
      path: () => '/me',
      scope: 'personnel:self',
      personId: (ids) => ids.readPersonId,
      expectStatus: 200,
    },
    {
      name: 'updateMyContact',
      method: 'put',
      pathTemplate: '/me/contact',
      path: () => '/me/contact',
      scope: 'personnel:self',
      personId: (ids) => ids.readPersonId,
      body: { mobilePhone: '0812345678' },
      expectStatus: 200,
    },
    {
      name: 'replaceMyEmergencyContacts',
      method: 'put',
      pathTemplate: '/me/emergency-contacts',
      path: () => '/me/emergency-contacts',
      scope: 'personnel:self',
      personId: (ids) => ids.readPersonId,
      body: [{ fullName: 'ทดสอบ ผู้ติดต่อ', relationship: 'เพื่อน', phone: '0899999999', priority: 1 }],
      expectStatus: 200,
    },
    {
      name: 'reportIdentityIssue',
      method: 'post',
      pathTemplate: '/me/report-identity-issue',
      path: () => '/me/report-identity-issue',
      scope: 'personnel:self',
      personId: (ids) => ids.readPersonId,
      body: { fieldKey: 'identity.reg_address_text', description: 'ที่อยู่ไม่ตรงกับความเป็นจริง' },
      expectStatus: 202,
    },
    {
      name: 'listMyConsents',
      method: 'get',
      pathTemplate: '/me/consents',
      path: () => '/me/consents',
      scope: 'personnel:self',
      personId: (ids) => ids.readPersonId,
      expectStatus: 200,
    },
    {
      name: 'setMyConsent',
      method: 'put',
      pathTemplate: '/me/consents/:purposeCode',
      path: () => '/me/consents/DIRECTORY_PUBLISH',
      scope: 'personnel:self',
      personId: (ids) => ids.readPersonId,
      body: { status: 'GRANTED', policyVersion: '2026-01-01' },
      expectStatus: 200,
    },
    {
      name: 'syncFromThaid',
      method: 'post',
      pathTemplate: '/sync/thaid',
      path: () => '/sync/thaid',
      scope: 'sync:thaid',
      // pid สุ่มใหม่นี้ไม่มี person ใน DB ตรงกับมันมาก่อน จึงตกไปที่ branch UNMATCHED (202) เสมอ
      body: () => ({
        claims: { pid: makeFakePid(), firstNameTh: 'ทดสอบ', lastNameTh: 'ระบบ' },
        context: { appId: 'eoffice', audience: 'PERSONNEL' },
      }),
      expectStatus: 202,
    },
    {
      name: 'importEmploymentBatch',
      method: 'post',
      pathTemplate: '/sync/hr/employment-batch',
      path: () => '/sync/hr/employment-batch',
      scope: 'personnel:import',
      body: { mode: 'DRY_RUN', rows: [] },
      expectStatus: 200,
    },
    {
      name: 'listClaimRequests',
      method: 'get',
      pathTemplate: '/claim-requests',
      path: () => '/claim-requests',
      scope: 'personnel:provision',
      expectStatus: 200,
    },
    {
      name: 'resolveClaimRequest',
      method: 'post',
      pathTemplate: '/claim-requests/:claimRequestId/resolve',
      path: (ids) => `/claim-requests/${ids.claimRequestId}/resolve`,
      scope: 'personnel:provision',
      body: { action: 'REJECT' },
      expectStatus: 200,
    },
    {
      name: 'listStalePersons',
      method: 'get',
      pathTemplate: '/reverify/stale',
      path: () => '/reverify/stale',
      scope: 'personnel:read:basic personnel:provision',
      expectStatus: 200,
    },
    { name: 'listEvents', method: 'get', pathTemplate: '/events', path: () => '/events', scope: 'events:read', expectStatus: 200 },
    {
      name: 'listWebhookSubscriptions',
      method: 'get',
      pathTemplate: '/webhooks/subscriptions',
      path: () => '/webhooks/subscriptions',
      scope: 'webhook:manage',
      expectStatus: 200,
    },
    {
      name: 'createWebhookSubscription',
      method: 'post',
      pathTemplate: '/webhooks/subscriptions',
      path: () => '/webhooks/subscriptions',
      scope: 'webhook:manage',
      body: { url: 'https://example.lp-pao.go.th/hooks/mdm', eventTypes: ['PERSON_DEACTIVATED'] },
      expectStatus: 201,
    },
    {
      name: 'deleteWebhookSubscription',
      method: 'delete',
      pathTemplate: '/webhooks/subscriptions/:subscriptionId',
      path: (ids) => `/webhooks/subscriptions/${ids.subscriptionForDeleteId}`,
      scope: 'webhook:manage',
      expectStatus: 204,
    },
    {
      name: 'testWebhookSubscription',
      method: 'post',
      pathTemplate: '/webhooks/subscriptions/:subscriptionId/test',
      path: (ids) => `/webhooks/subscriptions/${ids.subscriptionForTestId}/test`,
      scope: 'webhook:manage',
      expectStatus: 200,
    },
    {
      name: 'listWebhookDeliveries',
      method: 'get',
      pathTemplate: '/webhooks/deliveries',
      path: () => '/webhooks/deliveries',
      scope: 'webhook:manage',
      expectStatus: 200,
    },
    {
      name: 'retryWebhookDelivery',
      method: 'post',
      pathTemplate: '/webhooks/deliveries/:deliveryId/retry',
      path: (ids) => `/webhooks/deliveries/${ids.deadDeliveryId}/retry`,
      scope: 'webhook:manage',
      expectStatus: 202,
    },
    { name: 'listOrgUnits', method: 'get', pathTemplate: '/org-units', path: () => '/org-units', scope: 'personnel:read:basic', expectStatus: 200 },
    { name: 'listPositions', method: 'get', pathTemplate: '/positions', path: () => '/positions', scope: 'personnel:read:basic', expectStatus: 200 },
    {
      name: 'listAccessLogs',
      method: 'get',
      pathTemplate: '/audit/access-logs',
      path: () => '/audit/access-logs',
      scope: 'audit:read',
      expectStatus: 200,
    },
    { name: 'health', method: 'get', pathTemplate: '/health', path: () => '/health', noAuth: true, expectStatus: 200 },
  ];
}

module.exports = { buildOperationDescriptors, seedFixtures, CONSUMER_SYSTEM_CLIENT_ID };
