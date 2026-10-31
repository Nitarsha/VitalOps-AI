const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Patients book an appointment with any doctor on the roster — a "visiting
// doctor" consultation, independent of their auto-assigned admitting doctor.
router.post('/', requireRole('patient'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.user.profileId);
  if (!p) return res.status(404).json({ error: 'Patient record not found' });

  const { doctorId, date, time, reason } = req.body;
  if (!doctorId || !date || !time) return res.status(400).json({ error: 'Doctor, date and time are required' });
  const doctor = db.doctors.find((d) => d.id === doctorId);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

  const appt = {
    id: 'APT-' + Date.now(),
    patientId: p.id,
    patientName: p.name,
    doctorId: doctor.id,
    doctorName: doctor.name,
    specialty: doctor.specialty,
    date,
    time,
    reason: (reason || 'General consultation').trim(),
    status: 'REQUESTED',
    createdAt: Date.now(),
  };
  db.appointments.unshift(appt);
  p.timeline.unshift({
    time: new Date().toLocaleString(),
    event: `Appointment requested with Dr. ${doctor.name} — ${date} ${time}`,
  });
  log(db, `${p.name} requested an appointment with Dr. ${doctor.name} (${date} ${time})`);
  save(db);
  res.json(appt);
});

// Scoped by role: patients see their own, doctors see theirs, admin sees all.
router.get('/', (req, res) => {
  const db = load();
  let list = db.appointments;
  if (req.user.role === 'patient') list = list.filter((a) => a.patientId === req.user.profileId);
  else if (req.user.role === 'doctor') list = list.filter((a) => a.doctorId === req.user.profileId);
  else if (req.user.role !== 'admin') return res.status(403).json({ error: 'This role cannot access this resource' });
  res.json(list);
});

// Doctors/admin confirm, decline, or complete; patients may only cancel their own.
router.patch('/:id', requireRole('doctor', 'admin', 'patient'), (req, res) => {
  const db = load();
  const a = db.appointments.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'patient') {
    if (a.patientId !== req.user.profileId) return res.status(403).json({ error: 'Not your appointment' });
    if (req.body.status !== 'CANCELLED') return res.status(403).json({ error: 'Patients may only cancel an appointment' });
  }
  if (req.user.role === 'doctor' && a.doctorId !== req.user.profileId) {
    return res.status(403).json({ error: 'Not your appointment' });
  }

  const allowed = ['CONFIRMED', 'CANCELLED', 'COMPLETED'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  a.status = req.body.status;
  log(db, `Appointment for ${a.patientName} with Dr. ${a.doctorName} marked ${a.status} by ${req.user.name}`);
  save(db);
  res.json(a);
});

module.exports = router;
