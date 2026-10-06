const express = require('express');
const { requireScope, SCOPE_READ_BASIC } = require('../middleware/auth');
const provisioningService = require('../services/provisioningService');
const { MASTER_DATA_ADMIN_ROLE } = require('../constants');
const { requireRole } = require('../middleware/auth');

// เขียนข้อมูลบุคคลด้วยมือ (สร้าง/พ้นสภาพ/คืนสภาพ): ต้องมี realm role hr_master_data_admin เพิ่มจาก scope เสมอ
const manualWriteRole = requireRole(MASTER_DATA_ADMIN_ROLE);

function createProvisioningRouter({ pool, vault, pepper }) {
  const router = express.Router();

  router.post('/persons', requireScope('personnel:provision', SCOPE_READ_BASIC), manualWriteRole, async (req, res, next) => {
    try {
      const person = await provisioningService.provisionPerson({ pool, vault, pepper }, req.body, req.auth);
      res.status(201).json(person);
    } catch (err) {
      next(err);
    }
  });

  router.post('/persons/:personId/deactivate', requireScope('personnel:write:employment', SCOPE_READ_BASIC), manualWriteRole, async (req, res, next) => {
    try {
      const person = await provisioningService.deactivatePerson(pool, req.params.personId, req.body, req.auth);
      res.json(person);
    } catch (err) {
      next(err);
    }
  });

  router.post('/persons/:personId/reactivate', requireScope('personnel:write:employment', SCOPE_READ_BASIC), manualWriteRole, async (req, res, next) => {
    try {
      const person = await provisioningService.reactivatePerson(pool, req.params.personId, req.body, req.auth);
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
        { pool, vault, pepper },
        req.params.claimRequestId,
        req.body,
        req.auth
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/reverify/stale', requireScope('personnel:provision', SCOPE_READ_BASIC), async (req, res, next) => {
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
