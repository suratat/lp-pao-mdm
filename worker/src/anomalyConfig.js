// ค่ากำหนดของ job access-anomaly-scan อ่านจาก env และ "ตรวจตอนบูต" - ค่าผิดรูปแบบ = โยน error ให้ worker ไม่เริ่ม (index.js: exit 1)
// ดีกว่าปล่อยให้ job ทำงานด้วยค่าที่เดาเอง (เช่น threshold เป็น NaN ทำให้ไม่มีวันแจ้งเตือน โดยไม่มีใครรู้)
//
// เวลาราชการ: จ.-ศ. [ANOMALY_OFFHOURS_END, ANOMALY_OFFHOURS_START) เวลา Asia/Bangkok = 08:30 (นับ) ถึงก่อน 16:30 (ไม่นับ)
// นอกช่วงนี้ รวมทั้งวันเสาร์-อาทิตย์ทั้งวัน ถือเป็น "นอกเวลาราชการ" (ยังไม่ยกเว้นวันหยุดราชการ)
const DEFAULTS = {
  ANOMALY_MONITORED_CLIENTS: 'hr-console',
  ANOMALY_BULK_VIEW_THRESHOLD: '30',
  ANOMALY_BULK_VIEW_WINDOW_MIN: '10',
  ANOMALY_PID_REVEAL_THRESHOLD: '5',
  ANOMALY_PID_REVEAL_WINDOW_MIN: '60',
  ANOMALY_OFFHOURS_START: '16:30',
  ANOMALY_OFFHOURS_END: '08:30',
  ANOMALY_SCAN_LOOKBACK_MIN: '30',
};

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_WINDOW_MIN = 24 * 60;

function raw(env, name) {
  const value = env[name];
  return value === undefined || value === null || String(value).trim() === '' ? DEFAULTS[name] : String(value).trim();
}

function intInRange(env, name, min, max) {
  const text = raw(env, name);
  if (!/^\d+$/.test(text)) throw new Error(`${name} ต้องเป็นจำนวนเต็มบวก (ได้ค่าที่ไม่ใช่ตัวเลข)`);
  const value = Number(text);
  if (value < min || value > max) throw new Error(`${name} ต้องอยู่ระหว่าง ${min} ถึง ${max} (ได้ ${value})`);
  return value;
}

function hhmm(env, name) {
  const text = raw(env, name);
  const match = HHMM_RE.exec(text);
  if (!match) throw new Error(`${name} ต้องเป็นเวลารูปแบบ HH:MM (00:00-23:59) (ได้ "${text}")`);
  return { text, minutes: Number(match[1]) * 60 + Number(match[2]) };
}

function loadAnomalyConfig(env = process.env) {
  const clients = raw(env, 'ANOMALY_MONITORED_CLIENTS')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (clients.length === 0) throw new Error('ANOMALY_MONITORED_CLIENTS ต้องมี client อย่างน้อย 1 ตัว');
  for (const client of clients) {
    if (!CLIENT_ID_RE.test(client)) throw new Error('ANOMALY_MONITORED_CLIENTS มี client id ที่รูปแบบไม่ถูกต้อง (ใช้ได้เฉพาะ A-Z a-z 0-9 . _ -)');
  }

  const start = hhmm(env, 'ANOMALY_OFFHOURS_START');
  const end = hhmm(env, 'ANOMALY_OFFHOURS_END');
  if (end.minutes >= start.minutes) {
    throw new Error(
      `ANOMALY_OFFHOURS_END (${end.text}, เริ่มเวลาราชการ) ต้องมาก่อน ANOMALY_OFFHOURS_START (${start.text}, สิ้นสุดเวลาราชการ)`
    );
  }

  const config = {
    monitoredClients: [...new Set(clients)],
    bulkView: {
      threshold: intInRange(env, 'ANOMALY_BULK_VIEW_THRESHOLD', 1, 100000),
      windowMin: intInRange(env, 'ANOMALY_BULK_VIEW_WINDOW_MIN', 1, MAX_WINDOW_MIN),
    },
    pidReveal: {
      threshold: intInRange(env, 'ANOMALY_PID_REVEAL_THRESHOLD', 1, 100000),
      windowMin: intInRange(env, 'ANOMALY_PID_REVEAL_WINDOW_MIN', 1, MAX_WINDOW_MIN),
    },
    offHours: { workStart: end.text, workEnd: start.text }, // เวลาราชการ [workStart, workEnd)
    // job รันทุก 5 นาที: ย้อนดูอย่างน้อย 10 นาทีเพื่อให้รอบที่พลาดไป (worker ล่ม/คิวช้า) ยังจับได้ - ซ้ำกับรอบก่อนไม่เป็นไรเพราะ dedupe_key
    offHoursLookbackMin: intInRange(env, 'ANOMALY_SCAN_LOOKBACK_MIN', 10, MAX_WINDOW_MIN),
  };

  config.telegram = loadTelegramConfig(env);
  return config;
}

// Telegram เป็น opt-in: ไม่ตั้งทั้งคู่ = ปิด; ตั้งไม่ครบ (มีแค่ตัวเดียว) = ผิดพลาดตอนบูต กันเข้าใจว่าเปิดแล้วทั้งที่ไม่ได้ส่ง
// token/chat id มาจาก env เท่านั้น (กฎข้อ 7) ห้ามพิมพ์ค่าลง log/error
function loadTelegramConfig(env) {
  const token = (env.DPO_TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.DPO_TELEGRAM_CHAT_ID || '').trim();
  if (!token && !chatId) return { enabled: false };
  if (!token || !chatId) throw new Error('ต้องตั้ง DPO_TELEGRAM_BOT_TOKEN และ DPO_TELEGRAM_CHAT_ID คู่กัน (ตั้งแค่ตัวเดียว) หรือไม่ตั้งทั้งคู่เพื่อปิด Telegram');
  if (/\s/.test(token)) throw new Error('DPO_TELEGRAM_BOT_TOKEN รูปแบบไม่ถูกต้อง (มีช่องว่าง)');
  if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(chatId)) {
    throw new Error('DPO_TELEGRAM_CHAT_ID ต้องเป็นตัวเลข (อาจขึ้นต้นด้วย -) หรือ @ชื่อช่อง');
  }

  const consoleBaseUrl = (env.DPO_CONSOLE_BASE_URL || '').trim();
  if (consoleBaseUrl) {
    let url;
    try {
      url = new URL(consoleBaseUrl);
    } catch {
      throw new Error('DPO_CONSOLE_BASE_URL ต้องเป็น URL (เช่น https://dpo.lp-pao.go.th)');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('DPO_CONSOLE_BASE_URL ต้องขึ้นต้นด้วย http:// หรือ https://');
  }
  return { enabled: true, botToken: token, chatId, consoleBaseUrl: consoleBaseUrl ? consoleBaseUrl.replace(/\/+$/, '') : null };
}

module.exports = { loadAnomalyConfig, DEFAULTS };
