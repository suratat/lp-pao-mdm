const express = require('express');
const { requireScope } = require('../middleware/auth');
const { listOrgUnits, listPositions } = require('../services/referenceService');

// T5: implement จริงแทน stub ของ T2 (Reference tag ไม่ได้อยู่ใน T ใดของ CLAUDE.md แต่ทำพร้อมกันตามที่ตกลง)
function createReferenceRouter(pool) {
  const router = express.Router();

  router.get('/org-units', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      const activeOnly = req.query.activeOnly === undefined || req.query.activeOnly === 'true' || req.query.activeOnly === true;
      const orgUnits = await listOrgUnits(pool, activeOnly);
      res.json(orgUnits);
    } catch (err) {
      next(err);
    }
  });

  router.get('/positions', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      const positions = await listPositions(pool, req.query.orgUnitId);
      res.json(positions);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createReferenceRouter;
