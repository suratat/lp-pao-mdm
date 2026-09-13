const express = require('express');
const { requireScope } = require('../middleware/auth');
const { examplePersonnelEvent } = require('../exampleData');

const router = express.Router();

router.get('/events', requireScope('events:read'), (req, res) => {
  res.json({ data: [examplePersonnelEvent()], lastSequence: 1, hasMore: false });
});

module.exports = router;
