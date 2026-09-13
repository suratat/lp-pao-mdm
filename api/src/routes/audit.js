const express = require('express');
const { requireScope } = require('../middleware/auth');
const { getPersonChangeLog, listAccessLogs } = require('../services/auditService');

function createAuditRouter(pool) {
  const router = express.Router();

  router.get('/persons/:personId/change-log', requireScope('audit:read'), async (req, res, next) => {
    try {
      const result = await getPersonChangeLog(pool, req.params.personId, {
        since: req.query.since,
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit/access-logs', requireScope('audit:read'), async (req, res, next) => {
    try {
      const result = await listAccessLogs(pool, {
        personId: req.query.personId,
        clientId: req.query.clientId,
        from: req.query.from,
        to: req.query.to,
        pidAccessOnly: req.query.pidAccessOnly === 'true' || req.query.pidAccessOnly === true,
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createAuditRouter;
