#!/usr/bin/env node
/* Quay 1 — one-off migration from the Apps Script / Google Sheet
 * backend into Supabase. Run once after the schema has been applied.
 *
 * Usage:
 *   SUPABASE_URL="https://<proj>.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
 *   QUAY_CLOCK_URL="https://script.google.com/macros/s/.../exec" \
 *   node supabase/migrate-from-sheets.mjs
 *
 * What it does:
 *   1. Pulls roster, events (last 18 months), and leave_list from Apps Script.
 *   2. For each Roster row creates an auth.users entry (email = id@quay1.local,
 *      password = PIN) and a public.staff row.
 *   3. Bulk-inserts events + requests linked by the username slug.
 *
 * Safe to re-run: each step is upsert-style; existing rows are skipped.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL    = need("SUPABASE_URL");
const SERVICE_ROLE    = need("SUPABASE_SERVICE_ROLE_KEY");
const APPS_SCRIPT_URL = need("QUAY_CLOCK_URL");

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

main().catch((e) => { console.error("[migrate] fatal:", e); process.exit(1); });

async function main() {
  console.log("[migrate] pulling roster from Apps Script…");
  const roster = (await callAppsScript("roster")).roster || [];
  console.log(`[migrate] roster has ${roster.length} active rows`);

  // ─── 1. Pull every staff member's PIN. The public 'roster' action does
  //       NOT include the PIN, so we hit /me for each one via login is
  //       impossible without the PIN itself. The simplest path is: ask the
  //       user to add PIN to the roster export. Or we read directly from
  //       the sheet via the admin password (off-table). Since this is a
  //       one-off, we instead query a dedicated _migration_dump action you
  //       add temporarily to the script. See README.md.
  //       But to keep this script standalone, we'll accept an extra env:
  //       PIN_MAP_JSON='{"thandi":"1234","rashied":"9999",...}'
  const pinMap = JSON.parse(process.env.PIN_MAP_JSON || "{}");
  if (!Object.keys(pinMap).length) {
    console.warn("\n[migrate] WARNING: PIN_MAP_JSON is empty.");
    console.warn("[migrate] Each staff member needs their PIN to receive a Supabase auth account.");
    console.warn('[migrate] Re-run with PIN_MAP_JSON=\'{"thandi":"1234", ...}\' to import them.\n');
  }

  // ─── 2. Create or update staff rows + auth users.
  let inserted = 0, skipped = 0, missingPin = 0;
  const idByName = new Map(); // also handles legacy events that key by 'name' instead of 'id'
  for (const row of roster) {
    const id = (row.id || "").toLowerCase();
    if (!id) continue;
    idByName.set((row.name || "").toLowerCase(), id);

    const pin = pinMap[id];
    if (!pin) { missingPin++; continue; }
    const email = `${id}@quay1.local`;

    // Check if staff row already exists.
    const { data: existing } = await sb.from("staff").select("id, auth_user_id").eq("id", id).maybeSingle();
    if (existing) { skipped++; continue; }

    // Create auth user.
    const { data: auth, error: authErr } = await sb.auth.admin.createUser({
      email, password: pin, email_confirm: true,
      user_metadata: { username: id, name: row.name },
    });
    if (authErr) {
      console.error(`[migrate] auth user for ${id} failed: ${authErr.message}`);
      continue;
    }
    const { error: staffErr } = await sb.from("staff").insert({
      id,
      auth_user_id: auth.user.id,
      name: row.name,
      role: row.role || "",
      team: row.team || "",
      is_admin: !!row.admin,
      active: row.active !== false,
    });
    if (staffErr) {
      console.error(`[migrate] staff row for ${id} failed: ${staffErr.message}`);
      await sb.auth.admin.deleteUser(auth.user.id);
      continue;
    }
    inserted++;
  }
  console.log(`[migrate] staff: +${inserted} created, ${skipped} already present, ${missingPin} missing PIN`);

  // ─── 3. Pull events (last 18 months) and bulk-insert.
  const from = new Date(); from.setMonth(from.getMonth() - 18); from.setHours(0,0,0,0);
  const to   = new Date();
  console.log(`[migrate] pulling events ${from.toISOString().slice(0,10)} → ${to.toISOString().slice(0,10)}…`);
  const events = (await callAppsScript("events", { from: from.toISOString(), to: to.toISOString() })).events || [];
  console.log(`[migrate] ${events.length} events`);

  const eventRows = events
    .map((e) => {
      const sid = (e.id || "").toLowerCase() || idByName.get((e.name || "").toLowerCase());
      if (!sid) return null;
      return {
        staff_id: sid,
        ts: e.ts,
        dir: (e.action || "in").toLowerCase(),
        note: e.note || "",
        location: e.loc || "",
        duration_hrs: e.duration_hrs == null ? null : Number(e.duration_hrs),
      };
    })
    .filter(Boolean);

  await bulkInsert("events", eventRows);

  // ─── 4. Leave / Requests.
  console.log("[migrate] pulling leave list…");
  const leave = (await callAppsScript("leave_list")).leave || [];
  console.log(`[migrate] ${leave.length} requests`);

  const reqRows = leave
    .map((l) => {
      const sid = (l.agent_id || "").toLowerCase() || idByName.get((l.agent_name || "").toLowerCase());
      if (!sid) return null;
      return {
        staff_id: sid,
        type: l.type || "Annual leave",
        start_date: l.start_date || new Date().toISOString().slice(0,10),
        end_date: l.end_date || l.start_date || new Date().toISOString().slice(0,10),
        days: Number(l.days || 1),
        reason: l.reason || "",
        status: l.status || "Pending",
        decided_by: l.decided_by || null,
        decided_at: l.decided_ts || null,
      };
    })
    .filter(Boolean);

  await bulkInsert("requests", reqRows);

  console.log("\n[migrate] done. Verify in Supabase Studio → Tables.");
}

async function callAppsScript(action, payload = {}) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...payload }),
    redirect: "follow",
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Apps Script ${action}: ${data.error}`);
  return data;
}

async function bulkInsert(table, rows) {
  if (!rows.length) { console.log(`[migrate] ${table}: nothing to insert`); return; }
  const CHUNK = 500;
  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await sb.from(table).insert(slice);
    if (error) { console.error(`[migrate] ${table} chunk ${i}: ${error.message}`); fail += slice.length; }
    else { ok += slice.length; }
  }
  console.log(`[migrate] ${table}: +${ok} inserted${fail ? ` (${fail} failed)` : ""}`);
}

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[migrate] missing env var: ${name}`); process.exit(2); }
  return v;
}
