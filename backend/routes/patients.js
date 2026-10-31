const express = require('express');
const { load, save, log, buildChecklist } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { computeRisk } = require('./auth');

const router = express.Router();
router.use(auth);

router.get('/', requireRole('admin', 'doctor', 'nurse'), (req, res) => {
  const db = load();
  let list = db.patients.filter((p) => !p.dischargedAt);
  if (req.user.role === 'doctor') {
    const doc = db.doctors.find((d) => d.id === req.user.profileId);
    list = list.filter((p) => doc && doc.patientIds.includes(p.id));
  }
  res.json(
    list.map((p) => ({ ...p, doctorName: (db.doctors.find((d) => d.id === p.doctorId) || {}).name || 'Unassigned' }))
  );
});

// Admin can add a patient directly (e.g. walk-in / phone admission) —
// same auto doctor + bed assignment logic as self-registration.
router.post('/', requireRole('admin'), (req, res) => {
  const db = load();
  const { name, age, gender, condition, isolationPrecaution } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const pool = condition
    ? db.doctors.filter((d) => d.specialty.toLowerCase() === String(condition).toLowerCase())
    : [];
  const doctorPool = (pool.length ? pool : db.doctors).slice().sort((a, b) => a.patientIds.length - b.patientIds.length);
  const doctor = doctorPool[0] || null;
  const bed = db.beds.find((b) => b.status === 'available') || null;
  const vitals = { hr: 82, spo2: 97, bp: '118/78', rr: 18 };

  const p = {
    id: 'P-' + Date.now(),
    userId: null,
    name,
    age: Number(age) || 30,
    gender: gender || 'Unspecified',
    condition: condition || 'General observation',
    riskLevel: 'STABLE',
    isolationPrecaution: !!isolationPrecaution,
    doctorId: doctor ? doctor.id : null,
    bedId: bed ? bed.id : null,
    vitals,
    admittedAt: Date.now(),
    dischargedAt: null,
    timeline: [{ time: new Date().toLocaleString(), event: `Admitted by admin (${req.user.name})` }],
    chatHistory: [],
  };
  if (doctor) doctor.patientIds.push(p.id);
  if (bed) {
    bed.status = 'occupied';
    bed.patientId = p.id;
    const room = db.rooms.find((r) => r.id === bed.id);
    if (room) {
      room.status = 'OCCUPIED';
      room.updatedAt = Date.now();
    }
  }
  db.patients.push(p);
  log(db, `Admin added patient ${name} — auto-assigned to ${doctor ? doctor.name : 'no doctor available'}${bed ? ', bed ' + bed.id : ''}`);
  save(db);
  res.json(p);
});

router.get('/me', requireRole('patient'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.user.profileId);
  if (!p) return res.status(404).json({ error: 'Patient record not found' });
  const doctor = db.doctors.find((d) => d.id === p.doctorId);
  res.json({ ...p, doctor: doctor ? { name: doctor.name, specialty: doctor.specialty } : null });
});

router.get('/:id', requireRole('admin', 'doctor', 'nurse'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

router.patch('/:id/vitals', requireRole('doctor', 'nurse'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.vitals = { ...p.vitals, ...req.body };
  const prevRisk = p.riskLevel;
  p.riskLevel = computeRisk(p.vitals);
  p.timeline.unshift({
    time: new Date().toLocaleString(),
    event: `Vitals updated — HR ${p.vitals.hr}, SpO2 ${p.vitals.spo2}%, RR ${p.vitals.rr}, BP ${p.vitals.bp}`,
  });
  if (prevRisk !== p.riskLevel) {
    log(db, `Patient ${p.name} risk changed ${prevRisk} -> ${p.riskLevel}`);
    p.timeline.unshift({ time: new Date().toLocaleString(), event: `Risk level changed to ${p.riskLevel}` });
  }
  save(db);
  res.json(p);
});

// A doctor, nurse or admin can flag/clear isolation precautions for a
// patient at any point during their stay. This is what decides whether
// their room gets a STANDARD or DEEP sanitation cycle at discharge. Staff
// never touch this flag — it's a clinical judgment call, not a cleaning one.
router.patch('/:id/isolation', requireRole('doctor', 'nurse', 'admin'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.isolationPrecaution = !!req.body.isolationPrecaution;
  p.timeline.unshift({
    time: new Date().toLocaleString(),
    event: p.isolationPrecaution ? 'Isolation precautions flagged' : 'Isolation precautions cleared',
  });
  log(db, `${req.user.name} ${p.isolationPrecaution ? 'flagged' : 'cleared'} isolation precautions for ${p.name}`);
  save(db);
  res.json(p);
});

// Discharge queues the room for sanitation with the correct cycle type
// (DEEP when isolation precautions were in effect, STANDARD otherwise).
// From here on, only sanitation staff can claim, work and release the room
// (see routes/rooms.js) — this route just hands it off to them. A short
// fallback timer auto-dispatches a virtual housekeeping crew if no real
// staff member claims the room in time, so nothing sits unattended; any
// real staff claim immediately takes precedence over that fallback.
router.patch('/:id/discharge', requireRole('doctor', 'admin'), (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.dischargedAt) return res.status(400).json({ error: 'Already discharged' });

  p.dischargedAt = Date.now();
  p.timeline.unshift({ time: new Date().toLocaleString(), event: 'Discharged from hospital' });

  const bedId = p.bedId;
  const bed = db.beds.find((b) => b.id === bedId);
  const room = db.rooms.find((r) => r.id === bedId);
  const cycleType = p.isolationPrecaution ? 'DEEP' : 'STANDARD';
  if (bed) bed.status = 'cleaning';
  if (room) {
    room.status = 'PENDING';
    room.cycleType = cycleType;
    room.checklist = [];
    room.assignedStaffId = null;
    room.assignedStaffName = null;
    room.startedAt = null;
    room.lastPatientId = p.id;
    room.updatedAt = Date.now();
    room.history = [{
      time: new Date().toLocaleString(),
      event: `Queued for a ${cycleType.toLowerCase()} sanitation cycle after ${p.name}'s discharge`,
    }];
  }
  const doctor = db.doctors.find((d) => d.id === p.doctorId);
  if (doctor) doctor.patientIds = doctor.patientIds.filter((id) => id !== p.id);

  log(
    db,
    `Patient ${p.name} discharged — room ${bedId} queued for ${cycleType.toLowerCase()} sanitation` +
      (p.isolationPrecaution ? ' (isolation precautions)' : '')
  );
  save(db);

  if (bedId) {
    setTimeout(() => {
      const db2 = load();
      const r2 = db2.rooms.find((r) => r.id === bedId);
      if (r2 && r2.status === 'PENDING') {
        r2.status = 'ASSIGNED';
        r2.assignedStaffId = 'SYSTEM';
        r2.assignedStaffName = 'Housekeeping (auto-dispatch)';
        r2.checklist = buildChecklist(r2.cycleType || 'STANDARD');
        r2.startedAt = Date.now();
        r2.updatedAt = Date.now();
        r2.history = r2.history || [];
        r2.history.push({ time: new Date().toLocaleString(), event: 'No staff claimed in time — auto-dispatched to on-call housekeeping' });
        log(db2, `Room ${bedId} — sanitation crew automatically dispatched`);
        save(db2);
      }
    }, 8000);

    setTimeout(() => {
      const db3 = load();
      const r3 = db3.rooms.find((r) => r.id === bedId);
      const b3 = db3.beds.find((b) => b.id === bedId);
      // Only auto-complete the auto-dispatched fallback crew's own cycle —
      // if a real staff member claimed the room, it's theirs to finish.
      if (r3 && r3.assignedStaffId === 'SYSTEM' && r3.status !== 'READY') {
        (r3.checklist || []).forEach((c) => { c.done = true; c.doneBy = r3.assignedStaffName; c.doneAt = Date.now(); });
        const durationMin = r3.startedAt ? Math.round((Date.now() - r3.startedAt) / 60000) : null;
        r3.status = 'READY';
        r3.history.push({ time: new Date().toLocaleString(), event: 'Auto-dispatch cleaning completed & room released' });
        db3.sanitationLog = db3.sanitationLog || [];
        db3.sanitationLog.unshift({
          id: 'SAN-' + Date.now(),
          roomId: r3.id,
          ward: r3.ward,
          cycleType: r3.cycleType,
          staffName: r3.assignedStaffName,
          startedAt: r3.startedAt,
          completedAt: Date.now(),
          durationMin,
        });
        r3.assignedStaffId = null;
        r3.assignedStaffName = null;
        if (b3) { b3.status = 'available'; b3.patientId = null; }
        log(db3, `Room ${bedId} sanitized and automatically released back to admissions`);
        save(db3);
      }
    }, 20000);
  }

  res.json(p);
});

module.exports = router;
