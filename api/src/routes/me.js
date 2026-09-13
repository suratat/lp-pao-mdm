const express = require('express');
const { requireScope } = require('../middleware/auth');
const { examplePerson, exampleConsent } = require('../exampleData');
const { FIXTURE_PERSON_ID } = require('../constants');

const router = express.Router();

router.get('/me', requireScope('personnel:self'), (req, res) => {
  res.json(examplePerson(req.auth.personId || FIXTURE_PERSON_ID));
});

router.put('/me/contact', requireScope('personnel:self'), (req, res) => {
  const person = examplePerson(req.auth.personId || FIXTURE_PERSON_ID);
  res.json({ ...person.contact, ...req.body });
});

router.put('/me/emergency-contacts', requireScope('personnel:self'), (req, res) => {
  res.json(req.body);
});

router.post('/me/report-identity-issue', requireScope('personnel:self'), (req, res) => {
  res.status(202).end();
});

router.get('/me/consents', requireScope('personnel:self'), (req, res) => {
  res.json([exampleConsent()]);
});

router.put('/me/consents/:purposeCode', requireScope('personnel:self'), (req, res) => {
  const consent = exampleConsent();
  consent.purposeCode = req.params.purposeCode;
  consent.status = req.body.status;
  consent.policyVersion = req.body.policyVersion;
  if (req.body.status === 'GRANTED') consent.grantedAt = new Date().toISOString();
  if (req.body.status === 'WITHDRAWN') consent.withdrawnAt = new Date().toISOString();
  res.json(consent);
});

module.exports = router;
