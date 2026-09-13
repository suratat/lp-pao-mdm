# สิทธิ์ Vault ที่ MDM API ต้องการจริง (ดูการเรียกจริงใน api/src/services/*.js):
# - getPepper() ตอน boot: อ่าน secret/mdm/pid-pepper (KV v2)
# - เข้ารหัส/ถอดรหัส pid (provisioningService, syncService, employmentImportService, pidService)
# - เข้ารหัส/ถอดรหัสรูปถ่าย (syncService เขียนตอน sync, personService ถอดตอนคืนรูป)
# - เข้ารหัส/ถอดรหัส webhook secret (webhookService: สร้าง subscription + ทดสอบส่ง)
#
# TODO(production, T6 follow-up): staging ใช้ token เดียวร่วมกับ mdm-worker-policy.hcl ผ่าน
# mdm-staging-shared-policy.hcl เพื่อความง่าย - production ต้องแยก AppRole ต่อ service จริง (api ใช้
# policy นี้เพียงอย่างเดียว ไม่ใช่ policy รวม) ตาม principle of least privilege

path "secret/data/mdm/pid-pepper" {
  capabilities = ["read"]
}

path "transit/encrypt/mdm-pid" {
  capabilities = ["update"]
}
path "transit/decrypt/mdm-pid" {
  capabilities = ["update"]
}

path "transit/encrypt/mdm-photo" {
  capabilities = ["update"]
}
path "transit/decrypt/mdm-photo" {
  capabilities = ["update"]
}

path "transit/encrypt/mdm-webhook-secret" {
  capabilities = ["update"]
}
path "transit/decrypt/mdm-webhook-secret" {
  capabilities = ["update"]
}
