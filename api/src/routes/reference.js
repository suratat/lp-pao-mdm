const express = require('express');
const { requireScope } = require('../middleware/auth');
const { exampleOrgUnit, examplePosition } = require('../exampleData');

const router = express.Router();

router.get('/org-units', requireScope('personnel:read:basic'), (req, res) => {
  res.json([exampleOrgUnit()]);
});

router.get('/positions', requireScope('personnel:read:basic'), (req, res) => {
  res.json([examplePosition()]);
});

module.exports = router;
