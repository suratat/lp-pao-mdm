const express = require('express');

const router = express.Router();

// security: [] ใน OpenAPI - ไม่ต้องมี token (ใช้โดย monitoring)
function createSystemRouter(pool) {
  router.get('/health', async (req, res) => {
    let dbStatus = 'ok';
    try {
      await pool.query('SELECT 1');
    } catch {
      dbStatus = 'error';
    }
    res.json({
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      db: dbStatus,
      vault: 'not_configured', // Vault ยังไม่ต่อจนกว่าจะถึง T3
      outboxBacklog: 0,
    });
  });
  return router;
}

module.exports = createSystemRouter;
