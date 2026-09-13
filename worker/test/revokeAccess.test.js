const { createPools } = require('./pools');
const { runRevokeAccess } = require('../src/jobs/revokeAccess');
const { createFakeCheckClient } = require('../src/services/checkClient');
const { createFakeKeycloakClient } = require('../src/services/keycloakClient');
const { insertActivePerson } = require('./fixtures');

let adminPool;
let pool;

beforeAll(() => {
  ({ adminPool, workerPool: pool } = createPools());
});

afterAll(async () => {
  await adminPool.end();
  await pool.end();
});

async function insertDeactivatedEvent(personId) {
  const { rows } = await adminPool.query(
    `INSERT INTO integration.outbox_event (person_id, event_type, changed_fields, payload, version)
     VALUES ($1, 'PERSON_DEACTIVATED', '[]'::jsonb, $2, 1) RETURNING event_id`,
    [personId, JSON.stringify({ personId, version: 1, status: 'INACTIVE', verificationStatus: 'VERIFIED' })]
  );
  return rows[0].event_id;
}

describe('revoke-access (§3.4 deactivate -> revoke)', () => {
  test('เรียก check.revokeSessions เสมอ และ Keycloak เฉพาะเมื่อมี external_identifier(KEYCLOAK)', async () => {
    const personId = await insertActivePerson(adminPool);
    await insertDeactivatedEvent(personId);

    const checkClient = createFakeCheckClient();
    const keycloakClient = createFakeKeycloakClient();

    const result = await runRevokeAccess({ pool, checkClient, keycloakClient });

    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(checkClient.calls.some((c) => c.personId === personId)).toBe(true);
    expect(keycloakClient.calls).toHaveLength(0); // บุคลากรทั่วไปไม่มีบัญชี Keycloak
  });

  test('เรียก Keycloak ด้วยเมื่อพบ external_identifier(KEYCLOAK)', async () => {
    const personId = await insertActivePerson(adminPool);
    await adminPool.query(
      `INSERT INTO mdm.external_identifier (person_id, system_code, external_value) VALUES ($1, 'KEYCLOAK', $2)`,
      [personId, 'kc-user-123']
    );
    await insertDeactivatedEvent(personId);

    const keycloakClient = createFakeKeycloakClient();
    await runRevokeAccess({ pool, checkClient: createFakeCheckClient(), keycloakClient });

    expect(keycloakClient.calls).toEqual([{ keycloakUserId: 'kc-user-123', at: expect.any(Date) }]);
  });

  test('idempotent: รันซ้ำไม่เรียก revoke ซ้ำสำหรับ event เดิม', async () => {
    const personId = await insertActivePerson(adminPool);
    await insertDeactivatedEvent(personId);

    const checkClient = createFakeCheckClient();
    await runRevokeAccess({ pool, checkClient, keycloakClient: createFakeKeycloakClient() });
    await runRevokeAccess({ pool, checkClient, keycloakClient: createFakeKeycloakClient() });

    expect(checkClient.calls.filter((c) => c.personId === personId)).toHaveLength(1);
  });

  test('check.lp-pao.go.th ล้มเหลว (best-effort) -> ยัง mark revoke_processed_at ไม่ rollback', async () => {
    const personId = await insertActivePerson(adminPool);
    const eventId = await insertDeactivatedEvent(personId);

    const failingCheckClient = {
      calls: [],
      async revokeSessions() {
        throw new Error('unreachable');
      },
    };
    await runRevokeAccess({ pool, checkClient: failingCheckClient, keycloakClient: createFakeKeycloakClient() });

    const { rows } = await adminPool.query(
      `SELECT revoke_processed_at FROM integration.outbox_event WHERE event_id = $1`,
      [eventId]
    );
    expect(rows[0].revoke_processed_at).not.toBeNull();
  });
});
