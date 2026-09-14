# T9: image ของ MDM Portal สำหรับ docker-compose.staging.yml
#
# build context ต้องเป็น "ราก repo" (เหมือน infra/api/Dockerfile, infra/worker/Dockerfile) เพื่อให้ทุก
# image ในสแตกนี้ build จากจุดเดียวกันและง่ายต่อการดูแล ถึงแม้ portal/ จะไม่ได้อ่านไฟล์อื่นนอก portal/ เอง
# (ไม่แตะ docs/design/personnel-mdm-openapi.yaml และไม่แตะ Vault - คุยกับ MDM API ผ่าน HTTP เท่านั้น ดู
# portal/src/mdmClient.js จึงไม่ต้อง copy docs/design/ หรือ infra/entrypoint.sh เหมือนสอง image นั้น)
FROM node:22-alpine

WORKDIR /repo

COPY portal/package.json portal/package-lock.json* ./portal/
RUN cd portal && npm install --omit=dev

COPY portal/ ./portal/

WORKDIR /repo/portal

ENV NODE_ENV=production
# ค่า default เผื่อไม่ได้ตั้ง PORT มาจาก compose - พอร์ตจริงที่ฟังคุมด้วย env PORT (docker-compose.staging.yml
# ส่ง PORTAL_PORT เข้ามาเป็น PORT) EXPOSE นี้เป็นแค่ metadata ไม่ได้บังคับพอร์ตจริง
EXPOSE 3100

CMD ["node", "src/server.js"]
