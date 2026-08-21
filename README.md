# Quay 1 — Crew App

Mobile-first PWA + admin web dashboard for Quay 1 office & sales staff.
Replaces Connecteam; backed by Supabase (Postgres + Auth + Edge Functions).

> Note: this app began on a Google Apps Script + Google Sheet backend and has
> since migrated to Supabase (project `dqszbqiimbfvmmnpgpsb`). The `apps_script/`
> folder is retained as legacy reference only; the live backend is Supabase.

Two surfaces, one backend:

- **`/` (PWA)** — each staff member installs to their phone, logs in once
  with a 4-digit PIN, then has Home / Timesheet / Leave / Team.
- **`/admin/`** — desktop dashboard for office managers: who's working now,
  approve leave, weekly timesheets, staff directory, locations.

---

## How it works

```
Phone PWA  ─┐
            │  supabase-js (REST/RPC) + Edge Functions
Admin Web  ─┴────► Supabase
                     │
                     ▼
        Postgres (staff · shifts/events · leave · locations)
        Auth (session)  ·  Edge Functions (admin-create-staff, admin-set-pin)
```

- Frontend: vanilla HTML/CSS/JS, install-to-homescreen PWA, offline shell.
- Backend/Storage: Supabase Postgres, accessed via the supabase-js client
  (`quay-data.js`) with the public anon key + RLS. Privileged admin actions
  (create staff, set PIN) go through Edge Functions in `supabase/functions/`.
- Auth: Supabase session; per-user 4-digit PIN. Admin PIN unlocks the admin
  dashboard.

---

## Setup (~10 minutes, one-time)

1. **Backend** — a Supabase project (Postgres + Auth) with the `staff`,
   shift/event, leave and location tables, plus the `admin-create-staff` and
   `admin-set-pin` Edge Functions in `supabase/functions/`.
2. **Wire the config** into `quay-config.js` (`SUPABASE_URL`,
   `SUPABASE_ANON_KEY` — the public anon key is safe in the client; RLS
   enforces access).
3. **Staff** — add staff rows (name, role, team, pin, weekly_hours,
   salary_type, allowed_sites…) via the admin dashboard, which calls the
   `admin-create-staff` Edge Function.
4. **Deploy** — push to GitHub. Pages auto-serves at the repo URL.

---

## Day-to-day

### Staff (PWA)
- Install to home screen on first use.
- Open → enter PIN → stays signed in.
- **Home** — big yellow CLOCK IN dial. Tapping it opens a note sheet
  ("what are you working on?") — the note is *required* to clock in.
- **Timesheet** — week bars + shift entries. Tap CSV to download.
- **Leave** — annual / sick / family balances, request time off, see status.
- **Team** — live "who's working now" across the office.

### Manager (admin web)
- Visit `/admin/` → enter admin PIN.
- **Dashboard** — 4 stat cards, who's-on-now table, pending approvals
  with working Approve / Decline, team-hours chart.
- **Timesheets** — weekly hours per employee, per-row approve.
- **Leave** — full request table.
- **Team** — staff directory.
- **Locations** — office geofences.
- Every view has a CSV export.

---

## Integration into `quay-dashboard-v2`

The performance dashboard's **Work Time** tab currently estimates clocked
time as `dialler / 0.85`. Once this clock app is in regular use, a fetcher
script in that repo reads the `summary` action from Apps Script and
replaces the estimate with real per-agent hours. See the
quay-dashboard-v2 README for that wiring.

---

## File map

```
index.html         PWA shell
styles.css         Signal-language brand styles
quay-config.js     Supabase URL + anon key
quay-data.js       Supabase data layer (supabase-js client, queries, RPC)
app.js             PWA state machine + 4 tabs
manifest.json      PWA install metadata
sw.js              Service worker (offline shell, network-first API)
admin/             Admin web dashboard
  index.html
  admin.js
  admin.css
supabase/
  functions/
    admin-create-staff   Edge Function: create a staff row
    admin-set-pin        Edge Function: set/reset a staff PIN
assets/            Logo + brand assets
icons/             192px / 512px launcher icons
apps_script/       LEGACY — original Google Sheet backend, no longer live
  Code.gs
  SETUP.md
```

---

## Trade-offs vs Connecteam

| | Connecteam (free) | This app |
|---|---|---|
| Cost | Free | Free |
| Clock in/out | ✅ | ✅ |
| Required shift note | ❌ | ✅ |
| Per-user timesheet | Limited | ✅ |
| Leave requests + admin approve | ❌ on free | ✅ |
| Live team view | ❌ on free | ✅ |
| Admin dashboard | ❌ on free | ✅ |
| Data export | ❌ (paywall) | ✅ (CSV + your Supabase database) |
| Dashboard integration | ❌ | ✅ (planned) |
| Geofence | ❌ on free | UI placeholder; not enforced yet |
| Native apps in stores | ✅ | PWA only (good enough on iOS 16+ / Android) |

---

*Built 2026-06-05 · Signal language rebuild 2026-06-07*
