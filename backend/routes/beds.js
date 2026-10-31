const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);
router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const db = load();
  const summary = {};
  db.beds.forEach((b) => {
    summary[b.ward] = summary[b.ward] || { ward: b.ward, total: 0, available: 0 };
    summary[b.ward].total += 1;
    if (b.status === 'available') summary[b.ward].available += 1;
  });
  res.json({ beds: db.beds, summary: Object.values(summary) });
});

// Adds one or more beds (and their matching sanitation rooms) to a ward.
router.post('/', (req, res) => {
  const db = load();
  const { ward, count } = req.body;
  if (!ward || !String(ward).trim()) return res.status(400).json({ error: 'Ward name is required' });
  const wardName = String(ward).trim();
  const n = Math.max(1, Math.min(20, Number(count) || 1));

  const existing = db.beds.filter((b) => b.ward.toLowerCase() === wardName.toLowerCase());
  const prefix = existing.length ? existing[0].id.split('-')[0] : wardName.slice(0, 3).toUpperCase();
  let nextNum = existing.length
    ? Math.max(...existing.map((b) => parseInt(b.id.split('-')[1], 10) || 0)) + 1
    : 1;

  const created = [];
  for (let i = 0; i < n; i++) {
    const id = prefix + '-' + String(nextNum++).padStart(2, '0');
    const bed = { id, ward: wardName, status: 'available', patientId: null };
    db.beds.push(bed);
    db.rooms.push({ id, ward: wardName, status: 'READY', lastPatientId: null, updatedAt: Date.now() });
    created.push(bed);
  }
  log(db, `Admin ${req.user.name} added ${n} bed(s) to ${wardName} ward`);
  save(db);
  res.json(created);
});

// A bed can only be removed while free — never mid-stay or mid-sanitation.
router.delete('/:id', (req, res) => {
  const db = load();
  const bed = db.beds.find((b) => b.id === req.params.id);
  if (!bed) return res.status(404).json({ error: 'Not found' });
  if (bed.status !== 'available')
    return res.status(400).json({ error: 'Cannot remove a bed that is occupied or in sanitation' });

  db.beds = db.beds.filter((b) => b.id !== req.params.id);
  db.rooms = db.rooms.filter((r) => r.id !== req.params.id);
  log(db, `Admin ${req.user.name} removed bed ${req.params.id} (${bed.ward} ward)`);
  save(db);
  res.json({ ok: true });
});

module.exports = router;
