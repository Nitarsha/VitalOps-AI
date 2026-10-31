const express = require('express');
const { load } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', requireRole('admin'), (req, res) => res.json(load().auditLog));

module.exports = router;
