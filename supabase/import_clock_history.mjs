#!/usr/bin/env node
/* Quay 1 — backdated clock-history importer.
 * ============================================================
 * Reads a CSV of historical shifts and inserts (in, out) pairs
 * into Supabase's events table, with duration_hrs computed.
 *
 * Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." \
 *     node import_clock_history.mjs <path/to/shifts.csv> [--apply] \
 *       [--on-conflict=skip|append] [--bootstrap-missing]
 *
 * Two CSV formats are auto-detected by header row:
 *
 * 1. Simple format (preferred for new exports):
 *      name,date,clock_in,clock_out,note
 *      Thandi Mokoena,2026-05-01,08:02,17:06,At desk
 *
 * 2. Connecteam export format:
 *      First name,Last name,Type,Sub-job,Start Date,In,Start - location,
 *      End Date,Out,End - location,Employee notes,Manager notes,...
 *    The script maps First+Last → staff name lookup; In/Out times +
 *    Start Date → timestamps; Employee notes → the shift note.
 *
 * Flags:
 *   --apply               actually write (default is dry-run)
 *   --on-conflict=skip    if a clock-in already exists, skip (default)
 *   --on-conflict=append  insert anyway as a second shift
 *   --bootstrap-missing   for any name in the CSV that isn't in the
 *                         staff table, create an auth user + staff row
 *                         with a random 4-digit PIN. Prints the new
 *                         (name, username, PIN) assignments — hand
 *                         these to staff so they can sign in.
 *
 * The script prints a per-row dry-run table so you can see which names
 * don't resolve before applying.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ───── args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const apply  = args.includes('--apply');
const bootstrap = args.includes('--bootstrap-missing');
const onConflict = (args.find(a => a.startsWith('--on-conflict=')) || '--on-conflict=skip').split('=')[1];
const AUTH_EMAIL_DOMAIN = process.env.AUTH_EMAIL_DOMAIN || 'quay1.local';

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
  // 1. Read + normalise CSV. Auto-detect Connecteam format.
  const raw = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const rowsRaw = parseCSV(raw);
  if (!rowsRaw.length) { console.error('[import] CSV has no data rows'); process.exit(2); }
  const rows = detectAndNormalise(rowsRaw);
  console.log(`[import] ${rowsRaw.length} CSV rows → ${rows.length} usable shifts after normalisation`);

  // 2. Load roster for name → id mapping.
  let { data: staff, error } = await sb.from('staff').select('id, name');
  if (error) { console.error('[import] could not load roster:', error.message); process.exit(1); }
  const byId   = new Map(staff.map(s => [s.id.toLowerCase(), s]));
  const byName = new Map(staff.map(s => [s.name.toLowerCase().trim(), s]));

  // 3. Resolve + validate each row.
  let resolved = [];
  const unmatched = new Map(); // raw → count
  const unmatchedRows = new Map(); // raw → first row data (for bootstrap)
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
      if (!unmatchedRows.has(ident)) unmatchedRows.set(ident, r);
      return;
    }
    const tsIn  = isoFor(date, tin);
    const tsOut = isoFor(date, tout);
    if (tsOut <= tsIn) return rejectRow(r, i, 'clock_out must be after clock_in (cross-midnight not supported here)');
    const hrs = +((new Date(tsOut) - new Date(tsIn)) / 3.6e6).toFixed(3);
    resolved.push({
      _csvRow: i + 2, _ident: ident,
      staff_id: match.id, name: match.name,
      tsIn, tsOut, hrs,
      note: (r.note || '').trim(),
    });
  });

  // 4. Print summary.
  console.log(`[import] resolved ${resolved.length} rows; ${unmatched.size} unmatched name(s)`);
  if (unmatched.size) {
    console.log('\nUNMATCHED:');
    [...unmatched.entries()].forEach(([k, n]) => console.log(`  · ${k}  (${n} rows)`));
    if (!bootstrap) {
      console.log('\nRoster names available:');
      staff.forEach(s => console.log(`  · ${s.name}  →  id=${s.id}`));
      console.log('\nTo auto-create the missing staff with random PINs:');
      console.log('  re-run with --bootstrap-missing');
    }
  }

  // 4b. Bootstrap missing staff if requested.
  if (bootstrap && unmatchedRows.size) {
    if (!apply) {
      console.log(`\n[bootstrap] DRY RUN — would create ${unmatchedRows.size} staff. Add --apply to write.`);
    } else {
      console.log(`\n[bootstrap] creating ${unmatchedRows.size} staff with random PINs…`);
      const usedPins = new Set();
      // Pull existing PINs by listing them via service role (auth users only
      // have the synthetic email so we don't need actual PINs here — random
      // is fine, we just dedupe).
      const newStaff = [];
      for (const [rawName] of unmatchedRows) {
        const slug = slugify(rawName);
        let pin;
        do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (usedPins.has(pin));
        usedPins.add(pin);
        const email = `${slug}@${AUTH_EMAIL_DOMAIN}`;
        const { data: auth, error: aErr } = await sb.auth.admin.createUser({
          email, password: pin, email_confirm: true,
          user_metadata: { username: slug, name: rawName },
        });
        if (aErr) { console.error(`  ! auth user ${slug}: ${aErr.message}`); continue; }
        const { error: sErr } = await sb.from('staff').insert({
          id: slug, auth_user_id: auth.user.id, name: rawName,
          role: '', team: '', is_admin: false, active: true,
        });
        if (sErr) {
          console.error(`  ! staff row ${slug}: ${sErr.message}`);
          await sb.auth.admin.deleteUser(auth.user.id);
          continue;
        }
        newStaff.push({ name: rawName, id: slug, pin });
      }
      console.log('\nNew staff created — hand these PINs to each person:');
      console.log('  name'.padEnd(40) + 'username'.padEnd(28) + 'PIN');
      newStaff.forEach(s => console.log(`  ${s.name.padEnd(38)} ${s.id.padEnd(28)} ${s.pin}`));

      // Now re-resolve unmatched rows.
      const newByName = new Map(newStaff.map(s => [s.name.toLowerCase().trim(), { id: s.id, name: s.name }]));
      rows.forEach((r, i) => {
        const ident = (r.id || r.name || '').toString().trim();
        const date  = normaliseDate(r.date);
        const tin   = normaliseTime(r.clock_in);
        const tout  = normaliseTime(r.clock_out);
        if (!ident || !date || !tin || !tout) return;
        const m = newByName.get(ident.toLowerCase());
        if (!m) return;
        const tsIn  = isoFor(date, tin);
        const tsOut = isoFor(date, tout);
        if (tsOut <= tsIn) return;
        const hrs = +((new Date(tsOut) - new Date(tsIn)) / 3.6e6).toFixed(3);
        resolved.push({ _csvRow: i + 2, _ident: ident, staff_id: m.id, name: m.name,
                        tsIn, tsOut, hrs, note: (r.note || '').trim() });
      });
      console.log(`\n[bootstrap] ${newStaff.length} staff added; resolved rows now ${resolved.length}`);
    }
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
    events.push({ staff_id: r.staff_id, ts: r.tsIn,  dir: 'in',  note: r.note, duration_hrs: null });
    events.push({ staff_id: r.staff_id, ts: r.tsOut, dir: 'out', note: '',     duration_hrs: r.hrs  });
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

function slugify(raw) {
  return String(raw || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

// Detect Connecteam-export format by header keys and normalise into the
// simple {name, date, clock_in, clock_out, note} shape the resolver expects.
function detectAndNormalise(rows) {
  if (!rows.length) return rows;
  const first = rows[0];
  const keys  = Object.keys(first);
  const looksConnecteam = keys.includes('first name') && keys.includes('last name')
    && keys.includes('start date') && keys.includes('in') && keys.includes('out');
  if (!looksConnecteam) return rows;
  console.log('[import] detected Connecteam export — normalising…');
  return rows
    .filter(r => (r['first name'] || r['last name']))
    .map(r => ({
      name:       `${(r['first name'] || '').trim()} ${(r['last name'] || '').trim()}`.trim(),
      date:       (r['start date'] || '').split(' ')[0],   // strip "0:00:00" tail
      clock_in:   (r['in']  || '').trim(),
      clock_out:  (r['out'] || '').trim(),
      note:       (r['employee notes'] || '').trim(),
      // Sub-job + manager notes intentionally ignored.
    }));
}
