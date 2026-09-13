const express = require('express');
const { requireScope } = require('../middleware/auth');
const { examplePerson, examplePageInfo } = require('../exampleData');
const { FIXTURE_PERSON_ID } = require('../constants');
const { fakeChecksumPid } = require('../security/fakePid');

const router = express.Router();

// 1x1 px JPEG จริง - ใช้แทนรูปจริงจนกว่าจะต่อ Vault/MinIO ใน T3+
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64'
);

router.get('/persons', requireScope('personnel:read:basic'), (req, res) => {
  res.json({ data: [examplePerson()], page: examplePageInfo() });
});

router.post('/persons/lookup', requireScope('personnel:lookup:pid'), (req, res) => {
  res.json({ personId: FIXTURE_PERSON_ID, status: 'ACTIVE' });
});

router.get('/persons/:personId', requireScope('personnel:read:basic'), (req, res) => {
  res.json(examplePerson(req.params.personId));
});

router.get('/persons/:personId/photo', requireScope('personnel:read:photo'), (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Photo-SHA256', 'placeholder-sha256');
  res.status(200).type('image/jpeg').send(PLACEHOLDER_JPEG);
});

router.get('/persons/:personId/pid', requireScope('personnel:read:pid'), (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ personId: req.params.personId, pid: fakeChecksumPid() });
});

module.exports = router;
