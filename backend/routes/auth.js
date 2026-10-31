const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { load, save, log } = require('../db');

const router = express.Router();

// Simple, transparent risk scoring — used every time vitals change too,
// so risk levels are always computed live, never hand-typed.
function computeRisk(v) {
  let score = 0;
  if (v.spo2 < 92) score += 2;
  else if (v.spo2 < 95) score += 1;
  if (v.hr > 110 || v.hr < 50) score += 1;
  if (v.rr > 24) score += 1;
  const sys = Number((v.bp || '120/80').split('/')[0]);
  if (sys < 95) score += 1;
  if (score >= 3) return 'CRITICAL';
  if (score === 2) return 'HIGH';
  if (score === 1) return 'MEDIUM';
  return 'STABLE';
}

function assignDoctor(db, specialtyHint) {
  if (!db.doctors.length) return null;
  let pool = db.doctors;
  if (specialtyHint) {
    const match = db.doctors.filter((d) => d.specialty.toLowerCase() === String(specialtyHint).toLowerCase());
    if (match.length) pool = match;
  }
  pool = [...pool].sort((a, b) => a.patientIds.length - b.patientIds.length);
  return pool[0];
}

function assignBed(db, wardHint) {
  let pool = db.beds.filter((b) => b.status === 'available');
  if (wardHint) {
    const match = pool.filter((b) => b.ward.toLowerCase() === String(wardHint).toLowerCase());
    if (match.length) pool = match;
  }
  return pool[0] || null;
}

router.post('/register', (req, res) => {
  const db = load();
  const { name, email, password, role, age, gender, condition, specialty, dept, adminCode, isolationPrecaution } = req.body;

  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Missing required fields' });
  if (db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()))
    return res.status(400).json({ error: 'An account with this email already exists' });
  if (role === 'admin' && adminCode !== (process.env.ADMIN_CODE || 'letmein-admin'))
    return res.status(403).json({ error: 'Invalid admin code' });
  if (!['admin', 'doctor', 'nurse', 'staff', 'patient'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const user = { id: 'U-' + Date.now(), name, email, passwordHash, role, createdAt: Date.now() };
  db.users.push(user);

  let profile = null;

  if (role === 'doctor') {
    profile = { id: 'DR-' + Date.now(), userId: user.id, name, specialty: specialty || 'General Medicine', patientIds: [] };
    db.doctors.push(profile);
    log(db, `Doctor ${name} joined the roster (${profile.specialty})`);
  } else if (role === 'nurse' || role === 'staff') {
    profile = { id: 'ST-' + Date.now(), userId: user.id, name, role, dept: dept || 'General' };
    db.staffUsers.push(profile);
    log(db, `${role === 'nurse' ? 'Nurse' : 'Staff'} ${name} joined (${profile.dept})`);
  } else if (role === 'patient') {
    const doctor = assignDoctor(db, condition);
    const bed = assignBed(db);
    const vitals = { hr: 82, spo2: 97, bp: '118/78', rr: 18 };
    profile = {
      id: 'P-' + Date.now(),
      userId: user.id,
      name,
      age: Number(age) || 30,
      gender: gender || 'Unspecified',
      condition: condition || 'General observation',
      riskLevel: computeRisk(vitals),
      isolationPrecaution: !!isolationPrecaution,
      doctorId: doctor ? doctor.id : null,
      bedId: bed ? bed.id : null,
      vitals,
      admittedAt: Date.now(),
      dischargedAt: null,
      timeline: [{ time: new Date().toLocaleString(), event: 'Admitted to hospital' }],
      chatHistory: [],
    };
    if (doctor) doctor.patientIds.push(profile.id);
    if (bed) {
      bed.status = 'occupied';
      bed.patientId = profile.id;
      const room = db.rooms.find((r) => r.id === bed.id);
      if (room) {
        room.status = 'OCCUPIED';
        room.updatedAt = Date.now();
      }
    }
    db.patients.push(profile);
    log(
      db,
      `Patient ${name} registered — auto-assigned to ${doctor ? doctor.name : 'no doctor available yet'}${
        bed ? ', bed ' + bed.id : ' (no bed available)'
      }`
    );
  }
  // admin role: user record only, no separate profile needed

  save(db);
  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.name, profileId: profile ? profile.id : null },
    process.env.JWT_SECRET || 'dev_secret_change_me',
    { expiresIn: '12h' }
  );
  res.json({ token, user: { id: user.id, name: user.name, role: user.role }, profile });
});

router.post('/login', (req, res) => {
  const db = load();
  const { email, password } = req.body;
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash))
    return res.status(401).json({ error: 'Invalid email or password' });

  let profile = null;
  if (user.role === 'doctor') profile = db.doctors.find((d) => d.userId === user.id);
  else if (user.role === 'nurse' || user.role === 'staff') profile = db.staffUsers.find((s) => s.userId === user.id);
  else if (user.role === 'patient') profile = db.patients.find((p) => p.userId === user.id);

  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.name, profileId: profile ? profile.id : null },
    process.env.JWT_SECRET || 'dev_secret_change_me',
    { expiresIn: '12h' }
  );
  res.json({ token, user: { id: user.id, name: user.name, role: user.role }, profile });
});

module.exports = { router, computeRisk };
