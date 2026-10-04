// ส่ง alert ใหม่ไป Telegram (opt-in: DPO_TELEGRAM_BOT_TOKEN + DPO_TELEGRAM_CHAT_ID - bot/chat แยกจากระบบ monitor โครงสร้างพื้นฐาน)
// ใช้ fetch ที่มากับ Node 22 (ไม่เพิ่ม dependency)
//
// ข้อความประกอบจากฟิลด์ตายตัวเท่านั้น: กฎ, ความรุนแรง, จำนวน/เกณฑ์, ช่วงเวลา, actor_sub (UUID ของบัญชี ไม่ใช่ชื่อ) และ client - ไม่มี pid, ไม่มีชื่อ
// หรือ personId ของผู้ถูกเข้าถึง (ตัวแปรเหล่านั้นไม่เคยถูกอ่านเข้ามาในฟังก์ชันนี้) และกรองเลข 13 หลักซ้ำอีกชั้นก่อนส่ง
// error จากเครือข่าย "ไม่" ถูกส่งต่อ/พิมพ์ทั้งก้อน: URL ของ Bot API มี token อยู่ในพาธ (กฎข้อ 7 ห้ามพิมพ์ secret ลง log)
const RULE_LABEL_TH = {
  BULK_VIEW: 'เปิดดูข้อมูลบุคคลจำนวนมากในเวลาสั้น',
  OFF_HOURS: 'เข้าถึงข้อมูลนอกเวลาราชการ',
  PID_REVEAL_FREQUENT: 'เปิดเลขบัตรประชาชนบ่อยผิดปกติ',
};
const SEVERITY_TH = { HIGH: 'สูง', MEDIUM: 'กลาง', LOW: 'ต่ำ' };
const PID_LIKE = /\d(?:[ -]?\d){12}/g;
const SEND_TIMEOUT_MS = 10_000;

function formatBangkok(date) {
  return new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date(date));
}

function buildMessage(alert, consoleBaseUrl) {
  const lines = [
    `⚠️ แจ้งเตือนการเข้าถึงข้อมูลผิดปกติ #${alert.alert_id}`,
    `กฎ: ${RULE_LABEL_TH[alert.rule_code] || alert.rule_code}`,
    `ความรุนแรง: ${SEVERITY_TH[alert.severity] || alert.severity}`,
    `จำนวน: ${alert.metric_count} (เกณฑ์ ${alert.threshold})`,
    `ช่วงเวลา: ${formatBangkok(alert.window_start)} - ${formatBangkok(alert.window_end)} (เวลาไทย)`,
    `บัญชี: ${alert.actor_sub || '-'}`,
    `ระบบ: ${alert.actor_client || '-'}`,
  ];
  if (consoleBaseUrl) lines.push(`ตรวจสอบ: ${consoleBaseUrl}/dpo/alerts`);
  return lines.join('\n').replace(PID_LIKE, '[ปกปิด]');
}

// apiBaseUrl: ไว้ให้เทสต์ชี้ไป mock server (production ใช้ค่าเริ่มต้น)
function createTelegramNotifier({ botToken, chatId, consoleBaseUrl = null, fetchImpl = fetch, apiBaseUrl = 'https://api.telegram.org', logger = console }) {
  return {
    // ไม่ throw เด็ดขาด: การแจ้งเตือนล้มเหลวต้องไม่ทำให้ job ล้ม (alert ถูกบันทึกลง DB แล้ว และ DPO เห็นในหน้า /dpo/alerts)
    async notify(alert) {
      try {
        const res = await fetchImpl(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: buildMessage(alert, consoleBaseUrl), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.error(`ส่ง Telegram ไม่สำเร็จ (alert ${alert.alert_id}): HTTP ${res.status}`);
          return { ok: false, status: res.status };
        }
        return { ok: true, status: res.status };
      } catch (err) {
        logger.error(`ส่ง Telegram ไม่สำเร็จ (alert ${alert.alert_id}): ${err?.name || 'Error'}`);
        return { ok: false, status: null };
      }
    },
  };
}

module.exports = { createTelegramNotifier, buildMessage, RULE_LABEL_TH };
