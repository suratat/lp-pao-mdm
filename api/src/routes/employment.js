const express = require('express');
const { requireScope } = require('../middleware/auth');
const { exampleEmployment } = require('../exampleData');

const router = express.Router();

router.get('/persons/:personId/employment', requireScope('personnel:read:employment'), (req, res) => {
  res.json([exampleEmployment()]);
});

router.put('/persons/:personId/employment', requireScope('personnel:write:employment'), (req, res) => {
  res.json(exampleEmployment());
});

module.exports = router;
