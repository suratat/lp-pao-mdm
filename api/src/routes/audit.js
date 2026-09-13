const express = require('express');
const { requireScope } = require('../middleware/auth');
const { exampleChangeLogEntry, exampleAccessLogEntry, examplePageInfo } = require('../exampleData');

const router = express.Router();

router.get('/persons/:personId/change-log', requireScope('audit:read'), (req, res) => {
  res.json({ data: [exampleChangeLogEntry()], page: examplePageInfo() });
});

router.get('/audit/access-logs', requireScope('audit:read'), (req, res) => {
  res.json({ data: [exampleAccessLogEntry()], page: examplePageInfo() });
});

module.exports = router;
