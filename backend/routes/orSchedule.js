const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const OR_ROOMS = ['OR-01', 'OR-02', 'OR-03', 'OR-04', 'OR-05'];
router.get('/rooms', (req, res) => res.json(OR_ROOMS));

function doctorOwnsPatient(db, doctorProfileId, patientId) {
  const doc = db.doctors.find((d) => d.id === doctorProfileId);
  return !!(doc && doc.patientIds.includes(patientId));
}

// Admin sees every booked slot; a doctor sees only slots for their own patients.
router.get('/', requireRole('admin', 'doctor'), (req, res) => {
  const db = load();
  let list = db.orSchedule;
  if (req.user.role === 'doctor') {
    list = list.filter((s) => doctorOwnsPatient(db, req.user.profileId, s.patientId));
  }
  res.json(list);
});

// Books a specific future OR slot for a named patient — separate from, and
// additional to, the automatic CRITICAL/HIGH risk queue.
router.post('/', requireRole('admin', 'doctor'), (req, res) => {
  const db = load();
  const { patientId, orRoom, date, time, procedure, duration } = req.body;
  if (!patientId || !orRoom || !date || !time)
    return res.status(400).json({ error: 'Patient, OR room, date and time are required' });

  const p = db.patients.find((x) => x.id === patientId && !x.dischargedAt);
  if (!p) return res.status(404).json({ error: 'Patient not found or already discharged' });
  if (req.user.role === 'doctor' && !doctorOwnsPatient(db, req.user.profileId, patientId))
    return res.status(403).json({ error: 'Not your patient' });

  const entry = {
    id: 'ORS-' + Date.now(),
    patientId: p.id,
    patientName: p.name,
    orRoom,
    date,
    time,
    procedure: (procedure || 'Scheduled procedure').trim(),
    duration: (duration || '60 min').trim(),
    status: 'SCHEDULED',
    createdBy: req.user.name,
    createdAt: Date.now(),
  };
  db.orSchedule.unshift(entry);
  p.timeline.unshift({
    time: new Date().toLocaleString(),
    event: `OR time booked — ${orRoom} on ${date} at ${time} (${entry.procedure})`,
  });
  log(db, `${req.user.name} scheduled OR time for ${p.name} — ${orRoom} on ${date} ${time}`);
  save(db);
  res.json(entry);
});

router.patch('/:id', requireRole('admin', 'doctor'), (req, res) => {
  const db = load();
  const s = db.orSchedule.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'doctor' && !doctorOwnsPatient(db, req.user.profileId, s.patientId))
    return res.status(403).json({ error: 'Not your patient' });

  const { status, date, time, orRoom, procedure, duration } = req.body;
  if (status) s.status = status;
  if (date) s.date = date;
  if (time) s.time = time;
  if (orRoom) s.orRoom = orRoom;
  if (procedure) s.procedure = procedure;
  if (duration) s.duration = duration;
  log(db, `OR schedule for ${s.patientName} updated by ${req.user.name}`);
  save(db);
  res.json(s);
});

router.delete('/:id', requireRole('admin', 'doctor'), (req, res) => {
  const db = load();
  const idx = db.orSchedule.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'doctor' && !doctorOwnsPatient(db, req.user.profileId, db.orSchedule[idx].patientId))
    return res.status(403).json({ error: 'Not your patient' });
  const [removed] = db.orSchedule.splice(idx, 1);
  log(db, `OR slot for ${removed.patientName} (${removed.orRoom}, ${removed.date} ${removed.time}) removed by ${req.user.name}`);
  save(db);
  res.json({ ok: true });
});

module.exports = router;
