const express = require('express');
const { requireScope } = require('../middleware/auth');
const { syncFromThaid } = require('../services/syncService');
const { importEmploymentBatch } = require('../services/employmentImportService');

// ต้องเป็น factory รับ pool/vault/pepper เข้ามา (ไม่ใช้ global) เพราะ pepper ต้องอ่านจาก Vault ครั้งเดียว
// ตอน boot (ภาคผนวก ข) และ test ต้อง inject fake vault client แทนของจริงได้
function createSyncRouter({ pool, vault, pepper }) {
  const router = express.Router();

  // T3: implement ครบ 5 branch (UNMATCHED/CLAIMED/NO_CHANGE/UPDATED/REJECTED_INACTIVE) ตาม §3.1, §3.3
  router.post('/sync/thaid', requireScope('sync:thaid'), async (req, res, next) => {
    try {
      const { httpStatus, body } = await syncFromThaid({ pool, vault, pepper }, req.body);
      res.status(httpStatus).json(body);
    } catch (err) {
      next(err);
    }
  });

  // T4: DRY_RUN/APPLY ตาม §5.3, §5.4
  router.post('/sync/hr/employment-batch', requireScope('personnel:import'), async (req, res, next) => {
    try {
      const { mode = 'DRY_RUN', createIfMissing = false, rows } = req.body;
      const result = await importEmploymentBatch({ pool, vault, pepper }, { mode, createIfMissing, rows });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createSyncRouter;
