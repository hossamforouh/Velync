const { Router } = require('express');
const { verifyAuth } = require('../middleware/auth');
const { isSuperAdmin } = require('../../core/superadmin');

const router = Router();

router.get('/admin/status', verifyAuth, (req, res) => {
  res.json({ isSuperadmin: isSuperAdmin(req.user.uid) });
});

module.exports = router;
