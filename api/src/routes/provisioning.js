const express = require('express');
const { requireScope } = require('../middleware/auth');
const { examplePerson, examplePageInfo, exampleClaimRequest } = require('../exampleData');

const router = express.Router();

router.post('/persons', requireScope('personnel:provision'), (req, res) => {
  const person = examplePerson();
  person.status = 'PENDING_CLAIM';
  res.status(201).json(person);
});

router.post('/persons/:personId/deactivate', requireScope('personnel:write:employment'), (req, res) => {
  const person = examplePerson(req.params.personId);
  person.status = 'INACTIVE';
  res.json(person);
});

router.post('/persons/:personId/reactivate', requireScope('personnel:write:employment'), (req, res) => {
  res.json(examplePerson(req.params.personId));
});

router.post('/persons/:personId/reverify', requireScope('personnel:write:employment'), (req, res) => {
  res.status(202).end();
});

router.get('/claim-requests', requireScope('personnel:provision'), (req, res) => {
  res.json({ data: [exampleClaimRequest()], page: examplePageInfo() });
});

router.post('/claim-requests/:claimRequestId/resolve', requireScope('personnel:provision'), (req, res) => {
  const claim = exampleClaimRequest();
  claim.claimRequestId = req.params.claimRequestId;
  claim.status = req.body?.action === 'REJECT' ? 'REJECTED' : 'LINKED';
  res.json(claim);
});

router.get('/reverify/stale', requireScope('personnel:provision'), (req, res) => {
  const stale = examplePerson();
  stale.verification.verificationStatus = 'STALE';
  res.json({ data: [stale], page: examplePageInfo() });
});

module.exports = router;
