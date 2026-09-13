const express = require('express');
const { requireScope } = require('../middleware/auth');
const personService = require('../services/personService');
const pidService = require('../services/pidService');

function buildRequestMeta(req, extra = {}) {
  return {
    endpoint: req.originalUrl,
    httpMethod: req.method,
    requestId: req.id,
    clientIp: req.ip,
    ...extra,
  };
}

function createPersonsRouter({ pool, vault, pepper }) {
  const router = express.Router();

  router.get('/persons', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      const status = Array.isArray(req.query.status) ? req.query.status : req.query.status ? [req.query.status] : undefined;
      const result = await personService.searchPersons(pool, {
        q: req.query.q,
        orgUnitId: req.query.orgUnitId,
        includeChildUnits: req.query.includeChildUnits === 'true' || req.query.includeChildUnits === true,
        positionId: req.query.positionId,
        personnelType: req.query.personnelType,
        status,
        updatedSince: req.query.updatedSince,
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // TODO(R12, ก่อนเปิดให้ consumer ภายนอกใช้): endpoint นี้ยังไม่มี rate limiting ตามที่ OpenAPI
  // อธิบายไว้ ("มี rate limit เข้มงวด ค่าเริ่มต้น 30 ครั้ง/นาที/client") - middleware/rateLimit ที่ระบุไว้ใน
  // CLAUDE.md ข้อ 4 (โครงรีโป) ยังไม่ implement จริงในโค้ดฐานนี้ ห้ามให้ consumer_system ภายนอกเรียก
  // /persons/lookup จนกว่าจะเพิ่ม rate limit จริง (ความเสี่ยง: ใช้ enumeration เดา pid ที่มีอยู่ในระบบได้
  // ถ้าไม่จำกัดอัตราการเรียก แม้ response จะคืน 404 เหมือนกันทั้งกรณีไม่พบและไม่มีสิทธิ์ก็ตาม)
  router.post('/persons/lookup', requireScope('personnel:lookup:pid'), async (req, res, next) => {
    try {
      const result = await personService.lookupPersonByPid(pool, req.body.pid, req.body.justification, {
        actor: req.auth,
        requestMeta: buildRequestMeta(req, { pepper }),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/persons/:personId', requireScope('personnel:read:basic'), async (req, res, next) => {
    try {
      const person = await personService.getPerson(pool, req.params.personId);
      res.json(person);
    } catch (err) {
      next(err);
    }
  });

  router.get('/persons/:personId/photo', requireScope('personnel:read:photo'), async (req, res, next) => {
    try {
      const { buffer, mimeType, sha256 } = await personService.getPersonPhoto(pool, vault, req.params.personId, {
        actor: req.auth,
        requestMeta: buildRequestMeta(req),
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Photo-SHA256', sha256);
      res.status(200).type(mimeType || 'image/jpeg').send(buffer);
    } catch (err) {
      next(err);
    }
  });

  router.get('/persons/:personId/pid', requireScope('personnel:read:pid'), async (req, res, next) => {
    try {
      const pid = await pidService.reveal(
        { pool, vault },
        {
          personId: req.params.personId,
          actor: req.auth,
          justification: req.query.justification,
          requestMeta: buildRequestMeta(req),
        }
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ personId: req.params.personId, pid });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createPersonsRouter;
