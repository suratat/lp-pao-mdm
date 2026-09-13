# T6: image ของ MDM API สำหรับ docker-compose.staging.yml (api x2 replica หลัง nginx ตามภาคผนวก ค)
#
# build context ต้องเป็น "ราก repo" (ไม่ใช่ api/) เพราะ api/src/openapiSpec.js โหลดสัญญา OpenAPI จาก
# docs/design/personnel-mdm-openapi.yaml ด้วย path สัมพัทธ์ __dirname/../../docs/design/... (CLAUDE.md
# ข้อ 1.2: "ห้ามแก้ไขสัญญาของ API" - ต้องอ่านไฟล์เดียวกับที่ repo ใช้จริง ไม่ใช่ก็อปปี้แยก) โครงสร้างในอิมเมจ
# จึงต้องคงระดับ docs/ กับ api/ เป็นพี่น้องกันเหมือนใน repo จริง ดู docker-compose*.yml: build.context=".."
FROM node:22-alpine

WORKDIR /repo

COPY api/package.json api/package-lock.json* ./api/
RUN cd api && npm install --omit=dev

COPY api/ ./api/
COPY docs/design/ ./docs/design/
COPY infra/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /repo/api

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/server.js"]
