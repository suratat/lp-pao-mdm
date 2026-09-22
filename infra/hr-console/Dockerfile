# T9 รอบ 2: image ของ HR Console สำหรับ docker-compose.staging.yml
#
# build context ต้องเป็น "ราก repo" (เหมือน infra/api/Dockerfile, infra/portal/Dockerfile) เพื่อให้ทุก
# image ในสแตกนี้ build จากจุดเดียวกัน - hr-console/ เองไม่แตะ docs/design/ หรือ Postgres/Vault ตรง
# (คุยกับ MDM API ผ่าน HTTP เท่านั้น ดู hr-console/src/mdmClient.js)
FROM node:22-alpine

WORKDIR /repo

COPY hr-console/package.json hr-console/package-lock.json* ./hr-console/
RUN cd hr-console && npm install --omit=dev

COPY hr-console/ ./hr-console/

WORKDIR /repo/hr-console

ENV NODE_ENV=production
# ค่า default เผื่อไม่ได้ตั้ง PORT มาจาก compose (docker-compose.staging.yml ส่ง HR_CONSOLE_PORT เข้ามาเป็น
# PORT) EXPOSE นี้เป็นแค่ metadata ไม่ได้บังคับพอร์ตจริง
EXPOSE 3200

CMD ["node", "src/server.js"]
