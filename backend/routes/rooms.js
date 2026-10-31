const express = require('express');
const { load, save, log, buildChecklist } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Sanitation cycle: PENDING -> ASSIGNED -> IN_PROGRESS -> QC_REVIEW -> READY.
// Only staff (see requireRole on each mutating route below) can act on a
// room. Everyone else on the clinical/ops side can view live status only.
router.get('/', requireRole('admin', 'nurse', 'staff', 'doctor'), (req, res) => {
  res.json(load().rooms);
});

// Read-only performance snapshot for admin oversight — no ability to act on
// any room from here, kept separate from the mutating staff routes below.
router.get('/reports/summary', requireRole('admin'), (req, res) => {
  const db = load();
  const rows = db.sanitationLog || [];
  const completed = rows.length;
  const avgMinutes = completed ? Math.round(rows.reduce((s, l) => s + (l.durationMin || 0), 0) / completed) : 0;
  const byStaff = {};
  rows.forEach((l) => {
    const key = l.staffName || 'Unknown';
    byStaff[key] = byStaff[key] || { staffName: key, cycles: 0, totalMinutes: 0 };
    byStaff[key].cycles += 1;
    byStaff[key].totalMinutes += l.durationMin || 0;
  });
  res.json({
    completedCycles: completed,
    avgMinutes,
    deepCleans: rows.filter((l) => l.cycleType === 'DEEP').length,
    byStaff: Object.values(byStaff),
    recent: rows.slice(0, 15),
  });
});

router.get('/:id', requireRole('admin', 'nurse', 'staff', 'doctor'), (req, res) => {
  const db = load();
  const r = db.rooms.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// Staff claims a room awaiting sanitation and starts the cycle. The cycle
// type (STANDARD vs DEEP) usually carries over from discharge, but staff can
// pick DEEP themselves if they judge the room needs it.
router.post('/:id/claim', requireRole('staff'), (req, res) => {
  const db = load();
  const r = db.rooms.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'PENDING') return res.status(400).json({ error: 'Room is not awaiting sanitation' });

  const cycleType = req.body.cycleType === 'DEEP' ? 'DEEP' : (r.cycleType || 'STANDARD');
  r.status = 'ASSIGNED';
  r.cycleType = cycleType;
  r.checklist = buildChecklist(cycleType);
  r.assignedStaffId = req.user.profileId;
  r.assignedStaffName = req.user.name;
  r.startedAt = Date.now();
  r.updatedAt = Date.now();
  r.history = r.history || [];
  r.history.push({ time: new Date().toLocaleString(), event: `Claimed by ${req.user.name} (${cycleType} clean)` });

  log(db, `${req.user.name} claimed room ${r.id} for a ${cycleType.toLowerCase()} sanitation cycle`);
  save(db);
  res.json(r);
});

// Toggles one checklist item. The room automatically moves ASSIGNED ->
// IN_PROGRESS the moment the first task is checked off, so status always
// reflects real work happening, not just an assignment sitting idle.
router.patch('/:id/checklist/:taskId', requireRole('staff'), (req, res) => {
  const db = load();
  const r = db.rooms.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.assignedStaffId !== req.user.profileId)
    return res.status(403).json({ error: 'This room is assigned to another staff member' });
  if (!['ASSIGNED', 'IN_PROGRESS'].includes(r.status))
    return res.status(400).json({ error: `Checklist cannot be edited while the room is ${r.status}` });

  const task = (r.checklist || []).find((c) => c.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Checklist item not found' });

  task.done = req.body.done !== false;
  task.doneBy = task.done ? req.user.name : null;
  task.doneAt = task.done ? Date.now() : null;

  if (r.status === 'ASSIGNED' && task.done) {
    r.status = 'IN_PROGRESS';
    r.history.push({ time: new Date().toLocaleString(), event: `Cleaning started by ${req.user.name}` });
  }
  r.updatedAt = Date.now();
  save(db);
  res.json(r);
});

// Moves IN_PROGRESS -> QC_REVIEW -> READY. The final release back into
// admissions is blocked server-side unless every checklist item is done, so
// a room can never be handed back half-cleaned no matter what the UI shows.
router.patch('/:id/advance', requireRole('staff'), (req, res) => {
  const db = load();
  const r = db.rooms.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.assignedStaffId !== req.user.profileId)
    return res.status(403).json({ error: 'This room is assigned to another staff member' });

  if (r.status === 'IN_PROGRESS') {
    r.status = 'QC_REVIEW';
    r.history.push({ time: new Date().toLocaleString(), event: `Sent for quality check by ${req.user.name}` });
  } else if (r.status === 'QC_REVIEW') {
    const incomplete = (r.checklist || []).filter((c) => !c.done);
    if (incomplete.length) {
      return res.status(400).json({
        error: `${incomplete.length} checklist item(s) still incomplete: ${incomplete.map((c) => c.label).join(', ')}`,
      });
    }
    const durationMin = r.startedAt ? Math.round((Date.now() - r.startedAt) / 60000) : null;
    r.status = 'READY';
    r.history.push({ time: new Date().toLocaleString(), event: `Sanitation completed & released by ${req.user.name}` });
    db.sanitationLog = db.sanitationLog || [];
    db.sanitationLog.unshift({
      id: 'SAN-' + Date.now(),
      roomId: r.id,
      ward: r.ward,
      cycleType: r.cycleType,
      staffName: r.assignedStaffName,
      startedAt: r.startedAt,
      completedAt: Date.now(),
      durationMin,
    });
    const b = db.beds.find((bd) => bd.id === r.id);
    if (b) { b.status = 'available'; b.patientId = null; }
    r.assignedStaffId = null;
    r.assignedStaffName = null;
  } else {
    return res.status(400).json({ error: `Room cannot be advanced from ${r.status}` });
  }
  r.updatedAt = Date.now();
  log(db, `Room ${r.id} advanced to ${r.status} by ${req.user.name}`);
  save(db);
  res.json(r);
});

// Clinical escalation: a doctor/nurse/admin can flag that a queued room
// needs a deep clean (e.g. an infection risk noticed after discharge).
// They can only flag it — the actual cleaning stays staff-only.
router.patch('/:id/flag-deep-clean', requireRole('doctor', 'nurse', 'admin'), (req, res) => {
  const db = load();
  const r = db.rooms.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (!['PENDING', 'ASSIGNED'].includes(r.status))
    return res.status(400).json({ error: 'Room is already mid or post cleaning — confirm with sanitation staff on-site' });
  r.cycleType = 'DEEP';
  if (r.status === 'ASSIGNED') r.checklist = buildChecklist('DEEP');
  r.updatedAt = Date.now();
  log(db, `${req.user.name} flagged room ${r.id} for a DEEP sanitation clean`);
  save(db);
  res.json(r);
});

module.exports = router;
