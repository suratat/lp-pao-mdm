# T6: image one-shot สำหรับรัน migration จริง (node-pg-migrate up) ก่อนที่ api/worker จะเริ่มทำงาน
# build context = รากของ repo (เหมือน infra/api/Dockerfile) เพื่อใช้ package.json/db/migrations ชุดเดียวกับ
# ที่ T1-T5 ทดสอบมาแล้วจริง ไม่ก็อปปี้แยก
FROM node:22-alpine

WORKDIR /repo

# node-pg-migrate/pg อยู่ใน devDependencies ของ package.json รากของ repo (ใช้ร่วมกับ npm test ของ db/)
# ไม่ใช่ dependencies ปกติ - ต้อง npm install แบบเต็ม (ไม่ omit=dev) จึงจะได้ CLI มาใช้ในอิมเมจนี้
COPY package.json package-lock.json* ./
RUN npm install

COPY db/migrations ./db/migrations

# migration 1700000000038_seed_real_position_batch.js อ่าน migrate/data/position-seed-data.csv ตอนรันจริง
# (path.join(__dirname, '..', '..', 'migrate', 'data', ...) จาก db/migrations = /repo/migrate/data/...) -
# ต้อง copy โฟลเดอร์นี้เข้า image ด้วย ไม่งั้น migration หาไฟล์ไม่เจอตอนรันใน container (พบตอน deploy จริง)
COPY migrate/data ./migrate/data

CMD ["npx", "node-pg-migrate", "up", "-m", "db/migrations", "-j", "js"]
