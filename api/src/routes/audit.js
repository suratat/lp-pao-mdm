const express = require('express');
const { requireScope } = require('../middleware/auth');
const { getPersonChangeLog, listChangeLogs, listAccessLogs } = require('../services/auditService');

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

  router.get('/audit/change-logs', requireScope('audit:read'), async (req, res, next) => {
    try {
      const result = await listChangeLogs(pool, {
        source: req.query.source,
        from: req.query.from,
        to: req.query.to,
        actorSub: req.query.actorSub,
        tableName: req.query.tableName,
        personId: req.query.personId,
        changedBy: req.query.changedBy,
        action: req.query.action,
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
