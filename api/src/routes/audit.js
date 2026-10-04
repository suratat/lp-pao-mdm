const express = require('express');
const { requireScope, requireRole } = require('../middleware/auth');
const { getPersonChangeLog, listChangeLogs, listAccessLogs, reviewPidAccess } = require('../services/auditService');
const { listAlerts, actOnAlert } = require('../services/alertService');

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
        reviewStatus: req.query.reviewStatus,
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // scope audit:review ผูกกับ realm role dpo เท่านั้น (auditor อ่านอย่างเดียว): ตรวจ role ใน API เสมอเพราะ scope ใน token ไม่ใช่ตัวกั้นสิทธิ์
  // (client dpo-console ผูก scope ให้ผู้ใช้ทุกคนของ client - ดู infra/keycloak/README.md)
  router.post('/audit/access-logs/:accessId/review', requireScope('audit:review'), requireRole('dpo'), async (req, res, next) => {
    try {
      const result = await reviewPidAccess(
        pool,
        { accessId: req.params.accessId, accessedAt: req.body.accessedAt, status: req.body.status, note: req.body.note },
        { sub: req.auth.sub, azp: req.auth.azp }
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit/alerts', requireScope('audit:read'), async (req, res, next) => {
    try {
      const result = await listAlerts(pool, {
        status: req.query.status,
        ruleCode: req.query.ruleCode,
        from: req.query.from,
        to: req.query.to,
        actorSub: req.query.actorSub,
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // รับทราบ/ปิดเรื่อง alert: scope audit:review + role dpo (ตรวจ role ใน API เสมอ - เหตุผลเดียวกับ POST /audit/access-logs/{id}/review)
  for (const [path, action] of [
    ['ack', 'ACK'],
    ['close', 'CLOSE'],
  ]) {
    router.post(`/audit/alerts/:alertId/${path}`, requireScope('audit:review'), requireRole('dpo'), async (req, res, next) => {
      try {
        const result = await actOnAlert(pool, req.params.alertId, { action, note: req.body?.note }, { sub: req.auth.sub, azp: req.auth.azp });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

module.exports = createAuditRouter;
