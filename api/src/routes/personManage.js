const express = require('express');
const { requireScope, requireRole } = require('../middleware/auth');
const { MASTER_DATA_ADMIN_ROLE, SCOPE_MANAGE_PERSON } = require('../constants');
const { requireInactiveScope } = require('../middleware/inactiveScope');
const manage = require('../services/personManageService');

// PR-D2: HR จัดการข้อมูลบุคคลที่ไม่ใช่ของ ThaID - ทุก endpoint ต้องมี scope personnel:manage:person "และ" realm role hr_master_data_admin
// (ตรวจ role ที่นี่เสมอ - scope ใน token ผูกให้ทั้ง client ไม่ใช่ตัวกั้นสิทธิ์รายบุคคล) ข้อมูลติดต่อส่วนตัวจึงเห็น/แก้ได้เฉพาะผู้ถือ role นี้
function createPersonManageRouter(pool) {
  const router = express.Router();
  const gate = [requireScope(SCOPE_MANAGE_PERSON), requireRole(MASTER_DATA_ADMIN_ROLE)];
  const handler = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      next(err);
    }
  };

  router.get('/persons/:personId/manage-profile', ...gate, requireInactiveScope(pool), handler((req) => manage.getManageProfile(pool, req.params.personId)));

  router.patch('/persons/:personId/expected-identity', ...gate, handler((req) => manage.patchExpectedIdentity(pool, req.params.personId, req.body, req.auth)));

  router.patch('/persons/:personId/contact', ...gate, handler((req) => manage.patchContact(pool, req.params.personId, req.body, req.auth)));

  router.put('/persons/:personId/emergency-contacts', ...gate, handler((req) => manage.replaceEmergencyContactsByHr(pool, req.params.personId, req.body, req.auth)));

  router.get(
    '/persons/:personId/history',
    ...gate,
    requireInactiveScope(pool),
    handler((req) =>
      manage.getPersonHistory(pool, req.params.personId, {
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      })
    )
  );

  return router;
}

module.exports = createPersonManageRouter;
