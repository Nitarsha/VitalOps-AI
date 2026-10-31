const express = require('express');
const { load } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', requireRole('admin'), (req, res) => {
  res.json(load().doctors);
});

// Lightweight roster for booking flows (e.g. a patient choosing a visiting
// doctor for an appointment) — any authenticated role, no patient-load data.
router.get('/directory', (req, res) => {
  const db = load();
  res.json(db.doctors.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty })));
});

router.get('/me', requireRole('doctor'), (req, res) => {
  const db = load();
  const doc = db.doctors.find((d) => d.id === req.user.profileId);
  if (!doc) return res.status(404).json({ error: 'Doctor profile not found' });
  const patients = db.patients.filter((p) => doc.patientIds.includes(p.id) && !p.dischargedAt);
  res.json({ ...doc, patients });
});

module.exports = router;
