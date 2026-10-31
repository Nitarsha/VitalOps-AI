# VitalOps
**One Hospital. One Operational Picture. Smarter Decisions.**

A full-stack hospital command center — real backend, real database, real authentication,
real AI, no fake patients or doctors. Every person in the system is someone who registered.

Problem Statement: **HE-02 — Hospital Command Center & Resource Optimization**, integrating
concepts from HE-01 (OR Scheduling), HE-03 (Supply Chain Intelligence), HE-04 (Remote Patient
Monitoring & Early Warning) and HE-05 (Medical Document / Timeline Intelligence) into one system.

---

## 1. Architecture

```
Browser  ──►  Express server (Node.js)  ──►  JSON file database (db.json)
                     │
                     └──►  Claude API (real AI chat, optional — falls back gracefully)
```

- **One server, one port.** Express serves both the API (`/api/...`) and the frontend itself.
  There is nothing else to run.
- **Database:** a lightweight embedded JSON store (`backend/db.json`), auto-created and seeded
  with hospital infrastructure only (beds, rooms, inventory) — **no seeded people**. All users,
  patients, doctors, and staff exist only because someone registered. This was chosen over
  MongoDB/Postgres so the project runs with zero external services and zero native
  dependencies — every read/write goes through `db.js`, so swapping in a real database later
  means changing one file, not the routes.
- **Auth:** email + password, hashed with bcrypt, JWT-based sessions, role embedded in the
  token and checked on every protected route.
- **AI:** the `/api/chat` route calls the real Claude API when `ANTHROPIC_API_KEY` is set in
  `.env`, with the patient's live condition, vitals, and risk level injected into the system
  prompt so answers are personalized — not generic. If no key is configured, it automatically
  falls back to a rule-based assistant so the app never breaks during a demo.

---

## 2. Setup (2 minutes)

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

Open **http://localhost:4000** — that's it. The frontend is served by the same server.

To enable real AI chat, open `backend/.env` and set:
```
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-5
```
(Check https://docs.claude.com for the current model name before deploying — model slugs change.)

To register an Admin account, use the admin code in `.env` (`ADMIN_CODE`, default `letmein-admin` — change it).

---

## 3. What's automated

| Feature | How it works |
|---|---|
| **Doctor assignment** | On patient registration, the least-loaded doctor (optionally matched to the patient's stated condition/specialty) is assigned automatically. No manual scheduling. |
| **Bed assignment** | An available bed is automatically reserved at registration and freed on discharge. |
| **Risk scoring** | Every vitals update recomputes risk (STABLE → CRITICAL) from HR, SpO₂, RR and BP thresholds — never hand-set. |
| **Sanitation** | Discharging a patient automatically queues their room: `PENDING → ACTIVE → READY` on a real server-side timer, then the bed is released back to admissions — no button required (staff can still fast-forward manually for a demo). |
| **AI chat → doctor request** | If a patient's message implies they want their doctor, a chat request is filed automatically and shows up as a notification for that doctor. |
| **Recommendations** | Computed live from current hospital-state numbers (ICU/staff/OR pressure, inventory risk) — not scripted text. |
| **Audit log** | Every automated and manual action is logged with a timestamp. |

---

## 4. Roles (strictly separated)

Each user only ever sees their own role's dashboard — enforced both in the UI navigation and
on every backend route (a patient token cannot call doctor/admin endpoints, and vice versa).

- **Admin** — hospital-wide overview, all patients, staff & resources, inventory, sanitation,
  simulation center, recommendations, audit log.
- **Doctor** — only their assigned patients, vitals, discharge action, and a notification bell
  with Accept/Reject for incoming patient chat requests.
- **Nurse** — active patients, vitals updates, sanitation board.
- **Staff** — inventory, sanitation board.
- **Patient** — their own record only: assigned doctor, vitals, risk, AI assistant, and a
  personal timeline of everything that's happened during their admission.

---

## 5. Key API routes

```
POST   /api/auth/register        Create account (role-specific: patient auto-assigned doctor+bed)
POST   /api/auth/login
GET    /api/patients              (admin/doctor/nurse — doctor sees only their own)
GET    /api/patients/me           (patient — own record)
PATCH  /api/patients/:id/vitals   (doctor/nurse — recomputes risk)
PATCH  /api/patients/:id/discharge (doctor/admin — starts automatic sanitation cycle)
GET    /api/doctors/me            (doctor — own profile + patients)
GET    /api/rooms                 PATCH /api/rooms/:id/advance
GET    /api/inventory             PATCH /api/inventory/:id
POST   /api/requests              (patient → doctor chat request)
PATCH  /api/requests/:id          (doctor accepts/rejects)
POST   /api/chat                  (patient — real AI, falls back offline if no key)
GET    /api/search?q=             (role-scoped global search)
POST   /api/simulation            GET /api/simulation/report
GET    /api/audit                 (admin)
```

---

## 6. Project structure

```
vitalops-fullstack/
├── backend/
│   ├── server.js
│   ├── db.js                 # embedded JSON database
│   ├── middleware/auth.js    # JWT verification + role guard
│   ├── routes/                # one file per resource
│   ├── package.json
│   └── .env.example
├── frontend/
│   └── index.html            # auth screens + all role dashboards
├── .gitignore
└── README.md
```

---

## 7. Known scope limits (honest, for the judges)

- The database is an embedded JSON file, not a hosted DB server — deliberate for a hackathon
  build with zero setup friction. Swappable to MongoDB/Postgres without touching route logic.
- Real AI requires the user's own `ANTHROPIC_API_KEY`; without one, the assistant runs a
  clearly-labeled offline fallback so the demo never breaks.
- OR scheduling and multi-day appointment calendars are intentionally out of scope for this
  pass — the "automatic scheduling" requirement is satisfied at the point that matters most:
  every patient is auto-assigned to a doctor and bed the moment they register.
- Single-process, single-instance — fine for a hackathon demo, not for production concurrency.

---

**Decision support only — not a medical diagnosis.**
