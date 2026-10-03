const crypto = require('node:crypto');
const { makeFakePid, pidHash } = require('../../api/src/security/pid');

// หลัง PR #69 การอนุมัติ claim (PROVISION) ต้องส่ง employeeNo (= เลขบัตรประชาชน) ที่ hash แล้วตรงกับ pid_hash ของคำขอ (422 ถ้าไม่ตรง)
// เทสต์จึงต้องสร้างคำขอจากเลขบัตรปลอม (makeFakePid) แล้วใช้เลขเดิมตอนอนุมัติ - ไม่ใช่ pid_hash สุ่มกับเลขสุ่มคนละตัว
// เลขเต็มเก็บในหน่วยความจำของเทสต์เท่านั้น (ไม่ commit ลงไฟล์ ไม่เขียนลง DB นอกจาก hash)
const pidByClaimId = new Map();

// vault: harness.apiCtx.vault (ให้ pepper ตัวเดียวกับที่ MDM API ในเทสต์ใช้)
async function insertClaimWithFakePid(adminPool, vault, displayName) {
  const pid = makeFakePid();
  const hash = pidHash(pid, await vault.getPepper());
  const { rows } = await adminPool.query(
    `INSERT INTO mdm.claim_request (pid_hash, display_name, status, attempt_count, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'PENDING_HR', 1, now(), now()) RETURNING claim_request_id`,
    [hash, displayName]
  );
  pidByClaimId.set(rows[0].claim_request_id, pid);
  return rows[0].claim_request_id;
}

// เลขบัตรปลอมที่ตรงกับคำขอนั้น (undefined ถ้าไม่ใช่คำขอที่สร้างจาก insertClaimWithFakePid)
const fakePidForClaim = (claimRequestId) => pidByClaimId.get(claimRequestId);

// pid_hash สุ่ม (ไม่มีเลขบัตรที่ตรงกัน) สำหรับเทสต์ที่ไม่ได้อนุมัติ PROVISION
const randomPidHash = () => crypto.randomBytes(32).toString('hex');

module.exports = { insertClaimWithFakePid, fakePidForClaim, randomPidHash };
