const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.post('/', requireRole('patient'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.user.profileId);
  if (!p) return res.status(404).json({ error: 'Patient record not found' });
  if (!p.doctorId) return res.status(400).json({ error: 'No doctor currently assigned' });

  const reqObj = {
    id: 'REQ-' + Date.now(),
    patientId: p.id,
    patientName: p.name,
    doctorId: p.doctorId,
    reason: req.body.reason || 'Requesting a chat about my care',
    status: 'PENDING',
    createdAt: Date.now(),
  };
  db.requests.unshift(reqObj);
  log(db, `${p.name} requested a chat with their doctor`);
  save(db);
  res.json(reqObj);
});

router.get('/', requireRole('doctor', 'admin'), (req, res) => {
  const db = load();
  let list = db.requests;
  if (req.user.role === 'doctor') list = list.filter((r) => r.doctorId === req.user.profileId);
  res.json(list);
});

router.patch('/:id', requireRole('doctor'), (req, res) => {
  const db = load();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.doctorId !== req.user.profileId) return res.status(403).json({ error: 'Not your request' });
  r.status = req.body.status === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED';
  log(db, `Request from ${r.patientName} was ${r.status.toLowerCase()} by ${req.user.name}`);
  save(db);
  res.json(r);
});

module.exports = router;
