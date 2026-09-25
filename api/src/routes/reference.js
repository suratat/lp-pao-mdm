const express = require('express');
const { requireScope, requireRole } = require('../middleware/auth');
const { listOrgUnits, listPositions, listPositionTypes } = require('../services/referenceService');
const referenceWriteService = require('../services/referenceWriteService');

// realm role ที่ใช้คู่กับ scope personnel:manage:reference (T10) - ดู infra/keycloak/README.md
const MASTER_DATA_ADMIN_ROLE = 'hr_master_data_admin';
const MASTER_DATA_SCOPE = 'personnel:manage:reference';

function parseBoolQuery(value, defaultValue) {
  if (value === undefined) return defaultValue;
  return value === 'true' || value === true;
}

// T5: implement จริงแทน stub ของ T2 (Reference tag ไม่ได้อยู่ใน T ใดของ CLAUDE.md แต่ทำพร้อมกันตามที่ตกลง)
// T10: เพิ่ม POST/PUT ของ org-units/positions และ GET /position-types
// ไม่บันทึก access_log: ข้อมูลนี้ไม่ใช่ข้อมูลส่วนบุคคล (กฎข้อ 6 ครอบเฉพาะ endpoint ที่คืนข้อมูลบุคคล) -
// การเขียนบันทึกใน audit.reference_change_log แทน
function createReferenceRouter(pool) {
  const router = express.Router();
  const manageReference = [requireScope(MASTER_DATA_SCOPE), requireRole(MASTER_DATA_ADMIN_ROLE)];
  const actorOf = (req) => ({ sub: req.auth.sub, azp: req.auth.azp });

  router.get('/org-units', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      res.json(await listOrgUnits(pool, parseBoolQuery(req.query.activeOnly, true)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/org-units', ...manageReference, async (req, res, next) => {
    try {
      res.status(201).json(await referenceWriteService.createOrgUnit(pool, req.body, actorOf(req)));
    } catch (err) {
      next(err);
    }
  });

  router.put('/org-units/:orgUnitId', ...manageReference, async (req, res, next) => {
    try {
      res.json(await referenceWriteService.updateOrgUnit(pool, req.params.orgUnitId, req.body, actorOf(req)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/positions', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      res.json(await listPositions(pool, req.query.orgUnitId, parseBoolQuery(req.query.activeOnly, false)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/positions', ...manageReference, async (req, res, next) => {
    try {
      res.status(201).json(await referenceWriteService.createPosition(pool, req.body, actorOf(req)));
    } catch (err) {
      next(err);
    }
  });

  router.put('/positions/:positionId', ...manageReference, async (req, res, next) => {
    try {
      res.json(await referenceWriteService.updatePosition(pool, req.params.positionId, req.body, actorOf(req)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/position-types', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      res.json(await listPositionTypes(pool, parseBoolQuery(req.query.activeOnly, true)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createReferenceRouter;
module.exports.MASTER_DATA_ADMIN_ROLE = MASTER_DATA_ADMIN_ROLE;
