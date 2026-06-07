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
