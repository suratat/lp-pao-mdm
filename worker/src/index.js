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
const { runStgHrPurge } = require('./jobs/stgHrPurge');
const { runAccessLogPartitionEnsure } = require('./jobs/accessLogPartitionEnsure');
const { runAccessAnomalyScan } = require('./jobs/accessAnomalyScan');
const { loadAnomalyConfig } = require('./anomalyConfig');
const { createTelegramNotifier } = require('./services/telegramNotifier');

const OUTBOX_DISPATCH_QUEUE = 'outbox-dispatch';
const WEBHOOK_ATTEMPT_QUEUE = 'webhook-attempt';
const REVOKE_ACCESS_QUEUE = 'revoke-access';
const REVERIFY_SCAN_QUEUE = 'reverify-scan';
const REVERIFY_ESCALATE_QUEUE = 'reverify-escalate';
const STG_HR_PURGE_QUEUE = 'stg-hr-purge';
const ACCESS_LOG_PARTITION_ENSURE_QUEUE = 'access-log-partition-ensure';
const ACCESS_ANOMALY_SCAN_QUEUE = 'access-anomaly-scan';

// seq-01: "loop ทุก 5 วินาที หรือเมื่อมี NOTIFY" - ใช้ self-requeue ทุก 5 วินาทีแทน (ไม่ implement NOTIFY)
const POLL_INTERVAL_SECONDS = 5;

async function main() {
  // ตรวจ env ของ access-anomaly-scan ก่อนทำอย่างอื่น: ค่าผิด = ไม่เริ่ม worker (ไม่ปล่อยให้ job ทำงานด้วยค่าที่เดาเอง)
  const anomalyConfig = loadAnomalyConfig(process.env);

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
  await boss.createQueue(STG_HR_PURGE_QUEUE);
  await boss.createQueue(ACCESS_LOG_PARTITION_ENSURE_QUEUE);
  await boss.createQueue(ACCESS_ANOMALY_SCAN_QUEUE);

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

  // T8 §5.4: purge plaintext pid ใน stg_hr ที่อายุเกิน STG_HR_PID_RETENTION_DAYS (ค่าเริ่มต้น 30 วัน)
  await boss.work(STG_HR_PURGE_QUEUE, async () => {
    await runStgHrPurge({ pool });
  });

  // §1.6 R29: audit.access_log แบ่ง partition รายเดือน - สร้างเดือนปัจจุบัน + 3 เดือนล่วงหน้าทุกวัน (เรียกซ้ำได้)
  await boss.work(ACCESS_LOG_PARTITION_ENSURE_QUEUE, async () => {
    await runAccessLogPartitionEnsure({ pool });
  });

  // PR-C (DPO): ตรวจพฤติกรรมการเข้าถึงข้อมูลผิดปกติทุก 5 นาที -> audit.access_alert (+ Telegram ถ้าตั้ง DPO_TELEGRAM_* ครบ)
  const telegram = anomalyConfig.telegram.enabled
    ? createTelegramNotifier({
        botToken: anomalyConfig.telegram.botToken,
        chatId: anomalyConfig.telegram.chatId,
        consoleBaseUrl: anomalyConfig.telegram.consoleBaseUrl,
      })
    : null;
  await boss.work(ACCESS_ANOMALY_SCAN_QUEUE, async () => {
    await runAccessAnomalyScan({ pool, config: anomalyConfig, notifier: telegram });
  });

  // seq-02: "ทุกวัน 02:00" - escalate รันตามหลัง scan (ไม่มีเวลาระบุชัดในเอกสาร เลือก 02:30)
  await boss.schedule(REVERIFY_SCAN_QUEUE, '0 2 * * *', {});
  await boss.schedule(REVERIFY_ESCALATE_QUEUE, '30 2 * * *', {});
  await boss.schedule(STG_HR_PURGE_QUEUE, '0 3 * * *', {});
  await boss.schedule(ACCESS_LOG_PARTITION_ENSURE_QUEUE, '15 3 * * *', {});
  await boss.schedule(ACCESS_ANOMALY_SCAN_QUEUE, '*/5 * * * *', {});

  await boss.send(OUTBOX_DISPATCH_QUEUE, {});
  await boss.send(WEBHOOK_ATTEMPT_QUEUE, {});
  await boss.send(REVOKE_ACCESS_QUEUE, {});

  // eslint-disable-next-line no-console
  console.log(
    `MDM Worker เริ่มทำงานแล้ว (access-anomaly-scan: เฝ้า client ${anomalyConfig.monitoredClients.join(',')}, Telegram ${telegram ? 'เปิด' : 'ปิด'})`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('เริ่ม worker ไม่สำเร็จ', err);
  process.exit(1);
});
