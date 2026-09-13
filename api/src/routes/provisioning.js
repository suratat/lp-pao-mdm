const express = require('express');
const { requireScope } = require('../middleware/auth');
const provisioningService = require('../services/provisioningService');

function createProvisioningRouter({ pool, vault, pepper }) {
  const router = express.Router();

  router.post('/persons', requireScope('personnel:provision'), async (req, res, next) => {
    try {
      const person = await provisioningService.provisionPerson({ pool, vault, pepper }, req.body);
      res.status(201).json(person);
    } catch (err) {
      next(err);
    }
  });

  router.post('/persons/:personId/deactivate', requireScope('personnel:write:employment'), async (req, res, next) => {
    try {
      const person = await provisioningService.deactivatePerson(pool, req.params.personId, req.body);
      res.json(person);
    } catch (err) {
      next(err);
    }
  });

  router.post('/persons/:personId/reactivate', requireScope('personnel:write:employment'), async (req, res, next) => {
    try {
      const person = await provisioningService.reactivatePerson(pool, req.params.personId, req.body);
      res.json(person);
    } catch (err) {
      next(err);
    }
  });

  router.post('/persons/:personId/reverify', requireScope('personnel:write:employment'), async (req, res, next) => {
    try {
      await provisioningService.requestReverify(pool, req.params.personId);
      res.status(202).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/claim-requests', requireScope('personnel:provision'), async (req, res, next) => {
    try {
      const result = await provisioningService.listClaimRequests(pool, {
        status: req.query.status || 'PENDING_HR',
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/claim-requests/:claimRequestId/resolve', requireScope('personnel:provision'), async (req, res, next) => {
    try {
      const result = await provisioningService.resolveClaimRequest(
        { pool, vault },
        req.params.claimRequestId,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/reverify/stale', requireScope('personnel:provision'), async (req, res, next) => {
    try {
      const verificationStatus = Array.isArray(req.query.verificationStatus)
        ? req.query.verificationStatus
        : req.query.verificationStatus
          ? [req.query.verificationStatus]
          : undefined;
      const result = await provisioningService.listStalePersons(pool, {
        verificationStatus,
        orgUnitId: req.query.orgUnitId,
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

module.exports = createProvisioningRouter;
