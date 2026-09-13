const express = require('express');
const { requireScope } = require('../middleware/auth');
const { getEmploymentHistory, upsertEmployment } = require('../services/employmentService');

function createEmploymentRouter(pool) {
  const router = express.Router();

  router.get('/persons/:personId/employment', requireScope('personnel:read:employment'), async (req, res, next) => {
    try {
      const currentOnly = req.query.currentOnly === 'true' || req.query.currentOnly === true;
      const history = await getEmploymentHistory(pool, req.params.personId, currentOnly);
      res.json(history);
    } catch (err) {
      next(err);
    }
  });

  router.put('/persons/:personId/employment', requireScope('personnel:write:employment'), async (req, res, next) => {
    try {
      const result = await upsertEmployment(pool, req.params.personId, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createEmploymentRouter;
