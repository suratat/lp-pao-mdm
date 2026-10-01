# T8: image สำหรับรัน migrate/src/cli.js (เครื่องมือ import ข้อมูล HR เดิม - load/check-quality/import/reconcile)
# แยกจาก infra/migrate/Dockerfile (one-shot รัน node-pg-migrate up เท่านั้น ไม่เกี่ยวกับ HR import) - ไฟล์นั้นไม่ถูกแก้
#
# migrate/src/quality/rules.js require ข้าม package เข้าไปที่ api/src ตรงๆ (เป็น pure function ไม่มี DB/HTTP เหมือน
# security/pid.js) ต้อง COPY ไฟล์ที่ require ถึงให้ครบทั้งสาย (ตรวจจาก require(...) จริงในแต่ละไฟล์ ไม่ได้เดา):
#   migrate/src/quality/rules.js -> api/src/security/pid.js                (ไม่ require อะไรต่อ นอกจาก node:crypto)
#                                -> api/src/services/jobTitleText.js       -> api/src/security/httpProblem.js
#                                                                          -> api/src/services/personnelPositionRules.js
#                                                                             -> api/src/security/httpProblem.js (ซ้ำ)
# personnelPositionRules.js เป็นไฟล์ที่ jobTitleText.js require ต่อ (transitive) - ต้อง copy ด้วยไม่งั้น
# MODULE_NOT_FOUND ตอน require('./jobTitleText') ภายใน container
FROM node:22-alpine

WORKDIR /repo

COPY migrate/package.json migrate/package-lock.json* ./migrate/
RUN cd migrate && npm install --omit=dev

COPY migrate/ ./migrate/

COPY api/src/security/pid.js ./api/src/security/pid.js
COPY api/src/security/httpProblem.js ./api/src/security/httpProblem.js
COPY api/src/services/jobTitleText.js ./api/src/services/jobTitleText.js
COPY api/src/services/personnelPositionRules.js ./api/src/services/personnelPositionRules.js

WORKDIR /repo/migrate

# ไม่มี CMD/ENTRYPOINT ตายตัว - รันด้วย `docker compose run migrate-cli node src/cli.js <load|check-quality|import|reconcile> ...`
