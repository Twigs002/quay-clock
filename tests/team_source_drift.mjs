#!/usr/bin/env node
/* Quay 1 — team-source drift guard
 * =====================================================================
 * There are two independent "list of teams" sources in this system:
 *
 *   1. CLOCK_CAMPAIGNS_ALL  — a hardcoded array in app.js. This is what
 *      staff clock in / out against (the team picker sheet).
 *   2. payroll_canonical_divisions — a Supabase table (owned by
 *      quay-dashboard-v2) that the admin payroll picker reads from
 *      (admin/admin.js). Payroll allocates hours by these names.
 *
 * If a canonical division exists in payroll but NOT in CLOCK_CAMPAIGNS_ALL,
 * staff can never clock in against it and payroll can't reconcile the hours
 * — silent drift. This script fails loudly when that happens so the two
 * lists are kept in sync (until they are properly unified — see the PR
 * that added this guard).
 *
 * It only asserts one direction (every canonical division must exist in the
 * clock list). The reverse (clock teams not in canonical, e.g. archived or
 * newly-added-but-not-yet-canonical teams) is printed as an FYI, not a
 * failure.
 *
 * Usage:
 *   SUPABASE_URL="https://<proj>.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
 *   node tests/team_source_drift.mjs
 *
 *   - SUPABASE_URL defaults to the value baked into quay-config.js.
 *   - A service-role key is preferred (bypasses RLS); the anon key from
 *     quay-config.js is used as a fallback and works if the table is
 *     readable to authenticated/anon. On this laptop the service-role key
 *     lives in the macOS Keychain (see the team memory note).
 *
 * Exit codes:
 *   0  in sync (or skipped because no Supabase creds were available and
 *      STRICT is unset)
 *   1  drift detected — canonical divisions missing from CLOCK_CAMPAIGNS_ALL
 *   2  could not run (bad response, or STRICT set with no creds)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── 1. Extract the clock-in team names from app.js ────────────────────
async function clockCampaignNames() {
  const src = await readFile(resolve(ROOT, 'app.js'), 'utf8');
  const start = src.indexOf('const CLOCK_CAMPAIGNS_ALL = [');
  if (start === -1) throw new Error('Could not find CLOCK_CAMPAIGNS_ALL in app.js');
  const end = src.indexOf('];', start);
  if (end === -1) throw new Error('Could not find end of CLOCK_CAMPAIGNS_ALL array in app.js');
  const block = src.slice(start, end);
  // Each entry is `{ name: '...' }` (optionally with `, archived: true`).
  const names = [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('Parsed zero names from CLOCK_CAMPAIGNS_ALL — parser out of date?');
  return names;
}

// ── 2. Read the SUPABASE_URL / anon key baked into quay-config.js ─────
async function configDefaults() {
  try {
    const cfg = await readFile(resolve(ROOT, 'quay-config.js'), 'utf8');
    const url = cfg.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1] || '';
    const anon = cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1] || '';
    return { url, anon };
  } catch {
    return { url: '', anon: '' };
  }
}

// ── 3. Fetch canonical division names from Supabase REST ──────────────
async function canonicalDivisionNames(url, key) {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/payroll_canonical_divisions?select=name&order=name.asc`;
  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`payroll_canonical_divisions read failed: HTTP ${res.status} ${res.statusText} ${body}`.trim());
  }
  const rows = await res.json();
  return rows.map((r) => r.name).filter(Boolean);
}

async function main() {
  const strict = process.env.STRICT === '1';
  const { url: cfgUrl, anon: cfgAnon } = await configDefaults();
  const url = process.env.SUPABASE_URL || cfgUrl;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || cfgAnon;

  if (!url || !key) {
    const msg = 'team_source_drift: no SUPABASE_URL / key available — cannot check drift.';
    if (strict) { console.error(`FAIL ${msg} (STRICT=1)`); process.exit(2); }
    console.warn(`SKIP ${msg} Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable.`);
    process.exit(0);
  }

  const clockNames = await clockCampaignNames();
  const clockLc = new Set(clockNames.map((n) => n.trim().toLowerCase()));

  let canonical;
  try {
    canonical = await canonicalDivisionNames(url, key);
  } catch (e) {
    console.error(`FAIL team_source_drift: ${e.message}`);
    process.exit(2);
  }

  const missing = canonical.filter((n) => !clockLc.has(String(n).trim().toLowerCase()));

  // FYI only: clock teams that aren't canonical divisions (archived / new).
  const canonicalLc = new Set(canonical.map((n) => String(n).trim().toLowerCase()));
  const clockOnly = clockNames.filter((n) => !canonicalLc.has(n.trim().toLowerCase()));

  console.log(`team_source_drift: ${clockNames.length} clock teams, ${canonical.length} canonical divisions.`);
  if (clockOnly.length) {
    console.log(`  (FYI) in CLOCK_CAMPAIGNS_ALL but not canonical (archived/new, not a failure): ${clockOnly.join(', ')}`);
  }

  if (missing.length) {
    console.error(`FAIL: ${missing.length} canonical division(s) missing from CLOCK_CAMPAIGNS_ALL in app.js:`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error('Staff cannot clock in against these; add them to CLOCK_CAMPAIGNS_ALL (or retire the canonical division).');
    process.exit(1);
  }

  console.log('OK: every canonical division is present in CLOCK_CAMPAIGNS_ALL.');
}

main().catch((e) => { console.error('team_source_drift: fatal', e); process.exit(2); });
