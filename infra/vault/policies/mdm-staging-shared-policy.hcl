# ใช้เฉพาะ docker-compose.staging.yml: token เดียวที่ vault-init.sh สร้างและแจกให้ทั้ง api และ worker ใช้
# ร่วมกัน (union ของ mdm-api-policy.hcl + mdm-worker-policy.hcl) เพื่อลดความซับซ้อนของการ bootstrap ใน
# รอบนี้ - ดู TODO ในสองไฟล์นั้นและใน infra/README.md: production ห้ามใช้ policy นี้ ต้องสร้าง AppRole
# แยกต่อ service ผ่าน mdm-api-policy.hcl / mdm-worker-policy.hcl คนละ token กัน

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
