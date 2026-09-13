# T6: image ของ MDM Worker สำหรับ docker-compose.staging.yml
# build context = รากของ repo (เหมือน infra/api/Dockerfile) เพื่อใช้ infra/entrypoint.sh ร่วมกัน
FROM node:22-alpine

WORKDIR /repo/worker

COPY worker/package.json worker/package-lock.json* ./
RUN npm install --omit=dev

COPY worker/ ./
COPY infra/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
