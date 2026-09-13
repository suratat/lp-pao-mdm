const express = require('express');
const { requireScope } = require('../middleware/auth');
const { listEvents } = require('../services/eventsService');

function createEventsRouter(pool) {
  const router = express.Router();

  router.get('/events', requireScope('events:read'), async (req, res, next) => {
    try {
      const after = req.query.after !== undefined ? Number(req.query.after) : 0;
      const eventTypes = Array.isArray(req.query.eventType)
        ? req.query.eventType
        : req.query.eventType
          ? [req.query.eventType]
          : undefined;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 50;

      const result = await listEvents({ pool }, { after, eventTypes, limit });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createEventsRouter;
