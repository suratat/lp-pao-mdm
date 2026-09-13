const express = require('express');
const { requireScope } = require('../middleware/auth');
const { exampleWebhookSubscription, exampleWebhookDelivery, examplePageInfo } = require('../exampleData');

const router = express.Router();

router.get('/webhooks/subscriptions', requireScope('webhook:manage'), (req, res) => {
  res.json([exampleWebhookSubscription()]);
});

router.post('/webhooks/subscriptions', requireScope('webhook:manage'), (req, res) => {
  const subscription = exampleWebhookSubscription();
  subscription.url = req.body.url;
  subscription.eventTypes = req.body.eventTypes;
  res.status(201).json({ ...subscription, secret: 'shown-once-secret-placeholder' });
});

router.delete('/webhooks/subscriptions/:subscriptionId', requireScope('webhook:manage'), (req, res) => {
  res.status(204).end();
});

router.post('/webhooks/subscriptions/:subscriptionId/test', requireScope('webhook:manage'), (req, res) => {
  res.json(exampleWebhookDelivery());
});

router.get('/webhooks/deliveries', requireScope('webhook:manage'), (req, res) => {
  res.json({ data: [exampleWebhookDelivery()], page: examplePageInfo() });
});

router.post('/webhooks/deliveries/:deliveryId/retry', requireScope('webhook:manage'), (req, res) => {
  res.status(202).end();
});

module.exports = router;
