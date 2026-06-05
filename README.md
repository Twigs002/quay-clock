# Quay 1 — Clock In / Out

Mobile-first PWA for Quay 1 callers to clock in and out. Replaces the manual
Connecteam workflow on the free tier; data lives in a Google Sheet you own.

**Live:** _(set after first deploy)_

---

## How it works

```
Phone (PWA, GitHub Pages)
  ↓  POST { action, agentId, pin }
Google Apps Script Web App
  ↓  appends row
Google Sheet (Quay Clock)
  ↓  read by
quay-dashboard-v2 (Work Time tab)
```

- Frontend: vanilla HTML/CSS/JS, install-to-homescreen PWA, offline-capable shell.
- Backend: a single Apps Script file, deployed as a Web App. Free.
- Storage: one Google Sheet with two tabs (`Roster`, `Events`). View / edit / export directly.
- Auth: 4-digit PIN per agent (validated server-side).

---

## Setup (one-time, ~10 minutes)

1. **Backend** — follow [`apps_script/SETUP.md`](apps_script/SETUP.md) to:
   - Create the Quay Clock Google Sheet
   - Paste the Apps Script
   - Deploy as a Web App (Execute as Me, Who has access: Anyone)
2. **Frontend** — paste the Web App URL into `app.js` (`APPS_SCRIPT_URL`).
3. **Deploy** — push to GitHub. GitHub Pages auto-serves at the repo URL.
4. **Roster** — fill in the `Roster` tab of the sheet (id / name / team / pin / active).

---

## Day-to-day use

- Agent opens the PWA on their phone (recommended: Add to Home Screen so it launches like a native app).
- Sees the roster. Clocked-in people appear first with a green badge.
- Taps their name → enters their 4-digit PIN → sees confirmation with timestamp.
- End of day: same flow, but the screen shows "See you tomorrow!" with hours worked.

A wall tablet at the office can run the same URL as a kiosk — the UI auto-returns to the roster ~6 seconds after each confirmation.

---

## Dashboard integration (future)

The `quay-dashboard-v2` Work Time tab currently estimates clocked-in time as `dialler / 0.85`.
Once this clock app is running, a small fetcher script in that repo will read the Events sheet
and replace the estimate with real numbers.

---

## File map

```
index.html         PWA shell
styles.css         Brand styling (Quay 1 navy + brass)
app.js             UI state machine + API calls
manifest.json      PWA install metadata
sw.js              Service worker (offline shell, network-first for API)
icons/             192px / 512px launcher icons
apps_script/
  Code.gs          Backend Apps Script (copy into the script editor)
  SETUP.md         5-minute deployment guide
```

---

## Trade-offs vs Connecteam

| | Connecteam (free) | This app |
|---|---|---|
| Cost | Free | Free |
| Clock in/out | ✅ | ✅ |
| Data export | ❌ (paywall) | ✅ (your sheet) |
| Dashboard integration | ❌ | ✅ (planned) |
| Geofence | ❌ on free | Not built |
| Push reminder to clock out | ✅ | Not built (Apps Script trigger + email = ~30 min job) |
| GPS audit trail | ❌ on free | Not built |
| Native apps in stores | ✅ | PWA only (good enough on iOS 16+ / Android) |

---

*Built 2026-06-05*
