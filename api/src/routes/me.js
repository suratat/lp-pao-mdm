const express = require('express');
const { requireScope } = require('../middleware/auth');
const { HttpProblem } = require('../security/httpProblem');
const { getPerson } = require('../services/personService');
const { updateMyContact, replaceMyEmergencyContacts, reportIdentityIssue } = require('../services/meService');
const { listMyConsents, setMyConsent } = require('../services/consentService');

function requireOwnPersonId(req) {
  if (!req.auth.personId) {
    throw new HttpProblem(403, 'user-context-required', 'ต้องใช้ token แบบ user context (มี person_id)');
  }
  return req.auth.personId;
}

function createMeRouter(pool) {
  const router = express.Router();

  router.get('/me', requireScope('personnel:self'), async (req, res, next) => {
    try {
      const personId = requireOwnPersonId(req);
      const person = await getPerson(pool, personId);
      res.json(person);
    } catch (err) {
      next(err);
    }
  });

  router.put('/me/contact', requireScope('personnel:self'), async (req, res, next) => {
    try {
      const personId = requireOwnPersonId(req);
      const contact = await updateMyContact(pool, personId, req.body);
      res.json(contact);
    } catch (err) {
      next(err);
    }
  });

  router.put('/me/emergency-contacts', requireScope('personnel:self'), async (req, res, next) => {
    try {
      const personId = requireOwnPersonId(req);
      const contacts = await replaceMyEmergencyContacts(pool, personId, req.body);
      res.json(contacts);
    } catch (err) {
      next(err);
    }
  });

  router.post('/me/report-identity-issue', requireScope('personnel:self'), async (req, res, next) => {
    try {
      const personId = requireOwnPersonId(req);
      await reportIdentityIssue(pool, personId, req.body);
      res.status(202).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/me/consents', requireScope('personnel:self'), async (req, res, next) => {
    try {
      const personId = requireOwnPersonId(req);
      const consents = await listMyConsents(pool, personId);
      res.json(consents);
    } catch (err) {
      next(err);
    }
  });

  router.put('/me/consents/:purposeCode', requireScope('personnel:self'), async (req, res, next) => {
    try {
      const personId = requireOwnPersonId(req);
      const consent = await setMyConsent(pool, personId, req.params.purposeCode, req.body);
      res.json(consent);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createMeRouter;
