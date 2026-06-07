# Apps Script backend — setup (v2)

## 1. Google Sheet — four tabs

Create a Google Sheet named **Quay Clock**. The script auto-creates missing
tabs with the right header row, but you'll need to add staff to `Roster`
yourself. The four tabs:

### Tab: `Roster`
| id | name | role | team | email | pin | active | admin |
|----|------|------|------|-------|-----|--------|-------|
| thandi | Thandi Mokoena | Sales Agent | Sales | thandi@quay1.co.za | 1234 | true | false |
| rashied | Rashied Adams | Office Manager | Admin | rashied@quay1.co.za | 9999 | true | true |

- `id` — short slug used internally (lowercase, no spaces).
- `name` — display name.
- `role` — shown in admin/team views.
- `team` — optional grouping.
- `email` — for the staff directory.
- `pin` — 4-digit login PIN. **Each person gets their own.**
- `active` — `false` hides without losing history.
- `admin` — `true` unlocks the admin dashboard for that person's PIN.

### Tab: `Events`
| ts | id | name | action | note | location | duration_hrs |

Auto-appended by the script. Leave empty.

### Tab: `Leave`
| id | ts | agent_id | agent_name | type | start_date | end_date | days | reason | status | decided_by | decided_ts |

Auto-appended when a staff member submits a leave request. `status` flips
to `Approved` or `Declined` when an admin acts on it.

### Tab: `Locations` *(optional)*
| name | address | lat | lng | radius_m |

Office geofences. If you leave this empty, the script returns four sensible
defaults (V&A Waterfront / Sea Point / Camps Bay / Remote).

---

## 2. Paste the script

Sheet → **Extensions → Apps Script** → delete the placeholder → paste the
entire `Code.gs` → save.

---

## 3. Deploy as a Web App

1. **Deploy → New deployment**
2. Type: **Web app**
3. **Execute as:** `Me`
4. **Who has access:** `Anyone` (PIN gates writes)
5. **Deploy** → authorise on first run → copy the URL
   (`https://script.google.com/macros/s/AKfycb.../exec`)

---

## 4. Wire the URL

Open `quay-clock/app.js` and replace `APPS_SCRIPT_URL`. Commit + push;
GitHub Pages redeploys in ~30s.

The admin dashboard (`quay-clock/admin/`) uses the same URL — no separate
configuration needed.

---

## 5. Test

- Visit the PWA. Enter a PIN from the Roster → you should see your home screen.
- Tap **Clock In** → add a shift note → confirm → check the `Events` tab.
- Open **Leave** → request time off → check the `Leave` tab.
- Visit `/admin/` and enter an admin PIN. The "Who's working now" table
  should reflect everyone who's currently clocked in.

---

## Re-deploying after script changes

Edit `Code.gs` → **Deploy → Manage deployments → ✏️ → Version: New
version → Deploy**. The URL stays the same.

---

## Supported actions (for reference)

`roster`, `login`, `me`, `clock`, `events`, `summary`, `team_today`,
`leave_list`, `leave_create`, `leave_decide`, `admin_check`, `locations`.

All take POST with `Content-Type: text/plain` and a JSON body `{ action, ... }`.
