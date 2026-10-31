const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Anyone on the clinical/ops side can report a facility issue (broken
// equipment, plumbing, etc.), but — same separation of concerns as the
// sanitation cycle — only sanitation/facilities staff resolve it.
router.get('/', requireRole('admin', 'nurse', 'staff', 'doctor'), (req, res) => {
  res.json(load().maintenanceRequests || []);
});

router.post('/', requireRole('admin', 'nurse', 'staff', 'doctor'), (req, res) => {
  const db = load();
  const { ward, roomId, issue, priority } = req.body;
  if (!issue || !String(issue).trim()) return res.status(400).json({ error: 'Issue description is required' });

  const m = {
    id: 'MNT-' + Date.now(),
    ward: ward && String(ward).trim() ? String(ward).trim() : 'General',
    roomId: roomId && String(roomId).trim() ? String(roomId).trim() : null,
    issue: String(issue).trim(),
    priority: ['LOW', 'MEDIUM', 'HIGH'].includes(priority) ? priority : 'MEDIUM',
    status: 'OPEN',
    reportedBy: req.user.name,
    reportedAt: Date.now(),
    resolvedBy: null,
    resolvedAt: null,
  };
  db.maintenanceRequests = db.maintenanceRequests || [];
  db.maintenanceRequests.unshift(m);
  log(db, `${req.user.name} reported a maintenance issue${m.roomId ? ' in ' + m.roomId : ''}: ${m.issue}`);
  save(db);
  res.json(m);
});

router.patch('/:id', requireRole('staff'), (req, res) => {
  const db = load();
  const m = (db.maintenanceRequests || []).find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const status = ['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Invalid status' });
  m.status = status;
  if (status === 'RESOLVED') { m.resolvedBy = req.user.name; m.resolvedAt = Date.now(); }
  else { m.resolvedBy = null; m.resolvedAt = null; }
  log(db, `Maintenance ticket ${m.id} (${m.issue}) marked ${status} by ${req.user.name}`);
  save(db);
  res.json(m);
});

module.exports = router;
