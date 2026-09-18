# Supabase backend

Live config (saved in `quay-clock/quay-config.js` once the migration lands):
- **Project URL:** `https://dqszbqiimbfvmmnpgpsb.supabase.co`
- **anon key:** see `quay-config.js`. Safe to commit — RLS gates everything.
- **service_role key:** NEVER commit. Only used by the migration script and the
  Edge Function (which reads it from its own env var).

## Migration steps

### 1. Apply the schema

Open the Supabase dashboard for `quay-clock` → **SQL Editor** → **New query** →
paste `schema.sql` → **Run**. Should report "Success. No rows returned." Re-run
is safe (idempotent).

### 2. Deploy the `admin-create-staff` Edge Function

Dashboard → **Edge Functions** → **Create function** → name it
`admin-create-staff` → paste `functions/admin-create-staff/index.ts` → **Deploy**.
Make sure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars are set
(they're auto-populated by Supabase, but verify under the function's
**Settings → Environment variables**).

### 3. Migrate existing data from Apps Script

You need three things:
- Your Supabase service-role key (Dashboard → Settings → API → `service_role`)
- The Apps Script Web App URL
- A `PIN_MAP_JSON` mapping `{ "username": "PIN" }` — the public `roster` action
  doesn't expose PINs, so you supply them manually here. Pull them from the
  Google Sheet's Roster tab.

Run from anywhere with Node 18+:

```bash
cd quay-clock/supabase
npm install @supabase/supabase-js

SUPABASE_URL="https://dqszbqiimbfvmmnpgpsb.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<paste-the-service-role-key>" \
QUAY_CLOCK_URL="https://script.google.com/macros/s/AKfycbw3g6cdmfIbWC6TVSybVk5CECKhnSBneDuWGzM4krxcTFgOhS7Ef4InD6F1x9llnl27AA/exec" \
PIN_MAP_JSON='{"thandi":"1234","rashied":"9999"}' \
node migrate-from-sheets.mjs
```

The script:
1. Pulls the roster, the last 18 months of events, and all leave requests.
2. For each Roster row, creates a `auth.users` entry (synthetic email
   `<username>@quay1.local`, password = PIN) and a `public.staff` row.
3. Bulk-inserts the events + requests, linked by username.

Safe to re-run — existing rows are skipped.

### 4. Cut the frontends over

Once the migration completes, the next PR rewires `app.js`, `admin/admin.js`,
and the dashboard's `quay/app.js` to call Supabase instead of Apps Script.
After verification, delete the Apps Script deployment (Dashboard → Manage
deployments → Archive).

---

## Backdated clock-history import

Once the system is live you may want to back-fill historical shifts
(e.g. a CSV export from your old time-tracker). Use
`import_clock_history.mjs`:

```bash
cd supabase
npm install @supabase/supabase-js     # if not already installed

# Dry-run first — shows which names match and what would be inserted.
SUPABASE_URL="https://dqszbqiimbfvmmnpgpsb.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role>" \
node import_clock_history.mjs ~/Downloads/shifts.csv

# When the dry-run looks good:
SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." \
node import_clock_history.mjs ~/Downloads/shifts.csv --apply
```

**Expected CSV columns** (header row, case-insensitive):

```
name,date,clock_in,clock_out,note
Thandi Mokoena,2026-05-01,08:02,17:06,
Nadia Isaacs,2026-05-01,07:58,16:30,Off-site meeting
```

You can use `id` instead of `name` if you'd rather skip the
name-to-username lookup. Dates accept `YYYY-MM-DD` or `DD/MM/YYYY`.

The script is **idempotent** by default — a row whose clock-in timestamp
already exists for that staff member is skipped (so re-runs are safe).
Pass `--on-conflict=append` to insert anyway as a second shift.

---

## Team-source drift guard

There are two independent team lists in this system that can silently drift
apart:

- `CLOCK_CAMPAIGNS_ALL` — hardcoded in `app.js`; what staff clock in/out
  against.
- `payroll_canonical_divisions` — a Supabase table (owned by
  quay-dashboard-v2) that the admin payroll picker reads from.

If a canonical division is missing from `CLOCK_CAMPAIGNS_ALL`, staff can
never clock in against it and payroll can't reconcile the hours. Run
`../tests/team_source_drift.mjs` (Node 18+, **no npm install needed** — it
uses global `fetch` and the Supabase REST API) to catch that:

```bash
cd quay-clock
SUPABASE_URL="https://dqszbqiimbfvmmnpgpsb.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role>" \
node tests/team_source_drift.mjs
```

- `SUPABASE_URL` defaults to the value in `quay-config.js`; a service-role
  key is preferred but it falls back to the committed anon key if the table
  is readable to it.
- Exit `0` = in sync (or skipped when no creds are present), `1` = drift
  (canonical divisions missing from the clock list — the failure lists
  them), `2` = could not run.
- Set `STRICT=1` to turn "no creds available" into a failure (exit `2`)
  rather than a skip — use this in CI once the service-role key is wired in
  as a secret.

This is a **detection** guard only; full unification of the two lists is a
separate decision (see the PR that added this).
