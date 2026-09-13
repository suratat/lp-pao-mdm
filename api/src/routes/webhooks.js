const express = require('express');
const { requireScope } = require('../middleware/auth');
const webhookService = require('../services/webhookService');

function createWebhooksRouter({ pool, vault }) {
  const router = express.Router();

  router.get('/webhooks/subscriptions', requireScope('webhook:manage'), async (req, res, next) => {
    try {
      const subscriptions = await webhookService.listWebhookSubscriptions(pool, req.auth.azp);
      res.json(subscriptions);
    } catch (err) {
      next(err);
    }
  });

  router.post('/webhooks/subscriptions', requireScope('webhook:manage'), async (req, res, next) => {
    try {
      const subscription = await webhookService.createWebhookSubscription({ pool, vault }, req.auth.azp, req.body);
      res.status(201).json(subscription);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/webhooks/subscriptions/:subscriptionId', requireScope('webhook:manage'), async (req, res, next) => {
    try {
      await webhookService.deleteWebhookSubscription(pool, req.auth.azp, req.params.subscriptionId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post('/webhooks/subscriptions/:subscriptionId/test', requireScope('webhook:manage'), async (req, res, next) => {
    try {
      const result = await webhookService.testWebhookSubscription(
        { pool, vault },
        req.auth.azp,
        req.params.subscriptionId
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/webhooks/deliveries', requireScope('webhook:manage'), async (req, res, next) => {
    try {
      const status = Array.isArray(req.query.status) ? req.query.status : req.query.status ? [req.query.status] : undefined;
      const result = await webhookService.listWebhookDeliveries(pool, req.auth.azp, {
        status,
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/webhooks/deliveries/:deliveryId/retry', requireScope('webhook:manage'), async (req, res, next) => {
    try {
      await webhookService.retryWebhookDelivery(pool, req.auth.azp, req.params.deliveryId);
      res.status(202).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createWebhooksRouter;
