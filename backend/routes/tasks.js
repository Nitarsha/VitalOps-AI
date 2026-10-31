const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Care tasks — short-cycle nursing to-dos tied to a specific patient
// (medication rounds, observations, follow-ups). Doctors and nurses can
// both raise and clear these; admin can see the full board for oversight.
router.get('/', requireRole('admin', 'doctor', 'nurse'), (req, res) => {
  res.json(load().nursingTasks || []);
});

router.post('/', requireRole('doctor', 'nurse'), (req, res) => {
  const db = load();
  const { patientId, task, priority } = req.body;
  if (!patientId || !task || !String(task).trim())
    return res.status(400).json({ error: 'Patient and task description are required' });
  const p = db.patients.find((x) => x.id === patientId);
  if (!p) return res.status(404).json({ error: 'Patient not found' });

  const t = {
    id: 'TASK-' + Date.now(),
    patientId,
    patientName: p.name,
    task: String(task).trim(),
    priority: ['LOW', 'MEDIUM', 'HIGH'].includes(priority) ? priority : 'MEDIUM',
    status: 'OPEN',
    createdBy: req.user.name,
    createdAt: Date.now(),
    completedBy: null,
    completedAt: null,
  };
  db.nursingTasks = db.nursingTasks || [];
  db.nursingTasks.unshift(t);
  log(db, `${req.user.name} added a care task for ${p.name}: ${t.task}`);
  save(db);
  res.json(t);
});

router.patch('/:id/complete', requireRole('doctor', 'nurse'), (req, res) => {
  const db = load();
  const t = (db.nursingTasks || []).find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  t.status = t.status === 'DONE' ? 'OPEN' : 'DONE';
  t.completedBy = t.status === 'DONE' ? req.user.name : null;
  t.completedAt = t.status === 'DONE' ? Date.now() : null;
  log(db, `Care task "${t.task}" for ${t.patientName} marked ${t.status.toLowerCase()} by ${req.user.name}`);
  save(db);
  res.json(t);
});

// Shift handoff notes — ward-level notes nurses leave for the next shift.
router.get('/handoff/notes', requireRole('admin', 'doctor', 'nurse'), (req, res) => {
  res.json(load().shiftNotes || []);
});

router.post('/handoff/notes', requireRole('nurse'), (req, res) => {
  const db = load();
  const { ward, note } = req.body;
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Note text is required' });
  const n = {
    id: 'NOTE-' + Date.now(),
    ward: ward && String(ward).trim() ? String(ward).trim() : 'General',
    note: String(note).trim(),
    author: req.user.name,
    time: new Date().toLocaleString(),
    createdAt: Date.now(),
  };
  db.shiftNotes = db.shiftNotes || [];
  db.shiftNotes.unshift(n);
  db.shiftNotes = db.shiftNotes.slice(0, 200);
  log(db, `${req.user.name} left a shift handoff note (${n.ward})`);
  save(db);
  res.json(n);
});

module.exports = router;
