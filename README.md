# Pulse RCM — Revenue Cycle Analytics Platform

A multi-tenant SaaS platform for healthcare revenue-cycle management. Billing teams track every claim, work every denial through an appeal pipeline, and watch A/R shrink. Built with React, Node.js, Express, and SQLite.

## Screenshots

| Login | Dashboard |
|-------|-----------|
| ![Login](rcm-login.png) | ![Dashboard](rcm-dash2.png) |

| Denial Appeals Queue | Appeal Detail |
|-------|-----------|
| ![Denials](rcm-denials.png) | ![Appeal](rcm-appeal-drawer.png) |

| Team Management |
|-------|
| ![Team](rcm-team.png) |

## Features

### Dashboard
- **KPI cards** — Total billed, collected, outstanding A/R, avg days in A/R, clean claim rate, denial rate
- **Appeal pipeline strip** — Open / In Progress / Submitted / Won / Lost counts + win rate
- **Follow-up alerts** — Banner + sidebar badge for overdue appeal follow-ups
- **Charts** — Billed vs collected, A/R aging buckets, denials by reason, payer mix, collection trend

### Claims
- Searchable, filterable, paginated claims table
- **Full CRUD** — Add via form, edit inline, delete with confirmation
- **CSV bulk upload** — Per-row validation with detailed skip report + downloadable template

### Denial Appeals (the money feature)
- **Work queue** — Open / Assigned to me / Unassigned / Closed tabs, priority-sorted
- **Appeal detail drawer** — Status pipeline (open → in progress → submitted → won/lost), assign to team, priority, follow-up dates
- **Activity timeline** — Every note timestamped with author
- **Smart outcomes** — Marking an appeal "won" auto-marks the claim paid; "lost" keeps it denied
- **Unworked denials** — One-click to open appeals for denied claims, sorted by dollars at stake

### Multi-tenancy & Team
- **Organizations** — Each company's data fully isolated (every query org-scoped)
- **Auth** — JWT sessions, bcrypt password hashing
- **Roles** — Owner (full access) / Biller (manage data) / Viewer (read-only)
- **Team management** — Invite members, change roles, remove (owners only)

## Tech Stack

| Layer    | Tech                                                        |
|----------|-------------------------------------------------------------|
| Frontend | React 18, Vite, Tailwind CSS, Recharts, Inter font          |
| Backend  | Node.js, Express, node:sqlite (zero native deps)            |
| Auth     | JWT (jsonwebtoken) + bcryptjs                               |
| Upload   | multer + csv-parse                                          |

## Quick Start

```bash
# Backend
cd server
npm install
npm start          # auto-seeds demo org on first run → http://localhost:4000

# Frontend (dev)
cd client
npm install
npm run dev        # http://localhost:5173 (proxies /api)
```

**Demo login:** `demo@pulsercm.com` / `demo1234`

Or create your own workspace via **Create an account** — each signup gets an isolated organization with default payers.

## Production

```bash
cd client && npm install && npm run build
cd ../server && npm install && JWT_SECRET=your-secret-here npm start
# App at http://localhost:4000 (API + static frontend)
```

### Docker

```bash
docker compose up --build
```

### Environment Variables

| Variable     | Required | Description                              |
|--------------|----------|------------------------------------------|
| `PORT`       | No       | Default 4000                             |
| `JWT_SECRET` | **Yes**  | Secret for signing auth tokens           |
| `DB_PATH`    | No       | SQLite file path (default `server/rcm.db`) |
| `NODE_ENV`   | No       | Set `production` for deployments         |

### Deploy (free)

1. Push to GitHub
2. [Render](https://render.com) → New Web Service → connect repo
   - Build: `cd client && npm install && npm run build && cd ../server && npm install`
   - Start: `cd server && npm start`
   - Env: `JWT_SECRET` = random 32+ char string
3. Done — public URL issued

## API Reference

### Auth (`/api/auth`)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/signup` | POST | Create org + owner account → `{ token, user }` |
| `/login` | POST | → `{ token, user }` |
| `/me` | GET | Current user (auth) |
| `/team` | GET | List team members (auth) |
| `/team` | POST | Invite member (owner) |
| `/team/:id` | PUT | Change role (owner) |
| `/team/:id` | DELETE | Remove member (owner) |

### Analytics (`/api/analytics`) — all require auth
| Endpoint | Description |
|----------|-------------|
| `/kpis` | KPI cards + open appeal count |
| `/ar-aging` | A/R by aging bucket |
| `/revenue-trend` | Monthly billed vs collected |
| `/denials-by-reason` | Denial counts by reason |
| `/payer-mix` | Billed/collected per payer |
| `/appeal-stats` | Appeal funnel counts + win rate |

### Claims (`/api/claims`) — all require auth
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Paginated (`?search=&status=&payer=&page=&limit=`) |
| `/` | POST | Create (owner/biller) |
| `/:id` | GET/PUT/DELETE | Read / update / delete (write: owner/biller) |
| `/upload/csv` | POST | Bulk CSV import (owner/biller) |
| `/template/csv` | GET | CSV template download |
| `/meta/payers` | GET | Payer list |

### Appeals (`/api/appeals`) — all require auth
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Work queue (`?status=&assignee=me/unassigned/:id&priority=`) |
| `/` | POST | Open appeal for a denied claim (owner/biller) |
| `/unworked-denials` | GET | Denied claims without appeals |
| `/due` | GET | Follow-ups due today or overdue |
| `/:id` | GET/PUT/DELETE | Detail + notes / update / delete |
| `/:id/notes` | POST | Add timeline note |

## Data Model

```
orgs → users (org_id, role: owner/biller/viewer)
     → payers (org_id)
     → claims (org_id, payer_id, status, denial_reason…)
     → appeals (org_id, claim_id, assigned_to, status, priority, follow_up_date)
        → appeal_notes (appeal_id, user_id, note)
```

## Security Notes

- All data endpoints require JWT auth; every query is org-scoped
- Passwords hashed with bcrypt (10 rounds)
- Role enforcement on write operations and team management
- **Before handling real PHI:** set a strong `JWT_SECRET`, enable HTTPS, encrypt the database volume, sign BAAs with your host — this demo ships with a dev default

## Project Structure

```
rcm-dashboard/
├── client/src/
│   ├── auth.jsx            # Auth context + token management
│   ├── api.js              # API client (auto auth header)
│   ├── components/
│   │   ├── Shell.jsx       # Sidebar app shell
│   │   └── ui.jsx          # Toast, Modal, Skeleton, EmptyState, PageHeader
│   └── pages/
│       ├── AuthPages.jsx   # Login / Signup
│       ├── Dashboard.jsx   # KPIs, pipeline, charts
│       ├── Claims.jsx      # Claims CRUD + CSV
│       ├── Denials.jsx     # Appeal work queue + drawer
│       └── Team.jsx        # Team management
├── server/src/
│   ├── db.js               # SQLite schema + migrations
│   ├── auth.js             # JWT middleware + role guard
│   ├── seed.js             # Demo org, users, 600 claims, 24 appeals
│   └── routes/             # auth, analytics, claims, appeals
├── Dockerfile
├── docker-compose.yml
└── README.md
```
