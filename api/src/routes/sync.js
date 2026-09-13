const express = require('express');
const { requireScope } = require('../middleware/auth');
const { exampleImportResult } = require('../exampleData');
const { FIXTURE_PERSON_ID } = require('../constants');

const router = express.Router();

// สเกลตัน T2 เท่านั้น - change detection ครบ 5 branch (UNMATCHED/CLAIMED/NO_CHANGE/UPDATED/REJECTED_INACTIVE)
// ตาม §3.3 ของเอกสารออกแบบ เป็นงานของ T3
router.post('/sync/thaid', requireScope('sync:thaid'), (req, res) => {
  res.status(200).json({
    result: 'NO_CHANGE',
    personId: FIXTURE_PERSON_ID,
    status: 'ACTIVE',
    verificationStatus: 'VERIFIED',
    changedFields: [],
    nameMismatchWithHr: false,
    tokenClaims: {
      sub: FIXTURE_PERSON_ID,
      name: 'ทดสอบ ระบบ',
      employeeNo: 'EMP-0001',
      orgUnitCode: 'PERSONNEL-ADMIN',
      positionTitle: 'นักทรัพยากรบุคคลชำนาญการ',
      roles: ['staff'],
    },
  });
});

router.post('/sync/hr/employment-batch', requireScope('personnel:import'), (req, res) => {
  const result = exampleImportResult();
  result.mode = req.body?.mode || 'DRY_RUN';
  result.total = req.body?.rows?.length || 0;
  res.json(result);
});

module.exports = router;
