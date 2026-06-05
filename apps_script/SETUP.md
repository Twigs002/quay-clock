# Apps Script backend — 5-minute setup

## 1. Make the Google Sheet

Create a new Google Sheet named **Quay Clock**. Add two tabs:

### Tab: `Roster`
| id | name | team | pin | active |
|----|------|------|-----|--------|
| gio | Gio | RM | 1234 | true |
| warrick | Warrick Solomons | RM | 4321 | true |
| ... | ... | ... | ... | ... |

- `id` is a short slug used by the app (lowercase, no spaces).
- `name` is what shows in the UI.
- `team` is RM or Fancy (optional; for grouping).
- `pin` is a 4-digit code the agent will type. **Give each agent a different one.**
- `active = false` hides an agent from the roster without losing their history.

### Tab: `Events`
| ts | id | name | action | duration_hrs | source_ip |
|----|----|------|--------|--------------|-----------|

Leave it empty — the script will append rows here. The header row is required.

---

## 2. Paste the script

In the Sheet → **Extensions → Apps Script** → delete the placeholder `Code.gs`
contents → paste the entire contents of `Code.gs` from this folder → save (`Ctrl+S` / `Cmd+S`).

---

## 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description:** `quay-clock backend`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` (this lets the public PWA talk to it; the PIN gates the actual writes)
4. Click **Deploy**.
5. First time only: Google asks you to authorise. Click **Authorise access → choose your account → Advanced → "Go to (unsafe)" → Allow**. (It's only "unsafe" because the script isn't Google-verified — it's your own script.)
6. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfycb.../exec`.

---

## 4. Plug the URL into the PWA

Open `quay-clock/app.js`, find:
```js
const APPS_SCRIPT_URL = '';
```
Paste the URL between the quotes. Commit + push. GitHub Pages redeploys in ~30s.

---

## 5. Test

- Visit the PWA on your phone.
- You should see the roster.
- Tap your name → enter your PIN → see the clock-in confirmation.
- Check the Google Sheet's `Events` tab — a new row should have appeared.
- Clock out — the duration should populate.

---

## Re-deploying after script changes

If you edit `Code.gs` later:
- **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**

The URL stays the same. (If you ever do "New deployment" instead, you'll get a new URL and have to update `app.js`.)
