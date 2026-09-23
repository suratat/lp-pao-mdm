# T9 รอบ 3: image ของ DPO Console สำหรับ docker-compose.staging.yml
#
# build context ต้องเป็น "ราก repo" (เหมือน infra/api/Dockerfile, infra/hr-console/Dockerfile) เพื่อให้ทุก
# image ในสแตกนี้ build จากจุดเดียวกัน - dpo-console/ เองไม่แตะ docs/design/ หรือ Postgres/Vault ตรง
# (คุยกับ MDM API ผ่าน HTTP เท่านั้น ดู dpo-console/src/mdmClient.js)
FROM node:22-alpine

WORKDIR /repo

COPY dpo-console/package.json dpo-console/package-lock.json* ./dpo-console/
RUN cd dpo-console && npm install --omit=dev

COPY dpo-console/ ./dpo-console/

WORKDIR /repo/dpo-console

ENV NODE_ENV=production
# ค่า default เผื่อไม่ได้ตั้ง PORT มาจาก compose (docker-compose.staging.yml ส่ง DPO_CONSOLE_PORT เข้ามาเป็น
# PORT) EXPOSE นี้เป็นแค่ metadata ไม่ได้บังคับพอร์ตจริง
EXPOSE 3300

CMD ["node", "src/server.js"]
