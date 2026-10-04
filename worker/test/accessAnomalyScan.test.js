const crypto = require('node:crypto');
const { createPools } = require('./pools');
const { runAccessAnomalyScan, RULE_SQL } = require('../src/jobs/accessAnomalyScan');
const { loadAnomalyConfig } = require('../src/anomalyConfig');

// job access-anomaly-scan รันด้วย connection ของ mdm_worker จริง (workerPool) เพื่อพิสูจน์ว่าทำงานได้ภายใต้สิทธิ์ของ worker เท่านั้น
// เวลาทั้งหมดอ้างอิง asOf คงที่ในเดือน 2032-03 (สร้าง partition เฉพาะของเทสต์นี้ แล้วลบทิ้งตอนจบ) - วันที่/เวลาไทยที่ใช้:
//   2032-03-01 จันทร์, 03-02 อังคาร, 03-03 พุธ, 03-05 ศุกร์, 03-06 เสาร์, 03-07 อาทิตย์ (เวลาไทย = UTC+7)

let adminPool;
let pool;
let personIds;

const config = (overrides = {}) => loadAnomalyConfig({ ...overrides });
const uniqueActor = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const bkk = (isoLocal) => new Date(`${isoLocal}+07:00`); // เวลาไทย -> instant
// asOf กลางเวลาราชการวันอังคาร 12:00 น. (ไทย): แถวที่ใส่ในหน้าต่างก่อนหน้านี้ไม่ถือเป็นนอกเวลา
const ASOF = bkk('2032-03-02T12:00:00');
const minutesBefore = (date, m) => new Date(date.getTime() - m * 60_000);

beforeAll(async () => {
  ({ adminPool, workerPool: pool } = createPools());
  await adminPool.query(`SELECT audit.ensure_access_log_partition('2032-03-01')`);
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.person (pid_hash, status, verification_status)
     SELECT md5(random()::text || g::text) || md5(random()::text || g::text), 'ACTIVE', 'VERIFIED' FROM generate_series(1, 60) g
     RETURNING person_id`
  );
  personIds = rows.map((r) => r.person_id);
});

afterAll(async () => {
  await adminPool.query('DROP TABLE IF EXISTS audit.access_log_2032_03');
  await adminPool.end();
  await pool.end();
});

async function insertAccess({ accessedAt, actor, client = 'hr-console', endpoint, personId, method = 'GET', status = 200 }) {
  await adminPool.query(
    `INSERT INTO audit.access_log
       (accessed_at, subject_person_id, actor_type, actor_sub, keycloak_client_id, endpoint, http_method, fields_returned, request_id, response_status)
     VALUES ($1, $2, 'SERVICE', $3, $4, $5, $6, '["basic.firstNameTh"]', gen_random_uuid()::text, $7)`,
    [accessedAt, personId, actor, client, endpoint, method, status]
  );
}

const detail = (personId) => `/api/v1/persons/${personId}`;
const revealEndpoint = (personId) => `/api/v1/persons/${personId}/pid`;

async function alertsFor(actor) {
  const { rows } = await adminPool.query(`SELECT * FROM audit.access_alert WHERE actor_sub = $1 ORDER BY alert_id`, [actor]);
  return rows;
}

const scan = (cfg, opts = {}) => runAccessAnomalyScan({ pool, config: cfg, asOf: ASOF, logger: { log: jest.fn(), error: jest.fn() }, ...opts });

describe('BULK_VIEW: เปิดดูบุคคลรายคนหลายคนในเวลาสั้น', () => {
  test('30 คนในหน้าต่าง 10 นาที -> alert; 29 คน -> ไม่มี (เกณฑ์ = พอดี)', async () => {
    const at30 = uniqueActor('bulk30');
    const at29 = uniqueActor('bulk29');
    for (const id of personIds.slice(0, 30)) await insertAccess({ accessedAt: minutesBefore(ASOF, 5), actor: at30, endpoint: detail(id), personId: id });
    for (const id of personIds.slice(0, 29)) await insertAccess({ accessedAt: minutesBefore(ASOF, 5), actor: at29, endpoint: detail(id), personId: id });

    const result = await scan(config());
    expect(result.byRule.BULK_VIEW).toBeGreaterThanOrEqual(1);

    const [alert] = await alertsFor(at30);
    expect(alert).toMatchObject({
      rule_code: 'BULK_VIEW',
      severity: 'HIGH',
      actor_client: 'hr-console',
      metric_count: 30,
      threshold: 30,
    });
    expect(new Date(alert.window_end).getTime()).toBe(ASOF.getTime());
    expect(new Date(alert.window_start).getTime()).toBe(minutesBefore(ASOF, 10).getTime());
    expect(await alertsFor(at29)).toEqual([]);
  });

  test('details ไม่มี personId ของผู้ถูกเข้าถึง และไม่มี pid (เก็บแค่ตัวเลข/พารามิเตอร์ของกฎ)', async () => {
    const actor = uniqueActor('bulk-details');
    for (const id of personIds.slice(0, 30)) await insertAccess({ accessedAt: minutesBefore(ASOF, 3), actor, endpoint: detail(id), personId: id });
    await scan(config());
    const [alert] = await alertsFor(actor);
    expect(alert.details).toEqual({ distinctPersons: 30, windowMinutes: 10 });
    const text = JSON.stringify(alert);
    for (const id of personIds.slice(0, 30)) expect(text).not.toContain(id);
  });

  test('คนเดียวดูซ้ำ 40 ครั้ง (DISTINCT = 1) -> ไม่มี alert', async () => {
    const actor = uniqueActor('bulk-same');
    for (let i = 0; i < 40; i += 1) await insertAccess({ accessedAt: minutesBefore(ASOF, 2), actor, endpoint: detail(personIds[0]), personId: personIds[0] });
    await scan(config());
    expect(await alertsFor(actor)).toEqual([]);
  });

  test('ไม่นับแถวของ searchPersons (endpoint /persons?... เขียนแถวละคนต่อผลค้นหา) แม้มี 50 คน', async () => {
    const actor = uniqueActor('bulk-search');
    for (const id of personIds.slice(0, 50)) {
      await insertAccess({ accessedAt: minutesBefore(ASOF, 2), actor, endpoint: '/api/v1/persons?q=%E0%B8%AA%E0%B8%A1&limit=100', personId: id });
    }
    await scan(config());
    expect(await alertsFor(actor)).toEqual([]);
  });

  test('ขอบหน้าต่าง: แถวที่เกิดเมื่อ asOf-10 นาทีพอดี และแถวเก่ากว่า ไม่นับ; response >= 400 ไม่นับ', async () => {
    const actor = uniqueActor('bulk-edge');
    const ids = personIds.slice(0, 30);
    for (const id of ids.slice(0, 27)) await insertAccess({ accessedAt: minutesBefore(ASOF, 9), actor, endpoint: detail(id), personId: id });
    await insertAccess({ accessedAt: minutesBefore(ASOF, 10), actor, endpoint: detail(ids[27]), personId: ids[27] }); // ขอบ: ไม่นับ
    await insertAccess({ accessedAt: minutesBefore(ASOF, 11), actor, endpoint: detail(ids[28]), personId: ids[28] }); // เก่ากว่า: ไม่นับ
    await insertAccess({ accessedAt: minutesBefore(ASOF, 1), actor, endpoint: detail(ids[29]), personId: ids[29], status: 403 }); // ไม่สำเร็จ: ไม่นับ
    await scan(config());
    expect(await alertsFor(actor)).toEqual([]);
  });

  test('client ที่ไม่อยู่ใน ANOMALY_MONITORED_CLIENTS ไม่ถูกตรวจ แต่เพิ่มเข้า env แล้วถูกตรวจ', async () => {
    const actor = uniqueActor('bulk-client');
    for (const id of personIds.slice(0, 30)) {
      await insertAccess({ accessedAt: minutesBefore(ASOF, 4), actor, client: 'check-broker', endpoint: detail(id), personId: id });
    }
    await scan(config());
    expect(await alertsFor(actor)).toEqual([]);

    await scan(config({ ANOMALY_MONITORED_CLIENTS: 'hr-console, check-broker' }));
    expect((await alertsFor(actor)).map((a) => a.actor_client)).toEqual(['check-broker']);
  });

  test('ค่า threshold/window จาก env: 5 คนใน 2 นาที', async () => {
    const actor = uniqueActor('bulk-env');
    for (const id of personIds.slice(0, 5)) await insertAccess({ accessedAt: minutesBefore(ASOF, 1), actor, endpoint: detail(id), personId: id });
    await scan(config({ ANOMALY_BULK_VIEW_THRESHOLD: '5', ANOMALY_BULK_VIEW_WINDOW_MIN: '2' }));
    const [alert] = await alertsFor(actor);
    expect(alert).toMatchObject({ metric_count: 5, threshold: 5 });
    expect(alert.details.windowMinutes).toBe(2);
  });

  test('กันซ้ำ: รันซ้ำและรันต่างเวลาในหน้าต่าง bucket เดียวกัน -> alert เดียว และไม่คืนเป็น "ใหม่" ซ้ำ', async () => {
    const actor = uniqueActor('bulk-dedupe');
    // asOf ชิดต้น bucket 10 นาที (12:00 พอดี) แล้วรันอีกที 4 นาทีถัดมา (ยังอยู่ bucket เดียวกัน)
    for (const id of personIds.slice(0, 30)) await insertAccess({ accessedAt: minutesBefore(ASOF, 1), actor, endpoint: detail(id), personId: id });
    const first = await scan(config());
    const second = await scan(config());
    const later = await scan(config(), { asOf: new Date(ASOF.getTime() + 4 * 60_000) });
    expect(first.alerts.filter((a) => a.actor_sub === actor)).toHaveLength(1);
    expect(second.alerts.filter((a) => a.actor_sub === actor)).toHaveLength(0);
    expect(later.alerts.filter((a) => a.actor_sub === actor)).toHaveLength(0);
    expect(await alertsFor(actor)).toHaveLength(1);
  });
});

describe('PID_REVEAL_FREQUENT: เปิดเลขบัตรบ่อย', () => {
  test('5 ครั้งใน 60 นาที -> alert; 4 ครั้ง -> ไม่มี; นับแถวเก่าที่ endpoint มี ?justification= ด้วย; ไม่นับ non-200 และ endpoint อื่น', async () => {
    const five = uniqueActor('pid5');
    const four = uniqueActor('pid4');
    for (let i = 0; i < 4; i += 1) await insertAccess({ accessedAt: minutesBefore(ASOF, 30 + i), actor: four, endpoint: revealEndpoint(personIds[i]), personId: personIds[i] });
    for (let i = 0; i < 4; i += 1) await insertAccess({ accessedAt: minutesBefore(ASOF, 30 + i), actor: five, endpoint: revealEndpoint(personIds[i]), personId: personIds[i] });
    // ตัวที่ 5 ของ `five` เป็นรูปแบบเก่า (query string ต่อท้าย)
    await insertAccess({ accessedAt: minutesBefore(ASOF, 20), actor: five, endpoint: `${revealEndpoint(personIds[4])}?justification=x`, personId: personIds[4] });
    // ไม่นับ: ไม่สำเร็จ / ไม่ใช่ GET / endpoint อื่น
    await insertAccess({ accessedAt: minutesBefore(ASOF, 10), actor: four, endpoint: revealEndpoint(personIds[5]), personId: personIds[5], status: 403 });
    await insertAccess({ accessedAt: minutesBefore(ASOF, 10), actor: four, endpoint: revealEndpoint(personIds[6]), personId: personIds[6], method: 'POST' });
    await insertAccess({ accessedAt: minutesBefore(ASOF, 10), actor: four, endpoint: detail(personIds[7]), personId: personIds[7] });

    await scan(config());
    const [alert] = await alertsFor(five);
    expect(alert).toMatchObject({ rule_code: 'PID_REVEAL_FREQUENT', severity: 'HIGH', metric_count: 5, threshold: 5 });
    expect(alert.details).toEqual({ reveals: 5, windowMinutes: 60 });
    expect(await alertsFor(four)).toEqual([]);
  });

  test('ขอบหน้าต่าง 60 นาที: ครั้งที่เกิดเมื่อ asOf-60 นาทีพอดีไม่นับ', async () => {
    const actor = uniqueActor('pid-edge');
    for (let i = 0; i < 4; i += 1) await insertAccess({ accessedAt: minutesBefore(ASOF, 59), actor, endpoint: revealEndpoint(personIds[i]), personId: personIds[i] });
    await insertAccess({ accessedAt: minutesBefore(ASOF, 60), actor, endpoint: revealEndpoint(personIds[4]), personId: personIds[4] });
    await scan(config());
    expect(await alertsFor(actor)).toEqual([]);
  });
});

describe('OFF_HOURS: นอกเวลาราชการ (จ.-ศ. 08:30-16:30 เวลาไทย)', () => {
  // asOf = หลังแถว 1 นาที (หน้าต่างย้อนหลังเริ่มต้น 30 นาที) แล้วดูว่าแถวนั้นสร้าง alert หรือไม่
  async function offHoursAlertFor(localTime, { actor = uniqueActor('off'), client = 'hr-console' } = {}) {
    const at = bkk(localTime);
    await insertAccess({ accessedAt: at, actor, client, endpoint: detail(personIds[0]), personId: personIds[0] });
    await scan(config({ ANOMALY_MONITORED_CLIENTS: 'hr-console,check-broker' }), { asOf: new Date(at.getTime() + 60_000) });
    return alertsFor(actor);
  }

  test.each([
    ['08:29:59 วันอังคาร (ก่อนเริ่มเวลาราชการ 1 วินาที) -> alert', '2032-03-02T08:29:59', true],
    ['08:30:00 วันอังคาร (เริ่มเวลาราชการ) -> ไม่มี alert', '2032-03-02T08:30:00', false],
    ['16:29:59 วันอังคาร (ก่อนเลิกงาน 1 วินาที) -> ไม่มี alert', '2032-03-02T16:29:59', false],
    ['16:30:00 วันอังคาร (เลิกงาน) -> alert', '2032-03-02T16:30:00', true],
    ['12:00 วันศุกร์ (ในเวลา) -> ไม่มี alert', '2032-03-05T12:00:00', false],
    ['12:00 วันเสาร์ (หยุดทั้งวัน) -> alert', '2032-03-06T12:00:00', true],
    ['10:00 วันอาทิตย์ (หยุดทั้งวัน) -> alert', '2032-03-07T10:00:00', true],
    ['00:05 วันจันทร์ (หลังเที่ยงคืน) -> alert', '2032-03-01T00:05:00', true],
  ])('%s', async (_label, localTime, expectAlert) => {
    const alerts = await offHoursAlertFor(localTime);
    expect(alerts).toHaveLength(expectAlert ? 1 : 0);
    if (expectAlert) {
      expect(alerts[0]).toMatchObject({ rule_code: 'OFF_HOURS', severity: 'MEDIUM', metric_count: 1, threshold: 1, actor_client: 'hr-console' });
      expect(alerts[0].details).toMatchObject({ timezone: 'Asia/Bangkok', workStart: '08:30', workEnd: '16:30' });
    }
  });

  test('วันที่ของ alert ใช้ "วันตามเวลาไทย": 18:30Z วันอังคารคือ 01:30 วันพุธตามเวลาไทย', async () => {
    const actor = uniqueActor('off-date');
    const at = new Date('2032-03-02T18:30:00Z');
    await insertAccess({ accessedAt: at, actor, endpoint: detail(personIds[0]), personId: personIds[0] });
    await scan(config(), { asOf: new Date(at.getTime() + 60_000) });
    const [alert] = await alertsFor(actor);
    expect(alert.details.localDate).toBe('2032-03-03');
    expect(alert.dedupe_key.endsWith(':2032-03-03')).toBe(true);
  });

  test('1 alert ต่อ actor ต่อวัน: หลายครั้ง/หลายรอบในวันเดียวกัน = 1 alert; คนละวัน = 2 alert', async () => {
    const actor = uniqueActor('off-dedupe');
    const t1 = bkk('2032-03-02T18:00:00');
    const t2 = bkk('2032-03-02T19:00:00');
    const t3 = bkk('2032-03-03T18:00:00');
    for (const t of [t1, t2, t3]) await insertAccess({ accessedAt: t, actor, endpoint: detail(personIds[0]), personId: personIds[0] });
    for (const t of [t1, t2, t3]) await scan(config(), { asOf: new Date(t.getTime() + 60_000) });
    await scan(config(), { asOf: new Date(t1.getTime() + 60_000) }); // รันซ้ำ
    const alerts = await alertsFor(actor);
    expect(alerts.map((a) => a.details.localDate)).toEqual(['2032-03-02', '2032-03-03']);
  });

  test('client นอกรายการที่เฝ้าไม่ถูกตรวจ', async () => {
    const actor = uniqueActor('off-client');
    const at = bkk('2032-03-02T20:00:00');
    await insertAccess({ accessedAt: at, actor, client: 'check-broker', endpoint: detail(personIds[0]), personId: personIds[0] });
    await scan(config(), { asOf: new Date(at.getTime() + 60_000) });
    expect(await alertsFor(actor)).toEqual([]);
  });

  test('เวลาราชการตั้งจาก env ได้ (09:00-15:00): 15:10 เป็นนอกเวลา', async () => {
    const actor = uniqueActor('off-env');
    const at = bkk('2032-03-02T15:10:00');
    await insertAccess({ accessedAt: at, actor, endpoint: detail(personIds[0]), personId: personIds[0] });
    await scan(config({ ANOMALY_OFFHOURS_START: '15:00', ANOMALY_OFFHOURS_END: '09:00' }), { asOf: new Date(at.getTime() + 60_000) });
    expect(await alertsFor(actor)).toHaveLength(1);
  });
});

describe('การแจ้งเตือน (notifier) และสิทธิ์', () => {
  test('notifier ถูกเรียกเฉพาะ alert ที่สร้างใหม่ในรอบนั้น ไม่เรียกซ้ำเมื่อรันซ้ำ', async () => {
    const actor = uniqueActor('notify');
    for (const id of personIds.slice(0, 30)) await insertAccess({ accessedAt: minutesBefore(ASOF, 2), actor, endpoint: detail(id), personId: id });
    const notifier = { notify: jest.fn().mockResolvedValue({ ok: true }) };

    await scan(config(), { notifier });
    const mine = notifier.notify.mock.calls.map(([a]) => a).filter((a) => a.actor_sub === actor);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ rule_code: 'BULK_VIEW', metric_count: 30 });

    notifier.notify.mockClear();
    await scan(config(), { notifier });
    expect(notifier.notify.mock.calls.filter(([a]) => a.actor_sub === actor)).toHaveLength(0);
  });

  test('notifier ล้มเหลว (throw) ไม่ทำให้ job ล้ม และ alert ยังถูกบันทึก', async () => {
    const actor = uniqueActor('notify-fail');
    for (const id of personIds.slice(0, 30)) await insertAccess({ accessedAt: minutesBefore(ASOF, 2), actor, endpoint: detail(id), personId: id });
    const logger = { log: jest.fn(), error: jest.fn() };
    const notifier = { notify: jest.fn().mockRejectedValue(new Error('https://api.telegram.org/bot123:SECRET/sendMessage')) };
    await expect(runAccessAnomalyScan({ pool, config: config(), notifier, asOf: ASOF, logger })).resolves.toBeDefined();
    expect(await alertsFor(actor)).toHaveLength(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET');
  });

  test('worker (mdm_worker) UPDATE/DELETE audit.access_alert ไม่ได้ และเขียน access_alert_action ไม่ได้', async () => {
    await expect(pool.query(`UPDATE audit.access_alert SET severity = 'LOW'`)).rejects.toThrow(/permission denied/);
    await expect(pool.query(`DELETE FROM audit.access_alert`)).rejects.toThrow(/permission denied/);
    await expect(pool.query(`INSERT INTO audit.access_alert_action (alert_id, action, actor_sub) VALUES (1, 'ACK', 'x')`)).rejects.toThrow(/permission denied/);
  });
});

describe('ทุก query มี predicate ช่วง accessed_at และกรองเฉพาะ client ที่เฝ้า', () => {
  test.each(Object.entries(RULE_SQL))('%s', (_name, sql) => {
    expect(sql).toMatch(/al\.accessed_at\s*>\s*\$1::timestamptz\s*-\s*make_interval/);
    expect(sql).toMatch(/al\.accessed_at\s*<=\s*\$1::timestamptz/);
    expect(sql).toMatch(/keycloak_client_id\s*=\s*ANY\(/);
    expect(sql).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
  });

  test('partition pruning ทำงานจริง: หน้าต่างในเดือน 2032-03 สแกนเฉพาะ partition เดือนนั้น', async () => {
    const { rows } = await pool.query(`EXPLAIN (COSTS OFF) ${RULE_SQL.PID_REVEAL_SQL}`, [ASOF, 60, 5, ['hr-console']]);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain('access_log_2032_03');
    expect(plan).not.toMatch(/access_log_(?!2032_03)\d{4}_\d{2}/);
    expect(plan).not.toContain('access_log_default');
  });
});
