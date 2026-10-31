const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const SCENARIOS = {
  'Emergency Surge': {
    delta: { icuPressure: 12, staffPressure: 14, orPressure: 18, invPressure: 9, emergencyPatients: 25, criticalPatients: 3 },
    description: 'A sudden wave of trauma and ER admissions hits every department at once.',
  },
  'ICU Bed Shortage': {
    delta: { icuPressure: 14, staffPressure: 8, orPressure: 4, invPressure: 3, emergencyPatients: 4, criticalPatients: 2 },
    description: 'ICU capacity tightens sharply as demand for critical-care beds outpaces supply.',
  },
  'Doctor Shortage': {
    delta: { icuPressure: 3, staffPressure: 19, orPressure: 15, invPressure: 1, emergencyPatients: 3, criticalPatients: 0 },
    description: 'Several doctors become unexpectedly unavailable, thinning coverage across active cases.',
  },
  'Nurse Shortage': {
    delta: { icuPressure: 4, staffPressure: 22, orPressure: 6, invPressure: 2, emergencyPatients: 2, criticalPatients: 0 },
    description: 'Nursing coverage drops below comfortable levels, raising the load on remaining staff.',
  },
  'Equipment Failure': {
    delta: { icuPressure: 8, staffPressure: 7, orPressure: 12, invPressure: 8, emergencyPatients: 2, criticalPatients: 1 },
    description: 'Critical equipment goes offline, disrupting OR readiness and routine procedures.',
  },
};

router.get('/scenarios', (req, res) =>
  res.json(Object.entries(SCENARIOS).map(([name, s]) => ({ name, description: s.description })))
);

router.post('/', requireRole('admin'), (req, res) => {
  const db = load();
  const name = req.body.scenario;
  const delta = SCENARIOS[name] && SCENARIOS[name].delta;
  if (!delta) return res.status(400).json({ error: 'Unknown scenario' });
  const before = { ...db.hospitalState };
  Object.keys(delta).forEach((k) => {
    db.hospitalState[k] = Math.max(0, Math.min(99, (db.hospitalState[k] || 0) + delta[k]));
  });
  log(db, `Simulation run: ${name}`);
  save(db);
  res.json({ before, after: db.hospitalState, scenario: name });
});

router.get('/report', requireRole('admin'), (req, res) => {
  const db = load();
  const active = db.patients.filter((p) => !p.dischargedAt);
  const riskCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, STABLE: 0 };
  active.forEach((p) => (riskCounts[p.riskLevel] = (riskCounts[p.riskLevel] || 0) + 1));
  const stockoutRiskItems = db.inventory.filter((i) => i.stock / i.dailyUsage < i.leadTimeDays).map((i) => i.name);
  const roomsInSanitation = db.rooms.filter((r) => r.status !== 'READY').length;

  res.json({
    generatedAt: new Date().toLocaleString(),
    totalPatients: active.length,
    riskCounts,
    hospitalState: db.hospitalState,
    stockoutRiskItems,
    roomsInSanitation,
    totalDoctors: db.doctors.length,
    totalStaff: db.staffUsers.length,
    bedsAvailable: db.beds.filter((b) => b.status === 'available').length,
    bedsTotal: db.beds.length,
  });
});

module.exports = router;
