# สิทธิ์ Vault ที่ MDM Worker ต้องการจริง (ดูการเรียกจริงใน worker/src/jobs/webhookAttempt.js):
# ถอดรหัส webhook secret เพื่อคำนวณลายเซ็น X-MDM-Signature ก่อนส่ง - ไม่ต้องแตะ pid/photo/pepper เลย
# (worker ไม่เคยเรียก vault.encrypt/decrypt กับ mdm-pid หรือ mdm-photo หรือ getPepper() ในโค้ดปัจจุบัน)
#
# TODO(production, T6 follow-up): staging ใช้ token เดียวร่วมกับ mdm-api-policy.hcl ผ่าน
# mdm-staging-shared-policy.hcl เพื่อความง่าย - production ต้องแยก AppRole ต่อ service จริง (worker ใช้
# policy นี้เพียงอย่างเดียว แคบกว่า policy ของ api มาก) ตาม principle of least privilege

path "transit/decrypt/mdm-webhook-secret" {
  capabilities = ["update"]
}
