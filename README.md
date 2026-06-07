# Quay 1 — Crew App

Mobile-first PWA + admin web dashboard for Quay 1 office & sales staff.
Replaces Connecteam on the free tier; data lives in a Google Sheet you own.

Two surfaces, one backend:

- **`/` (PWA)** — each staff member installs to their phone, logs in once
  with a 4-digit PIN, then has Home / Timesheet / Leave / Team.
- **`/admin/`** — desktop dashboard for office managers: who's working now,
  approve leave, weekly timesheets, staff directory, locations.

---

## How it works

```
Phone PWA  ─┐
            │  POST { action, ... }   (text/plain to dodge CORS preflight)
Admin Web  ─┴────► Google Apps Script Web App
                     │
                     ▼
              Google Sheet (Quay Clock)
                Roster · Events · Leave · Locations
```

- Frontend: vanilla HTML/CSS/JS, install-to-homescreen PWA, offline shell.
- Backend: one Apps Script file (`apps_script/Code.gs`), deployed as a Web
  App. Free.
- Storage: one Google Sheet with four tabs.
- Auth: per-user 4-digit PIN. Admin PIN unlocks the admin dashboard.

---

## Setup (~10 minutes, one-time)

1. **Backend** — follow [`apps_script/SETUP.md`](apps_script/SETUP.md):
   create the sheet, paste the script, deploy as a Web App, copy the URL.
2. **Wire the URL** into `app.js` (`APPS_SCRIPT_URL` constant) and into
   `admin/admin.js` (`APPS_SCRIPT_URL` constant).
3. **Roster** — fill in the `Roster` tab (id, name, role, team, email,
   pin, active, admin).
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
app.js             PWA state machine + 4 tabs
manifest.json      PWA install metadata
sw.js              Service worker (offline shell, network-first API)
admin/             Admin web dashboard
  index.html
  admin.js
  admin.css
assets/            Logo + brand assets
icons/             192px / 512px launcher icons
apps_script/
  Code.gs          v2 backend (paste into the Apps Script editor)
  SETUP.md         5-minute deployment guide
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
| Data export | ❌ (paywall) | ✅ (CSV + your sheet) |
| Dashboard integration | ❌ | ✅ (planned) |
| Geofence | ❌ on free | UI placeholder; not enforced yet |
| Native apps in stores | ✅ | PWA only (good enough on iOS 16+ / Android) |

---

*Built 2026-06-05 · Signal language rebuild 2026-06-07*
