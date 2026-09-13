# T6: Vault (Transit + KV) ตาม §0.3/ภาคผนวก ค ("vault + Raft storage") - single-node raft สำหรับ staging
# production ต้องพิจารณา multi-node raft cluster หรือ auto-unseal ผ่าน cloud KMS ตามความเสี่ยงจริง (ไม่ใช่
# ขอบเขตของ T6) - TLS ปิดไว้เพราะ Vault อยู่บน docker network ภายใน ไม่ออก host โดยตรง (ตามภาคผนวก ค:
# เครือข่ายภายในเท่านั้น, TLS/allow-list ระดับ perimeter ทำที่ Cloudflare Tunnel + firewall ของ VM จริง)
storage "raft" {
  path    = "/vault/data"
  node_id = "mdm-vault-staging-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"

disable_mlock = true
ui            = false
