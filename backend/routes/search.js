const express = require('express');
const { load } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', (req, res) => {
  const db = load();
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const role = req.user.role;
  const results = [];

  if (['admin', 'doctor', 'nurse'].includes(role)) {
    db.patients
      .filter((p) => !p.dischargedAt)
      .forEach((p) => {
        if (role === 'doctor' && p.doctorId !== req.user.profileId) return;
        if (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) {
          results.push({ label: p.name, sub: `${p.id} · Risk ${p.riskLevel} · Bed ${p.bedId || '—'}`, tag: 'Patient', type: 'patient', id: p.id });
        }
      });
  }
  if (role === 'admin') {
    db.doctors.forEach((d) => {
      if (d.name.toLowerCase().includes(q)) results.push({ label: d.name, sub: d.specialty, tag: 'Doctor', type: 'doctor', id: d.id });
    });
    db.staffUsers.forEach((s) => {
      if (s.name.toLowerCase().includes(q)) results.push({ label: s.name, sub: `${s.role} · ${s.dept}`, tag: 'Staff', type: 'staff', id: s.id });
    });
  }
  if (['admin', 'staff'].includes(role)) {
    db.inventory.forEach((i) => {
      if (i.name.toLowerCase().includes(q)) results.push({ label: i.name, sub: `Stock ${i.stock}`, tag: 'Inventory', type: 'inventory', id: i.id });
    });
  }
  if (['admin', 'nurse', 'staff'].includes(role)) {
    db.rooms.forEach((r) => {
      if (r.id.toLowerCase().includes(q)) results.push({ label: r.id, sub: `${r.ward} · ${r.status}`, tag: 'Room', type: 'room', id: r.id });
    });
  }
  res.json(results.slice(0, 10));
});

module.exports = router;
