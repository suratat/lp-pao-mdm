const { getPool } = require('./db/pool');
const { createBoss } = require('./boss');
const { createVaultHttpClient } = require('./security/vault');
const { createCheckHttpClient } = require('./services/checkClient');
const { createKeycloakHttpClient } = require('./services/keycloakClient');
const { runOutboxDispatch } = require('./jobs/outboxDispatch');
const { runWebhookAttempt } = require('./jobs/webhookAttempt');
const { runReverifyScan } = require('./jobs/reverifyScan');
const { runReverifyEscalate } = require('./jobs/reverifyEscalate');
const { runRevokeAccess } = require('./jobs/revokeAccess');

const OUTBOX_DISPATCH_QUEUE = 'outbox-dispatch';
const WEBHOOK_ATTEMPT_QUEUE = 'webhook-attempt';
const REVOKE_ACCESS_QUEUE = 'revoke-access';
const REVERIFY_SCAN_QUEUE = 'reverify-scan';
const REVERIFY_ESCALATE_QUEUE = 'reverify-escalate';

// seq-01: "loop ทุก 5 วินาที หรือเมื่อมี NOTIFY" - ใช้ self-requeue ทุก 5 วินาทีแทน (ไม่ implement NOTIFY)
const POLL_INTERVAL_SECONDS = 5;

async function main() {
  const pool = getPool();
  const boss = await createBoss(process.env.DATABASE_URL);

  const vault = createVaultHttpClient({ addr: process.env.VAULT_ADDR, token: process.env.VAULT_TOKEN });
  const checkClient = createCheckHttpClient({
    baseUrl: process.env.CHECK_BASE_URL,
    sharedSecret: process.env.CHECK_SHARED_SECRET,
  });
  const keycloakClient = createKeycloakHttpClient({
    baseUrl: process.env.KEYCLOAK_BASE_URL,
    realm: process.env.KEYCLOAK_REALM,
    clientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID,
    clientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET,
  });

  await boss.createQueue(OUTBOX_DISPATCH_QUEUE);
  await boss.createQueue(WEBHOOK_ATTEMPT_QUEUE);
  await boss.createQueue(REVOKE_ACCESS_QUEUE);
  await boss.createQueue(REVERIFY_SCAN_QUEUE);
  await boss.createQueue(REVERIFY_ESCALATE_QUEUE);

  await boss.work(OUTBOX_DISPATCH_QUEUE, async () => {
    await runOutboxDispatch({ pool });
    await boss.sendAfter(OUTBOX_DISPATCH_QUEUE, {}, {}, POLL_INTERVAL_SECONDS);
  });

  await boss.work(WEBHOOK_ATTEMPT_QUEUE, async () => {
    await runWebhookAttempt({ pool, vault });
    await boss.sendAfter(WEBHOOK_ATTEMPT_QUEUE, {}, {}, POLL_INTERVAL_SECONDS);
  });

  // T5: §3.4 deactivate -> revoke (แยกจาก webhook fan-out ของ T4)
  await boss.work(REVOKE_ACCESS_QUEUE, async () => {
    await runRevokeAccess({ pool, checkClient, keycloakClient });
    await boss.sendAfter(REVOKE_ACCESS_QUEUE, {}, {}, POLL_INTERVAL_SECONDS);
  });

  await boss.work(REVERIFY_SCAN_QUEUE, async () => {
    await runReverifyScan({ pool, checkClient });
  });

  await boss.work(REVERIFY_ESCALATE_QUEUE, async () => {
    await runReverifyEscalate({ pool });
  });

  // seq-02: "ทุกวัน 02:00" - escalate รันตามหลัง scan (ไม่มีเวลาระบุชัดในเอกสาร เลือก 02:30)
  await boss.schedule(REVERIFY_SCAN_QUEUE, '0 2 * * *', {});
  await boss.schedule(REVERIFY_ESCALATE_QUEUE, '30 2 * * *', {});

  await boss.send(OUTBOX_DISPATCH_QUEUE, {});
  await boss.send(WEBHOOK_ATTEMPT_QUEUE, {});
  await boss.send(REVOKE_ACCESS_QUEUE, {});

  // eslint-disable-next-line no-console
  console.log('MDM Worker เริ่มทำงานแล้ว');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('เริ่ม worker ไม่สำเร็จ', err);
  process.exit(1);
});
