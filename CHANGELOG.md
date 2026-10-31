# VitalOps Update — Sanitation Overhaul & Multi-Role Features

## Sanitation cycle (now accurate & staff-only)
- Real multi-stage cycle: `PENDING → ASSIGNED → IN_PROGRESS → QC_REVIEW → READY`, replacing the old two-timer demo cycle.
- Two checklist templates — `STANDARD` (4 tasks) and `DEEP` (7 tasks, terminal disinfection / PPE / UV-C) — chosen automatically from the discharged patient's isolation-precaution flag.
- **Only the `staff` role can claim a room, check off tasks, or advance/release it** (`backend/routes/rooms.js`). Admin, nurse and doctor now have read-only visibility into sanitation status — the "Advance manually" button available to everyone before has been removed for those roles.
- A room cannot be released back to admissions unless every checklist item is complete — enforced server-side, not just in the UI.
- Doctors/nurses/admin can flag a queued room for a deep clean; only staff perform the clean itself.
- A background fallback still auto-dispatches a virtual housekeeping crew if no staff member claims a room in time (keeps the original demo self-running), but any real staff claim immediately takes over.
- New admin-only sanitation performance report: completed cycles, average cycle time, deep-clean count, per-staff cycle counts.

## New: isolation precaution flag on patients
- Settable at registration/admission and toggleable anytime by doctor/nurse/admin (`PATCH /api/patients/:id/isolation`).
- Drives which sanitation cycle type (`STANDARD`/`DEEP`) a patient's room gets at discharge.

## New multi-function features for nurses
- **Care Tasks** (`/api/tasks`) — nurses/doctors create short-cycle nursing to-dos per patient (meds, observations) and mark them done.
- **Shift Handoff Notes** (`/api/tasks/handoff/notes`) — nurses leave ward notes for the next shift; visible to nurse/doctor/admin.
- Nurses can still view/update vitals and the patient roster exactly as before.

## New multi-function features for staff
- **Sanitation** is now staff's primary, actionable workflow (claim → checklist → QC → release).
- **Maintenance Requests** (`/api/maintenance`) — any role can report a facility issue; only staff resolve it, mirroring the sanitation separation of duties.
- Inventory management is unchanged.

## Backward compatibility
- `backend/db.js` migration backfills all new fields (`isolationPrecaution`, room `cycleType`/`checklist`/`assignedStaff*`/`history`, and new collections) on any existing `db.json`, so upgrading an already-running deployment won't break it.
- All previously existing routes, roles, and views behave the same unless explicitly called out above.
