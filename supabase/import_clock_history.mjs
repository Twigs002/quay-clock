#!/usr/bin/env node
/* Quay 1 — backdated clock-history importer.
 * ============================================================
 * Reads a CSV of historical shifts and inserts (in, out) pairs
 * into Supabase's events table, with duration_hrs computed.
 *
 * Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   SUPABASE_URL="https://<proj>.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
 *   node import_clock_history.mjs <path/to/shifts.csv> [--apply] [--on-conflict skip|append]
 *
 * CSV columns (header row required, case-insensitive):
 *   name        OR id     — staff member (display name or username slug)
 *   date                  — YYYY-MM-DD (or DD/MM/YYYY)
 *   clock_in              — HH:MM (24h)
 *   clock_out             — HH:MM (24h)
 *   note                  — optional
 *
 * Conflict handling (--on-conflict):
 *   skip    — if a clock-in event for the same staff/date/time already
 *             exists, leave it alone (default; safest)
 *   append  — insert anyway as a second shift that day
 *
 * The script prints a per-row table on dry-run so you can see which
 * names don't resolve, then asks you to re-run with --apply.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ───── args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const apply  = args.includes('--apply');
const onConflict = (args.find(a => a.startsWith('--on-conflict=')) || '--on-conflict=skip').split('=')[1];

if (!csvPath) {
  console.error('Usage: node import_clock_history.mjs <csv> [--apply] [--on-conflict=skip|append]');
  process.exit(2);
}
const SUPABASE_URL = need('SUPABASE_URL');
const SERVICE_ROLE = need('SUPABASE_SERVICE_ROLE_KEY');
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

main().catch(e => { console.error('[import] fatal:', e); process.exit(1); });

// ───── main ───────────────────────────────────────────────────────────
async function main() {
  // 1. Read CSV.
  const raw = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const rows = parseCSV(raw);
  if (!rows.length) { console.error('[import] CSV has no data rows'); process.exit(2); }
  console.log(`[import] ${rows.length} CSV rows`);

  // 2. Load roster for name → id mapping.
  const { data: staff, error } = await sb.from('staff').select('id, name');
  if (error) { console.error('[import] could not load roster:', error.message); process.exit(1); }
  const byId   = new Map(staff.map(s => [s.id.toLowerCase(), s]));
  const byName = new Map(staff.map(s => [s.name.toLowerCase().trim(), s]));

  // 3. Resolve + validate each row.
  const resolved = [];
  const unmatched = new Map(); // raw → count
  rows.forEach((r, i) => {
    const ident = (r.id || r.name || '').toString().trim();
    const date  = normaliseDate(r.date);
    const tin   = normaliseTime(r.clock_in);
    const tout  = normaliseTime(r.clock_out);
    if (!ident) return rejectRow(r, i, 'missing name/id');
    if (!date)  return rejectRow(r, i, 'invalid date');
    if (!tin || !tout) return rejectRow(r, i, 'invalid clock_in/clock_out time');

    const match = byId.get(ident.toLowerCase()) || byName.get(ident.toLowerCase());
    if (!match) {
      unmatched.set(ident, (unmatched.get(ident) || 0) + 1);
      return;
    }
    const tsIn  = isoFor(date, tin);
    const tsOut = isoFor(date, tout);
    if (tsOut <= tsIn) return rejectRow(r, i, 'clock_out must be after clock_in (cross-midnight not supported here)');
    const hrs = +((new Date(tsOut) - new Date(tsIn)) / 3.6e6).toFixed(3);
    resolved.push({
      _csvRow: i + 2,                 // +1 header, +1 1-indexed
      staff_id: match.id, name: match.name,
      tsIn, tsOut, hrs,
      note: (r.note || '').trim(),
    });
  });

  // 4. Print summary.
  console.log(`[import] resolved ${resolved.length} rows; ${unmatched.size} unmatched ident(s)`);
  if (unmatched.size) {
    console.log('\nUNMATCHED (need exact match in CSV):');
    [...unmatched.entries()].forEach(([k, n]) => console.log(`  · ${k}  (${n} rows)`));
    console.log('\nRoster ids/names available:');
    staff.forEach(s => console.log(`  · ${s.name}  →  id=${s.id}`));
  }

  // 5. Conflict pre-check (which would-be inserts already exist?).
  let toInsert = resolved;
  if (onConflict === 'skip' && resolved.length) {
    const tsList = resolved.map(r => r.tsIn);
    const { data: existing } = await sb.from('events')
      .select('staff_id, ts')
      .in('staff_id', [...new Set(resolved.map(r => r.staff_id))])
      .in('ts', tsList);
    const existingKeys = new Set((existing || []).map(e => `${e.staff_id}|${e.ts}`));
    const before = toInsert.length;
    toInsert = toInsert.filter(r => !existingKeys.has(`${r.staff_id}|${r.tsIn}`));
    if (before !== toInsert.length) {
      console.log(`[import] ${before - toInsert.length} rows already in DB — skipping (use --on-conflict=append to insert anyway)`);
    }
  }

  // 6. Dry-run table.
  console.log('\nFirst 10 rows that would be written:');
  toInsert.slice(0, 10).forEach(r =>
    console.log(`  ${r._csvRow.toString().padStart(4)}  ${r.name.padEnd(28)} ${r.tsIn.slice(0,16)} → ${r.tsOut.slice(11,16)} (${r.hrs}h)`)
  );
  if (toInsert.length > 10) console.log(`  …and ${toInsert.length - 10} more`);

  if (!apply) {
    console.log(`\n[import] DRY RUN — nothing written. Add --apply to insert ${toInsert.length} pair(s).`);
    return;
  }

  // 7. Actually insert (in + out pairs).
  console.log(`\n[import] applying — inserting ${toInsert.length * 2} events…`);
  const events = [];
  toInsert.forEach(r => {
    events.push({
      staff_id: r.staff_id, ts: r.tsIn,  dir: 'in',
      note: r.note, location: '', duration_hrs: null,
    });
    events.push({
      staff_id: r.staff_id, ts: r.tsOut, dir: 'out',
      note: '', location: '', duration_hrs: r.hrs,
    });
  });
  // Insert in chunks of 500 to be friendly to PostgREST.
  const CHUNK = 500;
  let ok = 0, fail = 0;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const { error } = await sb.from('events').insert(slice);
    if (error) { console.error(`  ! chunk ${i / CHUNK}: ${error.message}`); fail += slice.length; }
    else { ok += slice.length; }
  }
  console.log(`\n[import] done. ${ok} events inserted${fail ? `, ${fail} failed` : ''}.`);
}

// ───── helpers ────────────────────────────────────────────────────────
function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`[import] missing env var: ${name}`); process.exit(2); }
  return v;
}

function parseCSV(text) {
  // Minimal CSV parser handling quoted fields with embedded commas/quotes.
  const lines = []; let cur = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(cur); lines.push(row); row = []; cur = ''; }
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); lines.push(row); }
  // First line = headers (lowercased + trimmed).
  const headers = lines.shift().map(h => h.toLowerCase().trim());
  return lines
    .filter(l => l.some(c => (c || '').trim()))
    .map(l => Object.fromEntries(l.map((v, i) => [headers[i] || `_col${i}`, v])));
}

function normaliseDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return t;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  if ((m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) {
    return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  // Last try: feed to Date().
  const d = new Date(t);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return '';
}

function normaliseTime(s) {
  if (!s) return '';
  const m = String(s).trim().match(/^(\d{1,2}):?(\d{2})(?::\d{2})?$/);
  if (!m) return '';
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return '';
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function isoFor(date, hhmm) {
  // Use the local time as-is, then convert to ISO with +00:00 offset.
  // Sites configure their Supabase project timezone — we store UTC; the
  // dashboard renders in user TZ.
  return new Date(`${date}T${hhmm}:00`).toISOString();
}

function rejectRow(r, i, reason) {
  console.log(`  [skip] row ${i + 2}: ${reason}  (raw: ${JSON.stringify(r)})`);
}
