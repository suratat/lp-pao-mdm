const express = require('express');
const { requireScope } = require('../middleware/auth');
const { exampleImportResult } = require('../exampleData');
const { syncFromThaid } = require('../services/syncService');

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

  // T3 ยังไม่ implement (HR batch import เป็นงานของ T4/T8) - คง stub ของ T2 ไว้
  router.post('/sync/hr/employment-batch', requireScope('personnel:import'), (req, res) => {
    const result = exampleImportResult();
    result.mode = req.body?.mode || 'DRY_RUN';
    result.total = req.body?.rows?.length || 0;
    res.json(result);
  });

  return router;
}

module.exports = createSyncRouter;
