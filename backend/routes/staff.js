const express = require('express');
const { load } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', requireRole('admin'), (req, res) => {
  res.json(load().staffUsers);
});

// A nurse/staff member's own profile — used by the dashboards to show their
// own department without needing admin-level access to the full roster.
router.get('/me', requireRole('nurse', 'staff'), (req, res) => {
  const db = load();
  const me = db.staffUsers.find((s) => s.id === req.user.profileId);
  if (!me) return res.status(404).json({ error: 'Staff profile not found' });
  res.json(me);
});

module.exports = router;
