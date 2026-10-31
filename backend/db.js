// Lightweight embedded JSON database.
// Chosen deliberately for a hackathon build: zero native compilation,
// zero external database server to install, works everywhere Node runs.
// Swap-ready: every read/write goes through load()/save() below, so this
// can be replaced with MongoDB/Postgres later without touching route logic.

const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'db.json');

// Sanitation checklist templates. STANDARD covers a routine bed turnover;
// DEEP is used whenever the discharged patient required isolation
// precautions (or staff/clinical escalation flags the room afterward) and
// adds terminal-disinfection steps a normal turnover doesn't need.
const CHECKLISTS = {
  STANDARD: [
    'Strip and replace all bedding',
    'Disinfect bed rails, surfaces & bedside table',
    'Mop and disinfect floor',
    'Restock room supplies (gloves, linens, wipes)',
  ],
  DEEP: [
    'Don full PPE for isolation cleaning',
    'Bag and remove contaminated linens & waste',
    'Terminal disinfection of all high-touch surfaces',
    'Disinfect and decontaminate medical equipment',
    'Run UV-C or fogging disinfection cycle',
    'Air out room and remove isolation signage',
    'Restock room supplies & restock PPE station',
  ],
};

function buildChecklist(type) {
  return (CHECKLISTS[type] || CHECKLISTS.STANDARD).map((label, i) => ({
    id: 'C' + (i + 1),
    label,
    done: false,
    doneBy: null,
    doneAt: null,
  }));
}

function seed() {
  const wards = [
    ['ICU', 6],
    ['General', 8],
    ['Cardiology', 4],
    ['Emergency', 3],
    ['Surgery', 3],
  ];
  const beds = [];
  const rooms = [];
  wards.forEach(([ward, count]) => {
    for (let i = 1; i <= count; i++) {
      const id = ward.slice(0, 3).toUpperCase() + '-' + String(i).padStart(2, '0');
      beds.push({ id, ward, status: 'available', patientId: null });
      rooms.push({
        id,
        ward,
        status: 'READY',
        cycleType: null,
        checklist: [],
        assignedStaffId: null,
        assignedStaffName: null,
        startedAt: null,
        lastPatientId: null,
        updatedAt: Date.now(),
        history: [],
      });
    }
  });

  const inventorySeed = [
    ['Ceftriaxone 1g', 240, 58, 5, 'HIGH'],
    ['Propofol 20ml', 410, 36, 4, 'HIGH'],
    ['Surgical Gloves (L)', 1860, 320, 3, 'MEDIUM'],
    ['N95 Respirator', 940, 180, 6, 'HIGH'],
    ['Paracetamol IV', 1120, 210, 2, 'LOW'],
    ['Cardiac Surgical Set', 14, 3, 9, 'HIGH'],
    ['Normal Saline 500ml', 2400, 390, 2, 'MEDIUM'],
    ['Adrenaline 1mg', 180, 22, 5, 'HIGH'],
    ['Insulin (Rapid)', 300, 40, 4, 'HIGH'],
    ['Amoxicillin 500mg', 860, 120, 3, 'MEDIUM'],
    ['Surgical Masks', 3000, 410, 2, 'LOW'],
    ['IV Cannula 18G', 1500, 260, 3, 'MEDIUM'],
    ['Morphine 10mg', 95, 14, 7, 'HIGH'],
    ['Blood Bag O-neg', 60, 9, 10, 'HIGH'],
    ['Wound Dressing Kit', 540, 70, 4, 'MEDIUM'],
  ];
  const inventory = inventorySeed.map(([name, stock, dailyUsage, leadTimeDays, criticality], i) => ({
    id: 'INV-' + (i + 1),
    name,
    stock,
    dailyUsage,
    leadTimeDays,
    criticality,
  }));

  return {
    users: [],
    patients: [],
    doctors: [],
    staffUsers: [],
    beds,
    rooms,
    inventory,
    requests: [],
    appointments: [],
    orSchedule: [],
    nursingTasks: [],
    shiftNotes: [],
    maintenanceRequests: [],
    sanitationLog: [],
    auditLog: [],
    hospitalState: {
      icuPressure: 62,
      staffPressure: 58,
      orPressure: 50,
      invPressure: 44,
      emergencyPatients: 0,
      criticalPatients: 0,
    },
  };
}

// Backfills fields added after this project's first release, so an existing
// db.json from an earlier version upgrades in place instead of breaking.
function migrate(db) {
  let changed = false;
  if (!db.appointments) { db.appointments = []; changed = true; }
  if (!db.orSchedule) { db.orSchedule = []; changed = true; }
  if (!db.nursingTasks) { db.nursingTasks = []; changed = true; }
  if (!db.shiftNotes) { db.shiftNotes = []; changed = true; }
  if (!db.maintenanceRequests) { db.maintenanceRequests = []; changed = true; }
  if (!db.sanitationLog) { db.sanitationLog = []; changed = true; }
  (db.rooms || []).forEach((r) => {
    if (r.status === 'ACTIVE') { r.status = 'IN_PROGRESS'; changed = true; }
    if (r.cycleType === undefined) { r.cycleType = null; changed = true; }
    if (r.checklist === undefined) { r.checklist = []; changed = true; }
    if (r.assignedStaffId === undefined) { r.assignedStaffId = null; changed = true; }
    if (r.assignedStaffName === undefined) { r.assignedStaffName = null; changed = true; }
    if (r.startedAt === undefined) { r.startedAt = null; changed = true; }
    if (r.history === undefined) { r.history = []; changed = true; }
  });
  (db.patients || []).forEach((p) => {
    if (p.isolationPrecaution === undefined) { p.isolationPrecaution = false; changed = true; }
  });
  return changed;
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(seed(), null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  if (migrate(db)) fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return db;
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function log(db, message) {
  db.auditLog.unshift({ id: 'A-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), time: new Date().toLocaleString(), message });
  db.auditLog = db.auditLog.slice(0, 300);
}

module.exports = { load, save, log, CHECKLISTS, buildChecklist };
