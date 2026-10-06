const express = require('express');
const { requireScope } = require('../middleware/auth');
const { syncFromThaid } = require('../services/syncService');
const { importEmploymentBatch } = require('../services/employmentImportService');
const { assertReason } = require('../services/reason');

// ต้องเป็น factory รับ pool/vault/pepper เข้ามา (ไม่ใช้ global) เพราะ pepper ต้องอ่านจาก Vault ครั้งเดียว
// ตอน boot (ภาคผนวก ข) และ test ต้อง inject fake vault client แทนของจริงได้
function createSyncRouter({ pool, vault, pepper }) {
  const router = express.Router();

  // T3: implement ครบ 5 branch (UNMATCHED/CLAIMED/NO_CHANGE/UPDATED/REJECTED_INACTIVE) ตาม §3.1, §3.3
  router.post('/sync/thaid', requireScope('sync:thaid'), async (req, res, next) => {
    try {
      const { httpStatus, body } = await syncFromThaid({ pool, vault, pepper }, req.body, { actorClient: req.auth.azp });
      res.status(httpStatus).json(body);
    } catch (err) {
      next(err);
    }
  });

  // T4: DRY_RUN/APPLY ตาม §5.3, §5.4
  router.post('/sync/hr/employment-batch', requireScope('personnel:import'), async (req, res, next) => {
    try {
      const { mode = 'DRY_RUN', createIfMissing = false, rows } = req.body;
      // เหตุผลระดับ batch บังคับ (เช่น "HR_IMPORT batch <id>") - เก็บเป็น reason ของทุกแถว data_change_log ที่เกิดจากการนำเข้านี้
      const reason = assertReason(req.body.reason);
      const result = await importEmploymentBatch({ pool, vault, pepper }, { mode, createIfMissing, rows, actorClient: req.auth.azp, reason });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createSyncRouter;
