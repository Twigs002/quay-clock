/* Quay 1 — Admin Dashboard · vanilla JS, no build step
 * ----------------------------------------------------------------------
 * Signal-language admin web app. Sidebar nav over five views.
 * Shares the Apps Script backend with the staff PWA.
 */
(function () {
'use strict';

// ───── CONFIG ────────────────────────────────────────────────────────
const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbw3g6cdmfIbWC6TVSybVk5CECKhnSBneDuWGzM4krxcTFgOhS7Ef4InD6F1x9llnl27AA/exec';
const LS_KEY = 'quay_admin_session_v2';

// Embed mode: when this page is iframed from another surface (e.g. the
// quay-dashboard-v2 "Clocks" tab), the sidebar is replaced with a slim
// horizontal top-nav so the parent's chrome stays clean.
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
if (EMBED) document.documentElement.classList.add('embed');

// ───── STATE ─────────────────────────────────────────────────────────
const state = {
  admin: null,           // { id, name, role, ... } + pin (kept in memory for write actions)
  view: 'dashboard',
  loading: false,
  error: null,
  loginUser: '',
  pinBuf: '',
  pinErr: false,
  data: {
    team: null,          // [{ id, name, role, status, cin, loc, note, todayHrs }]
    summary: null,       // [{ id, name, hours, sessions }] (weekly)
    leave: null,         // [{ id, agent_name, type, dates, days, reason, status }]
    weekEvents: null,    // weekly events for timesheet view
    roster: null,        // for staff directory + counts
    tsEvents: null,      // events for the selected timesheet period
  },
  tsPeriod: 'this-week', // this-week | last-week | this-cycle | last-cycle | custom
  tsLayout: 'grid',      // grid (per-day matrix) | list (flat Connecteam-style shifts)
  tsDetail: null,        // { agentId, agentName } when detail modal open
  showArchived: false,   // Team view: include archived (active=false) staff
};

const $root = document.getElementById('admin');

// ───── BOOT ──────────────────────────────────────────────────────────
async function boot() {
  // Redirected standalone visits skip booting so the redirect message stays put.
  if (window.__quayAdminRedirect) return;

  // Embed mode: ask the parent for a Supabase session BEFORE we render the gate.
  if (EMBED && window.parent && window.parent !== window) {
    // SECURITY: only trust postMessage handshakes from the dashboard's
    // origin. Without this gate, any page that successfully iframes this
    // admin could inject a session it controls.
    const ALLOWED_PARENTS = new Set([
      'https://twigs002.github.io',
      // Same-origin fallback for local dev (e.g. file:// or vite preview).
      location.origin,
    ]);
    // Audit finding C2 (P1): the parent used to send a refresh_token too,
    // meaning an XSS on this origin could hijack a durable session. Parent
    // now only ships the short-lived access_token + expires_at. If the
    // access token approaches expiry, we re-ping the parent for a fresh
    // one. A `refresh_token` field is honoured for backwards-compat but
    // is no longer expected on the wire.
    let _reReadyTimer = null;
    const _requestFresh = () => {
      try { window.parent.postMessage({ type: 'quay-admin-ready' }, 'https://twigs002.github.io'); } catch {}
    };
    window.addEventListener('message', async (ev) => {
      if (!ALLOWED_PARENTS.has(ev.origin)) return;
      const m = ev.data;
      if (!m || m.type !== 'quay-supabase-session' || !m.session) return;
      try {
        await window.sb.auth.setSession({
          access_token: m.session.access_token,
          // '' when parent (post-C2) omits it — session runs until the
          // access token expires; we'll pre-emptively re-ping below.
          refresh_token: m.session.refresh_token || '',
        });
        // Schedule a pre-expiry re-request. expires_at is Unix seconds.
        if (_reReadyTimer) clearTimeout(_reReadyTimer);
        if (m.session.expires_at) {
          const msUntilRefresh = Math.max(
            5_000,
            (m.session.expires_at * 1000 - Date.now()) - 60_000,
          );
          _reReadyTimer = setTimeout(_requestFresh, msUntilRefresh);
        }
        const staff = await window.QD.loadSelfStaff();
        if (staff && (staff.is_admin || staff.designation === 'payroll')) {
          state.admin = { id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '', admin: true, super: !!staff.is_super, is_super: !!staff.is_super };
          writeSession(state.admin);
          await loadAll();
          render();
        }
      } catch (e) { /* fall through to local gate */ }
    });
    // Target the ready ping at the dashboard origin specifically so
    // a wildcard '*' doesn't leak the embed presence to other listeners.
    _requestFresh();
  }

  // Try to restore a Supabase session (could be from the parent handoff a
  // moment ago, or a prior visit).
  try {
    const staff = window.QD ? await window.QD.loadSelfStaff() : null;
    if (staff && (staff.is_admin || staff.designation === 'payroll')) {
      state.admin = { id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '', admin: true, super: !!staff.is_super, is_super: !!staff.is_super };
      writeSession(state.admin);
      loadAll();
    }
  } catch {}
  render();
}
function readSession() {
  try { return JSON.parse(sessionStorage.getItem(LS_KEY) || 'null'); }
  catch { return null; }
}
function writeSession(v) {
  if (v) sessionStorage.setItem(LS_KEY, JSON.stringify(v));
  else sessionStorage.removeItem(LS_KEY);
}

// ───── API ───────────────────────────────────────────────────────────
// Backed by Supabase via QD (window.QD). Returns { ok, ... } like before.
async function api(action, payload = {}) {
  if (!window.QD) throw new Error('Data layer not ready');
  const data = await window.QD.call(action, payload);
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

// ───── HELPERS ───────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
// SAST-anchored YYYY-MM-DD. Uses Intl so it returns the correct SAST day
// even when an admin views from a non-SAST browser (London, Perth, etc.).
// Replaces `.toISOString().slice(0,10)` which returns UTC — a source of
// day-shift bugs when viewing past 22:00 SAST (UTC "tomorrow") or from
// west-of-UTC timezones (UTC "yesterday").
const _SAST_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
function sastYmd(d) { return _SAST_YMD.format(d || new Date()); }

// Pair IN→OUT within a flat event list, per staff. Returns
// [{staff_id, in_ts, out_ts, hrs}]. Uses pair-from-timestamps as the
// source of truth (matches the Matthew Hallett / Warrick 24:39 fix
// pattern from PR #28); falls back to the cached `duration_hrs` only
// for orphan OUTs with no paired IN. Callers who summed raw
// duration_hrs without pairing were silently dropping manual shifts
// (duration_hrs=null) and trusting stale caches — both fixed here.
function pairShifts(events) {
  const grouped = new Map();
  (events || []).forEach(e => {
    if (!grouped.has(e.id)) grouped.set(e.id, []);
    grouped.get(e.id).push(e);
  });
  const shifts = [];
  grouped.forEach((evs, staffId) => {
    evs.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    let openIn = null;
    for (const e of evs) {
      if (e.action === 'in') { openIn = e; continue; }
      if (e.action !== 'out') continue;
      const outTs = new Date(e.ts).getTime();
      const inTs = openIn ? new Date(openIn.ts).getTime() : null;
      const hrs = openIn
        ? Math.max(0, (outTs - inTs) / 3.6e6)
        : (e.duration_hrs != null && !isNaN(e.duration_hrs) ? Number(e.duration_hrs) : 0);
      shifts.push({ staff_id: staffId, in_ts: inTs, out_ts: outTs, hrs });
      openIn = null;
    }
  });
  return shifts;
}

function fmtHM(hrs) {
  if (hrs == null || isNaN(hrs)) return '0:00';
  const total = Math.max(0, Math.round(hrs * 60));
  return Math.floor(total / 60) + ':' + pad(total % 60);
}
function fmtTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtDateShort(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
function initials(name) {
  return (name || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
const AV = ['#3D5BA6','#1E3A8A','#3F7BC4','#2F8FB3'];
const avColor = (i) => AV[(i || 0) % AV.length];
function startOfWeek(d) {
  const x = new Date(d); const day = (x.getDay() + 6) % 7;
  x.setHours(0,0,0,0); x.setDate(x.getDate() - day); return x;
}
function endOfWeek(d) { const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate() + 6); e.setHours(23,59,59,999); return e; }

const PERIOD_LABELS = {
  'this-week':   'This Week',
  'last-week':   'Last Week',
  'this-cycle':  'This Cycle',  // 21st of last month → 20th of this month
  'last-cycle':  'Last Cycle',  // the pay cycle before that
  'custom':      'Custom',
};
// Pay cycle = 21st of month M → 20th of month M+1 inclusive.
// "This cycle" is whichever cycle includes today.
function payCycleFor(d) {
  const x = new Date(d);
  const y = x.getFullYear(), m = x.getMonth(), day = x.getDate();
  // If today is on or after the 21st, current cycle starts THIS month's 21st.
  // Otherwise it started LAST month's 21st.
  const startMonth = day >= 21 ? m : m - 1;
  const from = new Date(y, startMonth, 21, 0,0,0);
  const to   = new Date(y, startMonth + 1, 20, 23,59,59);
  return { from, to, kind: 'month' };
}
function periodRange(p, customFrom, customTo) {
  const now = new Date();
  if (p === 'last-week') {
    const lw = new Date(now); lw.setDate(lw.getDate() - 7);
    return { from: startOfWeek(lw), to: endOfWeek(lw), kind: 'week' };
  }
  if (p === 'this-cycle') return payCycleFor(now);
  if (p === 'last-cycle') {
    const cur = payCycleFor(now);
    const before = new Date(cur.from); before.setDate(before.getDate() - 1);
    return payCycleFor(before);
  }
  if (p === 'custom' && customFrom && customTo) {
    return {
      from: new Date(customFrom + 'T00:00:00'),
      to:   new Date(customTo   + 'T23:59:59'),
      kind: 'month',
    };
  }
  return { from: startOfWeek(now), to: endOfWeek(now), kind: 'week' };
}
function periodLabel(p, range) {
  const r = range || periodRange(p, state.tsCustomFrom, state.tsCustomTo);
  if (r.kind === 'week') return weekLabel(r.from);
  // For cycle / custom ranges, show "21 Apr – 20 May 2026".
  const f = (d) => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  return `${f(r.from)} – ${f(r.to)} ${r.to.getFullYear()}`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function csvEscape(s) {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function downloadCSV(filename, rows) {
  // UTF-8 BOM so Excel renders diacritics; CRLF so rows split on Windows.
  const csv = '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function fmtDateRange(a, b) {
  if (!a) return '';
  const da = new Date(a); const db = b ? new Date(b) : da;
  if (isNaN(da)) return a;
  const f = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (!b || a === b) return f(da);
  return f(da) + ' – ' + f(db);
}

// ───── ICONS ────────────────────────────────────────────────────────
const I = {
  grid:      '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="3"/><path d="M9 4.5a3 3 0 0 1 6 0M9 11h6M9 15h4"/>',
  calendar:  '<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9h17M8 3v3M16 3v3"/>',
  users:     '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 7.5a3 3 0 0 1 0 5.8M16.5 19a5.4 5.4 0 0 0-1.3-3.5"/>',
  map:       '<path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6 9 3.5ZM9 3.5V18M15 6v14.5"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  coffee:    '<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"/><path d="M17 9h2.2a2.3 2.3 0 0 1 0 4.6H17M7 3.5c-.5.8-.5 1.5 0 2.3M11 3.5c-.5.8-.5 1.5 0 2.3"/>',
  chart:     '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  check:     '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search:    '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  download:  '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 19.5h15"/>',
  filter:    '<path d="M4 6h16M7 12h10M10 18h4"/>',
  pin:       '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  mail:      '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7.5l8 5.5 8-5.5"/>',
  sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  bell:      '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  chevron:   '<path d="M9 6l6 6-6 6"/>',
  logout:    '<path d="M14 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M10 12h10m0 0-3-3m3 3-3 3"/>',
  gear:      '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.2 7l2.2 1.3M17.6 15.7l2.2 1.3M19.8 7l-2.2 1.3M6.4 15.7 4.2 17M2.5 12h2.6M18.9 12h2.6"/>',
};
function icon(name, size = 20, stroke = 'currentColor', sw = 1.8) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0">${I[name] || ''}</svg>`;
}

// ───── DATA LOAD ─────────────────────────────────────────────────────
async function loadAll() {
  state.loading = true; state.error = null; render();
  try {
    const now = new Date();
    const from = startOfWeek(now).toISOString();
    const to = endOfWeek(now).toISOString();
    const [team, summary, leave, roster, events] = await Promise.all([
      api('team_today', {}),
      api('summary', { from, to }),
      api('leave_list', {}),
      // Admin always loads the FULL roster so archived staff's historical
      // clocks still aggregate in timesheets/payroll. The Team view filters
      // for display via state.showArchived.
      api('roster', { include_inactive: true }),
      api('events', { from, to }),
    ]);
    state.data.team = team.team || [];
    state.data.summary = summary.summary || [];
    state.data.leave = (leave.leave || []).map(l => ({ ...l, dates: fmtDateRange(l.start_date, l.end_date) }));
    state.data.roster = roster.roster || [];
    state.data.weekEvents = events.events || [];
    // Today's absences power the Dashboard's Absent stat + per-row
    // 'Absent · Sick' pill in the 'Who's working now' table.
    state.data.absencesToday = await loadAbsencesToday();
    // Clock-in notifications (admin CRUD source + caller popup).
    try { state.data.notices = ((await api('notification_list')) || {}).notifications || []; }
    catch { state.data.notices = []; }
    // SA public holidays (unpaid, same rule as absence). Loaded once per
    // session so the Variant A timesheet + payroll flags them without
    // re-fetching. Map<observed_date_ymd, {name, observed, date}>.
    if (!state.data.publicHolidays || state.data.publicHolidays.size === 0) {
      state.data.publicHolidays = await loadPublicHolidays();
    }
    // Canonical teams for the timesheet team picker — payroll allocates hours
    // by these. Loaded once per session; degrades to teams already seen in
    // notes if the table can't be read.
    if (!state.data.payrollTeams || !state.data.payrollTeams.length) {
      try {
        const tr = await window.sb.from('payroll_canonical_divisions').select('name').order('name');
        state.data.payrollTeams = (tr.data || []).map(x => x.name).filter(Boolean);
      } catch { state.data.payrollTeams = []; }
    }
    // Initial Timesheets payload mirrors the dashboard's current-week events.
    if (state.tsPeriod === 'this-week') {
      state.data.tsEvents = state.data.weekEvents;
      const r = periodRange('this-week');
      state.data.tsAbsences = await loadTsAbsences(r.from.toISOString(), r.to.toISOString());
    }
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false; render();
  }
}

// SA public holidays are UNPAID at Quay 1 (same rule as absence / sick).
// Load the seed table once per session and cache in state.data.publicHolidays
// as a Map<date-string, {name, observed}>. Payroll aggregation and the
// Variant A timesheet consult this to zero paid hours on holiday days.
async function loadPublicHolidays() {
  if (!window.sb) return new Map();
  try {
    const { data, error } = await window.sb
      .from('sa_public_holidays')
      .select('date,name,observed_date');
    if (error) throw error;
    const m = new Map();
    (data || []).forEach(r => {
      const key = r.observed_date || r.date;
      m.set(key, { name: r.name, observed: r.observed_date, date: r.date });
    });
    return m;
  } catch (e) {
    console.warn('[public-holidays] load failed', e);
    return new Map();
  }
}

async function loadAbsencesToday() {
  if (!window.sb) return [];
  try {
    const _ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const today = _ymd(new Date());
    const { data, error } = await window.sb
      .from('absences')
      .select('staff_id,reason,reason_note')
      .eq('date', today);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[absences-today] load failed', e);
    return [];
  }
}

async function loadTsAbsences(fromIso, toIso) {
  if (!window.sb) return [];
  try {
    const fromDate = fromIso.slice(0, 10);
    const toDate   = toIso.slice(0, 10);
    const { data, error } = await window.sb
      .from('absences')
      .select('staff_id,date,reason,reason_note,marked_by')
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[ts-absences] load failed', e);
    return [];
  }
}

async function loadTsEvents(period) {
  state.tsPeriod = period;
  // Custom range only loads when explicitly applied — wait for Apply click.
  if (period === 'custom' && (!state.tsCustomFrom || !state.tsCustomTo)) {
    state.data.tsEvents = [];
    state.data.tsAbsences = [];
    render(); return;
  }
  const r = periodRange(period, state.tsCustomFrom, state.tsCustomTo);
  if (period === 'this-week' && state.data.weekEvents) {
    state.data.tsEvents = state.data.weekEvents;
    state.data.tsAbsences = await loadTsAbsences(r.from.toISOString(), r.to.toISOString());
    render(); return;
  }
  state.loading = true; render();
  try {
    const [data, absences] = await Promise.all([
      api('events', { from: r.from.toISOString(), to: r.to.toISOString() }),
      loadTsAbsences(r.from.toISOString(), r.to.toISOString()),
    ]);
    state.data.tsEvents = data.events || [];
    state.data.tsAbsences = absences;
    state.error = null;
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false; render();
  }
}

// ───── RENDER ────────────────────────────────────────────────────────
function render() {
  if (!state.admin) { $root.innerHTML = renderGate(); wireGate(); return; }
  $root.innerHTML = `<div class="app ${EMBED ? 'app-embed' : ''}">
    ${EMBED ? renderTopNav() : renderSidebar()}
    <div class="pane">
      ${renderTopbar()}
      <div class="body" id="adminBody">
        ${state.error ? `<div class="banner">${escapeHtml(state.error)}</div>` : ''}
        ${state.loading && !state.data.team ? `<div class="loading">Loading…</div>` : renderView()}
      </div>
    </div>
  </div>`;
  wireShell();
}

// ── Sidebar ──────────────────────────────────────────────────────────
function renderSidebar() {
  const items = [
    ['dashboard','grid','Dashboard'],
    ['timesheets','clipboard','Timesheets'],
    ['leave','calendar','Requests'],
    ['team','users','Team'],
    ['notice','bell','Notice'],
  ];
  return `<div class="sidebar">
    <div class="logo"><img src="../assets/quay1-logo-white.png" alt="Quay 1"></div>
    <div class="section">MANAGE</div>
    <div>
      ${items.map(([k, ic, label]) => `
        <button class="nav-item ${k === state.view ? 'on' : ''}" data-view="${k}">
          ${icon(ic, 20, k === state.view ? 'var(--yellow)' : 'rgba(255,255,255,0.55)', 1.9)}
          <span>${label}</span>
        </button>
      `).join('')}
    </div>
    <div class="me">
      <div class="av" style="background:${avColor(0)};width:36px;height:36px;font-size:13px">${initials(state.admin.name)}</div>
      <div class="who">
        <div class="n">${escapeHtml(state.admin.name)}</div>
        <div class="r">${escapeHtml(state.admin.role || 'Admin')}</div>
      </div>
    </div>
    <button class="signout" id="signOut">Sign out</button>
  </div>`;
}

// ── Top nav (embed mode) ─────────────────────────────────────────────
function renderTopNav() {
  const items = [
    ['dashboard','grid','Dashboard'],
    ['timesheets','clipboard','Timesheets'],
    ['leave','calendar','Requests'],
    ['team','users','Team'],
    ['notice','bell','Notice'],
  ];
  return `<div class="topnav">
    ${items.map(([k, ic, label]) => `
      <button class="nav-item ${k === state.view ? 'on' : ''}" data-view="${k}">
        ${icon(ic, 18, k === state.view ? 'var(--yellow)' : 'rgba(255,255,255,0.6)', 1.9)}
        <span>${label}</span>
      </button>
    `).join('')}
    <div class="topnav-spacer"></div>
    <div class="me-mini" title="${escapeHtml(state.admin.name)}">
      <div class="av" style="background:${avColor(0)};width:30px;height:30px;font-size:11.5px">${initials(state.admin.name)}</div>
      <span>${escapeHtml(state.admin.name)}</span>
    </div>
    <button class="signout-mini" id="signOut" title="Sign out">${icon('logout', 16, 'rgba(255,255,255,0.75)')}</button>
  </div>`;
}

// ── Topbar ───────────────────────────────────────────────────────────
const TITLES = {
  dashboard:  ['Dashboard',  'Live overview of your team today'],
  timesheets: ['Timesheets', 'Review & approve hours'],
  leave:      ['Requests',   'Shift-time corrections'],
  team:       ['Team',       'Staff directory & status'],
  notice:     ['Notice',     'Clock-in reminder shown to callers'],
};
function renderTopbar() {
  const [t, sub] = TITLES[state.view] || ['', ''];
  const now = new Date();
  // In embed mode the parent dashboard already shows the section title
  // in its own topbar — rendering ours below it gives two stacked titles.
  // Drop the title block and right-align the controls.
  return `<div class="topbar${EMBED ? ' topbar-embed' : ''}">
    ${EMBED ? '' : `<div>
      <h1>${escapeHtml(t)}</h1>
      <div class="sub">${escapeHtml(sub)}</div>
    </div>`}
    <div class="right">
      <div class="search">
        ${icon('search', 17, 'var(--muted)')}
        <input id="adminSearch" type="text" placeholder="Search staff…">
      </div>
      <button class="btn small" id="exportBtn">${icon('download', 16)} Export</button>
      <button class="btn small" id="refreshBtn" title="Reload data">${icon('chart', 16)} Refresh</button>
      <div class="clock">
        <div class="t">${fmtTime(now)}</div>
        <div class="d">${now.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })}</div>
      </div>
    </div>
  </div>`;
}

function wireShell() {
  document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.view; render();
  }));
  const so = document.getElementById('signOut');
  if (so) so.addEventListener('click', async () => {
    try { await window.QD.call('logout', {}); } catch {}
    writeSession(null); state.admin = null;
    state.pinBuf = ''; state.pinErr = false; state.error = null;
    render();
  });
  const refresh = document.getElementById('refreshBtn');
  if (refresh) refresh.addEventListener('click', loadAll);
  const exp = document.getElementById('exportBtn');
  if (exp) exp.addEventListener('click', exportCurrent);
  const search = document.getElementById('adminSearch');
  if (search) {
    search.value = state.search || '';
    search.addEventListener('input', e => {
      state.search = e.target.value;
      applySearchFilter();
    });
  }
  // view-specific wiring
  if (state.view === 'dashboard')  wireDashboard();
  if (state.view === 'leave')      wireLeave();
  if (state.view === 'timesheets') wireTimesheets();
  if (state.view === 'team')       wireTeam();
  if (state.view === 'notice')     wireNotice();
  applySearchFilter();
}

function applySearchFilter() {
  const q = (state.search || '').trim().toLowerCase();
  document.querySelectorAll('tr[data-search]').forEach(row => {
    if (!q) { row.style.display = ''; return; }
    row.style.display = row.dataset.search.includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.team-card[data-search]').forEach(c => {
    if (!q) { c.style.display = ''; return; }
    c.style.display = c.dataset.search.includes(q) ? '' : 'none';
  });
}

function renderView() {
  switch (state.view) {
    case 'dashboard':  return renderDashboard();
    case 'timesheets': return renderTimesheets();
    case 'leave':      return renderLeave();
    case 'team':       return renderTeam();
    case 'notice':     return renderNotice();
    default:           return '';
  }
}

// ───── NOTICE (clock-in reminder) ────────────────────────────────────
// Admins compose a short message that pops up to callers when they open
// the Clock In/Out app in the morning. Data via notification_* handlers.
function renderNotice() {
  const notices = state.data.notices || [];
  const edit = state.noticeEdit || { id: null, message: '', active: true, trigger: 'clock_in' };
  const whenLabel = (t) => t === 'clock_out' ? 'On clock-out' : 'On clock-in';
  const rows = notices.length ? notices.map(n => `
    <tr>
      <td style="max-width:400px">${escapeHtml(n.message)}</td>
      <td>${whenLabel(n.trigger)}</td>
      <td>${n.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Off</span>'}</td>
      <td class="muted" style="font-size:12px">${escapeHtml(n.created_by || '—')}</td>
      <td style="white-space:nowrap;text-align:right">
        <button class="btn" data-notice-toggle="${n.id}">${n.active ? 'Turn off' : 'Turn on'}</button>
        <button class="btn" data-notice-edit="${n.id}">Edit</button>
        <button class="btn" data-notice-del="${n.id}" style="color:#C0392B">Delete</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">No notifications yet — add one above.</td></tr>`;
  const trig = edit.trigger || 'clock_in';
  return `
    <div class="card" style="padding:18px 20px;margin-bottom:16px">
      <h3 style="margin:0 0 4px">${edit.id ? 'Edit notification' : 'New notification'}</h3>
      <p class="muted" style="margin:0 0 12px;font-size:13px">Pops up to a caller when they clock in (morning reminder) or clock out (end-of-day reminder). Example: “Kind reminder to be at Obs tomorrow.”</p>
      <textarea id="noticeMsg" rows="3" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line,#d8dee4);border-radius:8px;font:inherit" placeholder="Type the reminder callers should see…">${escapeHtml(edit.message)}</textarea>
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin:12px 0">
        <label style="display:flex;align-items:center;gap:8px;font-size:14px">
          Show
          <select id="noticeTrigger" style="padding:7px 10px;border:1px solid var(--line,#d8dee4);border-radius:8px;font:inherit">
            <option value="clock_in" ${trig === 'clock_in' ? 'selected' : ''}>on clock-in</option>
            <option value="clock_out" ${trig === 'clock_out' ? 'selected' : ''}>on clock-out</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px">
          <input type="checkbox" id="noticeActive" ${edit.active ? 'checked' : ''}> Active (show to callers)
        </label>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="noticeSave">${edit.id ? 'Save changes' : 'Add notification'}</button>
        ${edit.id ? '<button class="btn" id="noticeCancel">Cancel</button>' : ''}
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table class="tbl" style="width:100%">
        <thead><tr><th>Message</th><th>When</th><th>Status</th><th>By</th><th style="text-align:right">Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function reloadNotices() {
  const res = await api('notification_list');
  state.data.notices = (res && res.notifications) || [];
}

function wireNotice() {
  const save = document.getElementById('noticeSave');
  if (save) save.addEventListener('click', async () => {
    if (save.disabled) return;
    const msg = (document.getElementById('noticeMsg') || {}).value || '';
    const active = !!((document.getElementById('noticeActive') || {}).checked);
    const trigger = (document.getElementById('noticeTrigger') || {}).value || 'clock_in';
    if (!msg.trim()) { showToast('Type a message first'); return; }
    save.disabled = true;
    const res = await api('notification_save', {
      id: (state.noticeEdit && state.noticeEdit.id) || null, message: msg, active, trigger,
    });
    if (!res || res.ok === false) { showToast((res && res.error) || 'Save failed'); save.disabled = false; return; }
    state.noticeEdit = null;
    showToast('Notification saved');
    await reloadNotices(); render();
  });
  const cancel = document.getElementById('noticeCancel');
  if (cancel) cancel.addEventListener('click', () => { state.noticeEdit = null; render(); });
  document.querySelectorAll('[data-notice-edit]').forEach(b => b.addEventListener('click', () => {
    const n = (state.data.notices || []).find(x => x.id === b.dataset.noticeEdit);
    if (n) { state.noticeEdit = { id: n.id, message: n.message, active: n.active, trigger: n.trigger || 'clock_in' }; render(); }
  }));
  document.querySelectorAll('[data-notice-del]').forEach(b => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this notification?')) return;
    const res = await api('notification_delete', { id: b.dataset.noticeDel });
    if (!res || res.ok === false) { showToast((res && res.error) || 'Delete failed'); return; }
    if (state.noticeEdit && state.noticeEdit.id === b.dataset.noticeDel) state.noticeEdit = null;
    await reloadNotices(); render();
  }));
  document.querySelectorAll('[data-notice-toggle]').forEach(b => b.addEventListener('click', async () => {
    const n = (state.data.notices || []).find(x => x.id === b.dataset.noticeToggle);
    if (!n) return;
    const res = await api('notification_save', { id: n.id, message: n.message, active: !n.active, trigger: n.trigger || 'clock_in' });
    if (!res || res.ok === false) { showToast((res && res.error) || 'Update failed'); return; }
    await reloadNotices(); render();
  }));
}

// ───── DASHBOARD ─────────────────────────────────────────────────────
function renderDashboard() {
  const team = state.data.team || [];
  // Drop admins / managers from the dashboard counters too — same
  // treatment as the timesheets.
  const exempt = exemptIdsFromRoster();
  const trackable = team.filter(t => !exempt.has(t.id));
  // Map staff_id -> absence record so we can pill them in the table.
  const absById = new Map();
  (state.data.absencesToday || []).forEach(a => absById.set(a.staff_id, a));
  const onNow = trackable.filter(s => s.status === 'in').length;
  const absentNow = trackable.filter(s => s.status !== 'in' && absById.has(s.id)).length;
  const hoursToday = trackable.reduce((s, t) => s + (t.todayHrs || 0), 0);
  const pending = (state.data.leave || []).filter(l => l.status === 'Pending');
  const offToday = Math.max(0, trackable.filter(s => s.status !== 'in').length - absentNow);

  return `
    <div class="stat-row">
      ${statCard('clock',     'var(--green)', 'var(--greenBg)', 'On the clock',   String(onNow), `of ${trackable.length} staff`)}
      ${absentNow > 0
        ? statCard('users',   'var(--amber)', 'var(--amberBg)', 'Absent today',   String(absentNow), 'accounted for')
        : statCard('clipboard', 'var(--amber)', 'var(--amberBg)', 'Pending requests', String(pending.length), pending.length ? 'needs your review' : 'all caught up')}
      ${statCard('users',     'var(--blue)',  'var(--skySoft)', 'Not in yet',     String(offToday), 'staff still clocked out')}
      ${statCard('chart',     'var(--ink)',   '#EEF0F6',        'Hours today',    fmtHM(hoursToday), 'across the team')}
    </div>

    <div class="dash-grid">
      <div class="card left" style="overflow:hidden">
        <div class="card-head">
          <div style="display:flex;align-items:center;gap:10px">
            <h3>Who's working now</h3>
            <span class="live"><span class="dot"></span>Live</span>
          </div>
          <button class="btn small" id="dashCsv">${icon('download', 15)} CSV</button>
        </div>
        <div class="live-now-wrap">
          <table class="live-now-table">
            <thead><tr>
              <th>Employee</th><th>Status</th><th>Clock-in</th>
              <th>Today</th><th class="live-now-note-col">Shift note</th>
            </tr></thead>
            <tbody>
              ${trackable.length === 0 ? `<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">No staff in the roster yet.</td></tr>` : ''}
              ${trackable.map((s, i) => {
                const ab = absById.get(s.id);
                const tag = (ab && s.status !== 'in')
                  ? `<span class="tag" style="background:#FFE9CB;color:#6B3F00;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700" title="${escapeHtml(ab.reason)}${ab.reason_note ? ' — ' + escapeHtml(ab.reason_note) : ''}">● Absent · ${escapeHtml(ab.reason)}</span>`
                  : tagFor(s.status);
                return `<tr class="${(s.status === 'off' || s.status === 'leave') ? 'dim' : ''}" data-search="${escapeHtml(((s.name||'') + ' ' + (s.role||'') + ' ' + (s.id||'')).toLowerCase())}">
                <td>
                  <div class="nm">
                    <div class="av" style="background:${avColor(i)};width:34px;height:34px;font-size:12.5px">${initials(s.name)}</div>
                    <div class="who"><div class="n">${escapeHtml(s.name)}</div><div class="r">${escapeHtml(s.role || '')}</div></div>
                  </div>
                </td>
                <td>${tag}</td>
                <td class="tnum">${s.cin || '—'}</td>
                <td class="tnum" style="color:var(--blue);font-weight:800">${fmtHM(s.todayHrs || 0)}</td>
                <td class="muted live-now-note-col"><div class="live-now-note">${escapeHtml(ab && ab.reason_note ? ab.reason_note : (s.note || '—'))}</div></td>
              </tr>`;}).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="right">
        <div class="card">
          <div class="card-head">
            <h3>Pending approvals</h3>
            <span class="pill-st Pending">${pending.length}</span>
          </div>
          <div style="padding: 4px 20px 18px">
            ${pending.length === 0
              ? `<div class="muted" style="font-size:13px;font-weight:500;padding:10px 0">All caught up — nothing to review.</div>`
              : pending.map(l => `<div class="appr-row" data-leave="${l.id}">
                  <div class="appr-head">
                    <div class="av" style="background:${avColor(hashIdx(l.agent_name))};width:30px;height:30px;font-size:11.5px">${initials(l.agent_name)}</div>
                    <div class="who">
                      <div class="n">${escapeHtml(l.agent_name)}</div>
                      <div class="m">${escapeHtml(l.type)} · ${l.days || 1} ${(l.days || 1) === 1 ? 'day' : 'days'}</div>
                    </div>
                  </div>
                  <div class="appr-when">${icon('calendar', 13, 'var(--blue)')} ${escapeHtml(fmtDateRange(l.start_date, l.end_date))}</div>
                  <div class="appr-actions">
                    <button class="btn small success" data-act="Approved">${icon('check', 14, '#fff')} Approve</button>
                    <button class="btn small danger" data-act="Declined">Decline</button>
                  </div>
                </div>`).join('')}
          </div>
        </div>

        <div class="card" style="padding:18px 20px">
          <h3 style="font-size:15.5px;font-weight:800">Team hours · this week</h3>
          ${renderWeekHoursChart()}
        </div>

        <div class="card" style="padding:18px 20px">
          <h3 style="font-size:15.5px;font-weight:800">Weekly target · progress</h3>
          ${renderWeeklyTargetProgress(team)}
        </div>
      </div>
    </div>
  `;
}

// Per-staff weekly clocked-hours vs each staffer's own contracted target
// (staff.weekly_hours), falling back to the 45h house default if unset.
// Sorted most-behind-first so the dashboard surfaces who still owes
// hours before week-end. Admin / manager rows are excluded (they're
// exempt from clock-in tracking).
//
// Audit finding B4 (P1): was previously hardcoded to 45h for everyone,
// so a staffer contracted for 40h read as under-target.
const WEEKLY_TARGET_HOURS = 45;

function renderWeeklyTargetProgress(team) {
  const events = state.data.weekEvents || [];
  const exempt = exemptIdsFromRoster();
  // Pair-first: never trust raw duration_hrs for weekly-target bars —
  // manually-added shifts have null duration and stale caches are common
  // (Matthew Hallett / Warrick 24:39 pattern).
  const hoursById = new Map();
  pairShifts(events).forEach(sh => {
    if (exempt.has(sh.staff_id)) return;
    if (sh.hrs > 0) hoursById.set(sh.staff_id, (hoursById.get(sh.staff_id) || 0) + sh.hrs);
  });
  // Show every non-exempt staff member with THEIR OWN contracted target.
  const rows = team
    .filter(s => !exempt.has(s.id))
    .map(s => {
      const hrs = Number(hoursById.get(s.id) || 0);
      const target = (s.weekly_hours != null && s.weekly_hours > 0)
        ? Number(s.weekly_hours)
        : WEEKLY_TARGET_HOURS;
      const pct = Math.min(999, (hrs / target) * 100);
      return { id: s.id, name: s.name, role: s.role, hrs, target, pct };
    })
    .sort((a, b) => a.pct - b.pct);  // most-behind first

  if (rows.length === 0) {
    return `<div class="muted" style="font-size:13px;font-weight:500;padding:10px 0">No staff with hours or weekly targets yet.</div>`;
  }

  return `<div class="wkt-list">
    ${rows.map(r => {
      const targetLabel = `${r.hrs.toFixed(1)} / ${r.target}h`;
      // Colour bands: <60% red, 60–89% amber, ≥90% green.
      const tone = r.pct >= 90 ? 'ok'
                 : r.pct >= 60 ? 'warn'
                 : 'low';
      const barPct = Math.min(100, r.pct);
      return `<div class="wkt-row">
        <div class="wkt-meta">
          <span class="wkt-name">${escapeHtml(r.name)}</span>
          <span class="wkt-val tnum ${tone}">${escapeHtml(targetLabel)} · ${r.pct.toFixed(0)}%</span>
        </div>
        <div class="wkt-bar"><div class="wkt-fill ${tone}" style="width:${barPct.toFixed(1)}%"></div></div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderWeekHoursChart() {
  const events = state.data.weekEvents || [];
  const byDay = [0,0,0,0,0,0,0];
  // Pair-first — attribute each shift's real duration to the OUT day
  // instead of trusting duration_hrs which drops manual shifts.
  pairShifts(events).forEach(sh => {
    if (sh.hrs <= 0) return;
    const idx = (new Date(sh.out_ts).getDay() + 6) % 7;
    byDay[idx] += sh.hrs;
  });
  const max = Math.max(9, ...byDay);
  const todayIdx = (new Date().getDay() + 6) % 7;
  const labels = ['M','T','W','T','F','S','S'];
  return `<div class="thbox">
    ${byDay.map((v, i) => {
      const h = Math.max(2, (v / max) * 100).toFixed(0);
      const today = i === todayIdx;
      return `<div class="tcol">
        <div style="flex:1;width:100%;display:flex;align-items:flex-end">
          <div class="tbar ${today ? 'today' : ''}" style="height:${h}%" title="${labels[i]}: ${v.toFixed(1)}h"></div>
        </div>
        <span class="tdate ${today ? 'today' : ''}">${labels[i]}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function wireDashboard() {
  document.querySelectorAll('.appr-row').forEach(row => {
    const id = row.dataset.leave;
    row.querySelectorAll('button[data-act]').forEach(b =>
      b.addEventListener('click', () => decideLeave(id, b.dataset.act))
    );
  });
  const csv = document.getElementById('dashCsv');
  if (csv) csv.addEventListener('click', () => exportTeamCSV());
}

async function decideLeave(id, status) {
  if (!state.admin) { state.error = 'Admin session expired — sign in again.'; render(); return; }
  try {
    await api('leave_decide', { id, status });
    // optimistic update
    (state.data.leave || []).forEach(l => { if (l.id === id) { l.status = status; l.decided_by = state.admin.name; } });
    render();
  } catch (e) {
    state.error = e.message; render();
  }
}

function statCard(ic, color, bg, label, value, sub) {
  return `<div class="card stat-card">
    <div class="head">
      <span class="lbl">${escapeHtml(label)}</span>
      <span class="ic" style="background:${bg}">${icon(ic, 19, color, 2)}</span>
    </div>
    <div class="val">${escapeHtml(value)}</div>
    <div class="sub">${escapeHtml(sub)}</div>
  </div>`;
}
function tagFor(status) {
  if (status === 'in')    return `<span class="tag on"><span class="dot"></span>On the clock</span>`;
  if (status === 'break') return `<span class="tag break"><span class="dot"></span>On break</span>`;
  if (status === 'leave') return `<span class="tag leave"><span class="dot"></span>On leave</span>`;
  return `<span class="tag off"><span class="dot"></span>Clocked out</span>`;
}
function hashIdx(s) { let h = 0; for (let i = 0; i < (s||'').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % AV.length; }

function isToday(start, end) {
  if (!start) return false;
  const today = sastYmd();
  return today >= start && today <= (end || start);
}

// ───── TIMESHEETS ────────────────────────────────────────────────────
function renderTimesheets() {
  const period = state.tsPeriod || 'this-week';
  const range = periodRange(period, state.tsCustomFrom, state.tsCustomTo);
  const layout = state.tsLayout || 'grid';

  const periodChips = ['this-week','last-week','this-cycle','last-cycle','custom']
    .map(p => `<button class="seg-btn ${p === period ? 'on' : ''}" data-ts-period="${p}">${PERIOD_LABELS[p]}</button>`)
    .join('');
  const layoutChips = ['grid','list']
    .map(l => `<button class="seg-btn ${l === layout ? 'on' : ''}" data-ts-layout="${l}">${l === 'grid' ? 'Grid' : 'List'}</button>`)
    .join('');
  const customInputs = period === 'custom' ? `
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
      <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase">From</label>
      <input id="tsCustomFrom" type="date" value="${state.tsCustomFrom || range.from.toISOString().slice(0,10)}"
             style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-family:Montserrat,sans-serif;font-size:13px">
      <label style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase">To</label>
      <input id="tsCustomTo" type="date" value="${state.tsCustomTo || range.to.toISOString().slice(0,10)}"
             style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-family:Montserrat,sans-serif;font-size:13px">
      <button class="btn small primary" id="tsCustomApply">Apply</button>
    </div>
  ` : '';

  // #30 — small staff-name filter input at the top of the Timesheets table
  // for admins (alongside the existing global topbar search). Wires into
  // state.search so applySearchFilter() filters the rows in place.
  const tsSearchInput = `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:#fff">
      ${icon('search', 14, 'var(--muted)')}
      <input id="tsLocalSearch" type="text" placeholder="Filter staff…"
             value="${escapeHtml(state.search || '')}"
             style="border:0;outline:0;font-family:Montserrat,sans-serif;font-size:13px;padding:2px 0;background:transparent;min-width:160px">
    </div>`;

  const header = `<div class="card-head" style="flex-wrap:wrap;gap:10px">
    <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;flex-direction:column">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h3>${escapeHtml(periodLabel(period, range))}</h3>
        <div class="seg-pills" role="tablist">${periodChips}</div>
        <div class="seg-pills" role="tablist" style="margin-left:4px">${layoutChips}</div>
        ${tsSearchInput}
      </div>
      ${customInputs}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn small" id="tsMarkAbsent">${icon('calendar', 15)} Mark absent</button>
      <button class="btn small" id="tsCsv">${icon('download', 15)} Export ${layout === 'list' ? 'Connecteam CSV' : 'CSV'}</button>
    </div>
  </div>`;

  const body = layout === 'list'
    ? renderTimesheetsList(range)
    : renderTimesheetsGrid(range);

  return `<div class="card" style="overflow:hidden">
    ${header}
    ${body}
    ${state.eventEditor ? renderEventEditor() : ''}
    ${state.tsDetail ? renderTsDetail() : ''}
    ${state.absenceMarker ? renderAbsenceMarker() : ''}
  </div>`;
}

// Admin / Manager / Super admin staff don't need to appear on timesheets
// — they're not callers and were just adding noise to the grid + list.
// Mirrors the dashboard's isExemptStaff() predicate.
function isExemptRoster(s) {
  if (!s) return false;
  if (s.admin || s.super) return true;
  const role = String(s.role || '').toLowerCase();
  return role === 'manager' || role === 'admin' || role === 'super admin' || role === 'super_admin';
}
function exemptIdsFromRoster() {
  return new Set((state.data.roster || []).filter(isExemptRoster).map(r => r.id));
}

function renderTimesheetsGrid(range) {
  const period = state.tsPeriod || 'this-week';
  const events = state.data.tsEvents || [];
  const roster = state.data.roster || [];
  const exempt = exemptIdsFromRoster();
  const isMonth = range.kind === 'month';
  const cols = isMonth ? monthlyBuckets(range) : weeklyBuckets(range);
  const grid = {};
  roster.forEach(a => {
    if (exempt.has(a.id)) return;
    grid[a.id] = { name: a.name, role: a.role, vals: cols.map(_ => 0), total: 0, days: {} };
  });
  // Pair IN→OUT per staff before bucketing into columns. Manually-added
  // events (via the admin Edit-events modal) come in with duration_hrs
  // = null; the old `if (action !== 'out' || duration_hrs == null) return`
  // dropped them entirely, which is what made Bronwyn read 'No show'
  // despite a real clock-in + clock-out. We compute hrs from the
  // timestamps as a fallback so both the auto and manual paths count.
  const byStaff = new Map();
  events.forEach(e => {
    if (exempt.has(e.id)) return;
    if (!byStaff.has(e.id)) byStaff.set(e.id, []);
    byStaff.get(e.id).push(e);
  });
  byStaff.forEach((evs, staffId) => {
    evs.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    let openIn = null;
    for (const e of evs) {
      if (e.action === 'in') { openIn = e; continue; }
      if (e.action !== 'out') continue;
      const outTs = new Date(e.ts).getTime();
      // Anchor the shift to its IN time so a 22:00→02:00 shift counts in
      // the day it started, not the day it ended.
      const inTs  = openIn ? new Date(openIn.ts).getTime() : outTs;
      // Always prefer the IN→OUT pair over the cached duration_hrs (which
      // goes stale when an admin edits a timestamp — the Matthew Hallett
      // 0.068h bug). Fall back to the cached value only for orphan OUTs
      // that have no paired IN to compute against.
      const hrs = openIn
        ? Math.max(0, (outTs - inTs) / 3.6e6)
        : (e.duration_hrs != null && !isNaN(e.duration_hrs) ? Number(e.duration_hrs) : 0);
      openIn = null;
      if (!grid[staffId]) {
        grid[staffId] = { name: e.name || staffId, role: '', vals: cols.map(_ => 0), total: 0, days: {} };
      }
      const idx = cols.findIndex(c => inTs >= c.from && inTs <= c.to);
      if (idx >= 0) {
        grid[staffId].vals[idx] += hrs;
        grid[staffId].total += hrs;
        const anchor = new Date(inTs);
        const dayKey = `${anchor.getFullYear()}-${String(anchor.getMonth()+1).padStart(2,'0')}-${String(anchor.getDate()).padStart(2,'0')}`;
        grid[staffId].days[dayKey] = (grid[staffId].days[dayKey] || 0) + hrs;
      }
    }
  });
  // Absence lookup: "staffId|YYYY-MM-DD" -> {reason, reason_note, ...}.
  // Drives the Absent pill in empty cells.
  const absByKey = new Map();
  (state.data.tsAbsences || []).forEach(a => absByKey.set(`${a.staff_id}|${a.date}`, a));
  // Per-col date key + weekday flag, computed once. Use local-time date
  // components (NOT toISOString) so a SAST browser viewing Monday's
  // 00:00 column maps to '2026-06-22' instead of '2026-06-21' UTC.
  const _localYmd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const colMeta = cols.map(c => {
    const d = new Date(c.from);
    return {
      dayKey:    _localYmd(d),
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
      isPast:    c.to < Date.now(),
    };
  });
  const rows = Object.entries(grid)
    .filter(([, v]) => v.total > 0 || roster.some(a => a.name === v.name))
    .sort((a, b) => b[1].total - a[1].total);

  return `<div class="ts-table-wrap ${isMonth ? 'ts-table-wrap--month' : ''}">
    <table class="ts-table ${isMonth ? 'ts-table--month' : ''}">
      <thead><tr>
        <th class="ts-emp-col">Employee</th>
        ${cols.map(c => {
          const parts = c.label.split(' '); // "Mon 3" → ["Mon", "3"] or "Mon" for weekly
          const isPair = parts.length === 2;
          return `<th class="ctr ${c.weekend ? 'ts-weekend' : ''}">${
            isPair ? `<span class="ts-day-name">${escapeHtml(parts[0])}</span><span class="ts-day-num">${escapeHtml(parts[1])}</span>` : escapeHtml(c.label)
          }</th>`;
        }).join('')}
        <th class="ctr ts-total-col">Total</th>
        <th class="r ts-act-col">View</th>
      </tr></thead>
      <tbody>
        ${rows.length === 0 ? `<tr><td colspan="${cols.length + 3}" class="muted" style="text-align:center;padding:30px">No clock-in data for ${escapeHtml(PERIOD_LABELS[period].toLowerCase())} yet.</td></tr>` : ''}
        ${rows.map(([id, v], i) => `<tr data-search="${escapeHtml(((v.name||'') + ' ' + (v.role||'') + ' ' + id).toLowerCase())}">
          <td class="ts-emp-col">
            <div class="nm">
              <div class="av" style="background:${avColor(i)};width:32px;height:32px;font-size:12px">${initials(v.name)}</div>
              <div class="who"><div class="n">${escapeHtml(v.name)}</div><div class="r">${escapeHtml(v.role || '')}</div></div>
            </div>
          </td>
          ${v.vals.map((h, ci) => {
            const cw = cols[ci].weekend ? 'ts-weekend' : '';
            if (h > 0) {
              return `<td class="ctr tnum ${cw}">${fmtHM(h)}</td>`;
            }
            const ab = absByKey.get(`${id}|${colMeta[ci].dayKey}`);
            if (ab) {
              const tip = `Absent · ${escapeHtml(ab.reason)}${ab.reason_note ? ' — ' + escapeHtml(ab.reason_note) : ''}`;
              return `<td class="ctr ${cw}" title="${tip}"><span class="pill" style="background:#FFE9CB;color:#6B3F00;padding:2px 7px;font-size:10.5px;font-weight:700;letter-spacing:.03em">Absent</span></td>`;
            }
            if (colMeta[ci].isPast && !colMeta[ci].isWeekend) {
              return `<td class="ctr ${cw}" title="No clock-in event and no absence marker"><span class="pill" style="background:#FFE0E0;color:#8B1A1A;padding:2px 7px;font-size:10.5px;font-weight:700;letter-spacing:.03em">No show</span></td>`;
            }
            return `<td class="ctr tnum ${cw}" style="color:var(--muted)">${fmtHM(h)}</td>`;
          }).join('')}
          <td class="ctr tnum ts-total-col" style="color:var(--blue);font-weight:800">${fmtHM(v.total)}</td>
          <td class="r ts-act-col">
            <button class="btn small" data-detail-events="${escapeHtml(id)}" data-name="${escapeHtml(v.name)}">View</button>
            <button class="btn small" data-edit-events="${escapeHtml(id)}" data-name="${escapeHtml(v.name)}" style="margin-left:6px">Edit</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

// ── Flat shift list (Connecteam-style) ───────────────────────────────
// Pairs IN→OUT events into shifts; computes daily + weekly totals so the
// table reads exactly like Connecteam's weekly-timesheet view. Used by
// both the on-screen list and the matching CSV export below.
function buildShiftRows(range) {
  // Drop admin / manager / super staff from BOTH the event stream and the
  // roster lookup so their rows + absences never reach the timesheet list.
  const exempt = exemptIdsFromRoster();
  const events = (state.data.tsEvents || [])
    .filter(e => !exempt.has(e.id))
    .filter(e => {
      const t = new Date(e.ts).getTime();
      return t >= range.from && t <= range.to;
    })
    .slice()
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const roster = (state.data.roster || []).filter(r => !exempt.has(r.id));
  const rosterById = Object.fromEntries(roster.map(r => [r.id, r]));

  // Pair IN with the next OUT for the same staffer.
  const openIns = {};
  const shifts = [];
  events.forEach(e => {
    if (e.action === 'in') { openIns[e.id] = e; return; }
    if (e.action === 'out') {
      const inE = openIns[e.id] || null;
      const inDate = inE ? new Date(inE.ts) : null;
      const outDate = new Date(e.ts);
      // Prefer the IN→OUT pair over the cached duration_hrs (which goes
      // stale when an admin edits a timestamp without recomputing — the
      // Matthew Hallett 0.068h bug). Fall back to the cached value only
      // when the OUT has no paired IN to compute against.
      const hrs = inDate
        ? Math.max(0, (outDate - inDate) / 3.6e6)
        : (e.duration_hrs != null && !isNaN(e.duration_hrs) ? Number(e.duration_hrs) : 0);
      shifts.push({
        agentId: e.id,
        agentName: e.name || (rosterById[e.id] && rosterById[e.id].name) || e.id,
        role: rosterById[e.id] ? (rosterById[e.id].role || '') : '',
        inDate, outDate, hrs,
        note: inE ? (inE.note || '') : (e.note || ''),
        mgrNote: '',
      });
      delete openIns[e.id];
    }
  });

  // Group: agent → day → shifts; compute daily + weekly totals.
  // Use local-date components so dayKey aligns with the absences.date
  // (DATE column in SAST) instead of drifting one day west via UTC.
  const _ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const byAgent = new Map();
  shifts.forEach(s => {
    const baseDate = s.inDate || s.outDate;
    const dayKey = _ymd(baseDate);
    const wkKey  = _ymd(startOfWeek(baseDate));
    if (!byAgent.has(s.agentId)) byAgent.set(s.agentId, {
      agentId: s.agentId, agentName: s.agentName, role: s.role,
      days: new Map(), weeks: new Map(), shifts: [],
    });
    const a = byAgent.get(s.agentId);
    a.shifts.push({ ...s, dayKey, wkKey });
    a.days.set(dayKey, (a.days.get(dayKey) || 0) + s.hrs);
    a.weeks.set(wkKey, (a.weeks.get(wkKey) || 0) + s.hrs);
  });

  // Track which (agent, day) already has a shift so we don't double-stamp
  // an absence row on top of a real clock-in (e.g. came in late despite
  // being marked absent).
  const shiftDayKeys = new Set();
  byAgent.forEach(a => a.shifts.forEach(s => shiftDayKeys.add(`${a.agentId}|${s.dayKey}`)));

  // Inject absence rows for (agent, day) combinations that have an
  // absence record AND no shift. Each absence row has no in/out time
  // and renders as a single 'Absent · <reason>' line in renderTimesheetsList.
  const absences = (state.data.tsAbsences || []).filter(a => {
    const t = new Date(a.date + 'T12:00:00').getTime();
    return t >= range.from && t <= range.to;
  });
  absences.forEach(a => {
    if (exempt.has(a.staff_id)) return;
    if (shiftDayKeys.has(`${a.staff_id}|${a.date}`)) return;
    const rosterRow = rosterById[a.staff_id];
    if (!byAgent.has(a.staff_id)) byAgent.set(a.staff_id, {
      agentId: a.staff_id,
      agentName: rosterRow ? rosterRow.name : a.staff_id,
      role: rosterRow ? (rosterRow.role || '') : '',
      days: new Map(), weeks: new Map(), shifts: [],
    });
    const bucket = byAgent.get(a.staff_id);
    const baseDate = new Date(a.date + 'T08:00:00');
    bucket.shifts.push({
      agentId: a.staff_id,
      agentName: bucket.agentName,
      role: bucket.role,
      inDate: baseDate, outDate: null, hrs: 0,
      note: a.reason_note || '',
      dayKey: a.date,
      wkKey:  _ymd(startOfWeek(baseDate)),
      absent: true,
      absentReason: a.reason,
    });
  });

  // Sort by name; each agent's shifts newest-first; flatten into rows so we
  // can stamp daily/weekly totals on the LAST row of each day/week (Connecteam).
  const rows = [];
  [...byAgent.values()]
    .sort((a, b) => a.agentName.localeCompare(b.agentName))
    .forEach(a => {
      const list = a.shifts.slice().sort((x, y) => (y.inDate || y.outDate) - (x.inDate || x.outDate));
      let lastDay = null, lastWeek = null;
      list.forEach(s => {
        const isLastForDay  = lastDay  !== s.dayKey;
        const isLastForWeek = lastWeek !== s.wkKey;
        rows.push({
          ...s,
          role: a.role,
          // Absence rows show '—' for daily/weekly totals instead of 0:00 so
          // they don't get mistaken for a real 0-hour shift.
          dailyTotal:  isLastForDay  ? (s.absent ? null : a.days.get(s.dayKey))  : null,
          weeklyTotal: isLastForWeek ? (s.absent ? null : a.weeks.get(s.wkKey)) : null,
        });
        lastDay  = s.dayKey;
        lastWeek = s.wkKey;
      });
    });
  return rows;
}

function renderTimesheetsList(range) {
  const rows = buildShiftRows(range);
  if (rows.length === 0) {
    return `<div class="ts-list-empty muted">No shifts in this period.</div>`;
  }
  const cell = (v, cls = '') =>
    `<td class="${cls}">${v == null || v === '' ? '<span class="muted">—</span>' : v}</td>`;
  return `<div class="ts-list-wrap">
    <table class="ts-list-table">
      <thead><tr>
        <th>Employee</th>
        <th>Role</th>
        <th>Date</th>
        <th class="ctr">In</th>
        <th class="ctr">Out</th>
        <th class="ctr">Shift</th>
        <th class="ctr">Daily</th>
        <th class="ctr">Weekly</th>
        <th>Notes</th>
        <th class="r"></th>
      </tr></thead>
      <tbody>
        ${rows.map((s, i) => {
          const d = s.inDate || s.outDate;
          const dateLbl = d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
          if (s.absent) {
            // Absence row — collapsed to a single 'Absent · <reason>' pill
            // spanning the in/out/shift columns. Daily/weekly totals show
            // '—' (set to null in buildShiftRows) so payroll math isn't
            // affected.
            return `<tr style="background:#FFF8EC">
              <td>
                <div class="nm">
                  <div class="av" style="background:${avColor(i)};width:28px;height:28px;font-size:11px">${initials(s.agentName)}</div>
                  <div class="who"><div class="n">${escapeHtml(s.agentName)}</div></div>
                </div>
              </td>
              ${cell(escapeHtml(s.role || ''))}
              ${cell(escapeHtml(dateLbl))}
              <td class="ctr" colspan="3"><span class="pill" style="background:#FFE9CB;color:#6B3F00;padding:3px 10px;font-size:11.5px;font-weight:700">Absent · ${escapeHtml(s.absentReason || 'Absent')}</span></td>
              <td class="ctr"><span class="muted">—</span></td>
              <td class="ctr"><span class="muted">—</span></td>
              ${cell(escapeHtml(s.note || ''))}
              <td class="r"></td>
            </tr>`;
          }
          return `<tr>
            <td>
              <div class="nm">
                <div class="av" style="background:${avColor(i)};width:28px;height:28px;font-size:11px">${initials(s.agentName)}</div>
                <div class="who"><div class="n">${escapeHtml(s.agentName)}</div></div>
              </div>
            </td>
            ${cell(escapeHtml(s.role || ''))}
            ${cell(escapeHtml(dateLbl))}
            <td class="ctr tnum">${s.inDate ? fmtTimeOf(s.inDate) : '<span class="muted">—</span>'}</td>
            <td class="ctr tnum">${s.outDate ? fmtTimeOf(s.outDate) : '<span class="muted">—</span>'}</td>
            <td class="ctr tnum" style="font-weight:700">${fmtHM(s.hrs)}</td>
            <td class="ctr tnum" style="${s.dailyTotal == null ? 'color:var(--muted)' : 'color:var(--ink);font-weight:700'}">${s.dailyTotal != null ? fmtHM(s.dailyTotal) : ''}</td>
            <td class="ctr tnum" style="${s.weeklyTotal == null ? 'color:var(--muted)' : 'color:var(--blue);font-weight:800'}">${s.weeklyTotal != null ? fmtHM(s.weeklyTotal) : ''}</td>
            ${cell(escapeHtml(s.note || ''))}
            <td class="r">
              <button class="btn small" data-detail-events="${escapeHtml(s.agentId)}" data-name="${escapeHtml(s.agentName)}">View</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

function weeklyBuckets(range) {
  // Anchor buckets to the SELECTED period's Monday so Last Week / custom
  // weeks render their own days. Without `range` we'd silently bucket the
  // current week's columns over any other period — events fall outside
  // and the grid renders 0:00 everywhere.
  const anchor = range ? new Date(range.from) : new Date();
  const sow = startOfWeek(anchor);
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return days.map((label, i) => {
    const d = new Date(sow); d.setDate(d.getDate() + i);
    const end = new Date(d); end.setHours(23,59,59,999);
    return { label, from: d.getTime(), to: end.getTime() };
  });
}
function monthlyBuckets(range) {
  // One bucket per day across the month — column header shows the
  // day-of-week + date number ("Mon 3"). Grid scrolls horizontally,
  // employee column is sticky via CSS so it stays visible.
  const out = [];
  const from = new Date(range.from);
  const to   = new Date(range.to);
  const cur  = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0,0,0);
  while (cur.getTime() <= to.getTime()) {
    const start = new Date(cur);
    const end   = new Date(cur); end.setHours(23,59,59,999);
    const dow = start.toLocaleDateString('en-GB', { weekday: 'short' });
    const isWeekend = start.getDay() === 0 || start.getDay() === 6;
    out.push({
      label: `${dow} ${start.getDate()}`,
      from: start.getTime(),
      to: end.getTime(),
      iso: start.toISOString().slice(0, 10),
      weekend: isWeekend,
    });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function wireTimesheets() {
  const csv = document.getElementById('tsCsv');
  if (csv) csv.addEventListener('click', exportTimesheetsCSV);
  document.querySelectorAll('button[data-ts-period]').forEach(b =>
    b.addEventListener('click', () => loadTsEvents(b.dataset.tsPeriod)));
  document.querySelectorAll('button[data-ts-layout]').forEach(b =>
    b.addEventListener('click', () => { state.tsLayout = b.dataset.tsLayout; render(); }));
  // Custom range inputs — when on the "Custom" tab.
  const cf = document.getElementById('tsCustomFrom');
  const ct = document.getElementById('tsCustomTo');
  const ca = document.getElementById('tsCustomApply');
  if (cf) cf.addEventListener('input', e => { state.tsCustomFrom = e.target.value; });
  if (ct) ct.addEventListener('input', e => { state.tsCustomTo   = e.target.value; });
  if (ca) ca.addEventListener('click', () => loadTsEvents('custom'));
  // #30 — local Timesheet filter mirrors the topbar search so admins can
  // narrow the roster to a specific staff member directly above the table.
  const localSearch = document.getElementById('tsLocalSearch');
  if (localSearch) {
    localSearch.addEventListener('input', e => {
      state.search = e.target.value;
      const top = document.getElementById('adminSearch');
      if (top) top.value = e.target.value;
      applySearchFilter();
    });
  }
  document.querySelectorAll('button[data-edit-events]').forEach(b => b.addEventListener('click', () => {
    openEventEditor(b.dataset.editEvents, b.dataset.name);
  }));
  document.querySelectorAll('button[data-detail-events]').forEach(b => b.addEventListener('click', () => {
    openTsDetail(b.dataset.detailEvents, b.dataset.name);
  }));
  const mab = document.getElementById('tsMarkAbsent');
  if (mab) mab.addEventListener('click', () => openAbsenceMarker());
  if (state.eventEditor) wireEventEditor();
  if (state.tsDetail) wireTsDetail();
  if (state.absenceMarker) wireAbsenceMarker();
}

// ── Per-employee detail modal — Connecteam-style ─────────────────────
function openTsDetail(agentId, agentName) {
  state.tsDetail = { agentId, agentName };
  render();
}
function renderTsDetail() {
  const d = state.tsDetail;
  const period = state.tsPeriod || 'this-week';
  const range = periodRange(period);
  const events = (state.data.tsEvents || [])
    .filter(e => e.id === d.agentId)
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  // Pair INs with OUTs → flat list of shifts.
  const shifts = [];
  let openIn = null;
  events.forEach(e => {
    if (e.action === 'in') { openIn = e; return; }
    if (e.action === 'out') {
      const inDate = openIn ? new Date(openIn.ts) : null;
      const outDate = new Date(e.ts);
      // Pair-from-timestamps is the source of truth; duration_hrs is a
      // cache used only when no paired IN exists. Stops stale cached
      // values from leaking into per-agent detail panels too.
      const hrs = inDate
        ? Math.max(0, (outDate - inDate) / 3.6e6)
        : (e.duration_hrs != null && !isNaN(e.duration_hrs) ? Number(e.duration_hrs) : 0);
      shifts.push({
        date: (inDate || outDate),
        tin: inDate ? fmtTimeOf(inDate) : '—',
        tout: fmtTimeOf(outDate),
        hrs,
        note: openIn ? (openIn.note || '') : (e.note || ''),
      });
      openIn = null;
    }
  });

  // Bucket shifts by ISO week start (Mon).
  const byWeek = new Map();
  shifts.forEach(s => {
    // Bucket by SAST-anchored week-Monday date so a shift that crossed
    // midnight UTC still lands in the SAST week it started.
    const wk = sastYmd(startOfWeek(s.date));
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(s);
  });

  // Aggregate daily totals + weekly totals.
  let grandTotal = 0; let workedDays = new Set();
  const blocks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([wk, list]) => {
    const wkStart = new Date(wk);
    const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);
    let wkTotal = 0;
    // Daily totals: map dateKey → { rows: shifts that day, total }
    const byDay = {};
    list.forEach(s => {
      // SAST-anchored day-key so shifts collate with absences (which
      // store SAST calendar dates).
      const k = sastYmd(s.date);
      if (!byDay[k]) byDay[k] = { date: s.date, rows: [], total: 0 };
      byDay[k].rows.push(s);
      byDay[k].total += s.hrs;
      wkTotal += s.hrs;
      grandTotal += s.hrs;
      workedDays.add(k);
    });
    return {
      label: wkLabel(wkStart, wkEnd),
      days: Object.values(byDay).sort((a, b) => b.date - a.date),
      total: wkTotal,
    };
  }).reverse(); // newest week first

  const rangeLabel = range.kind === 'week'
    ? weekLabel(range.from)
    : `${range.from.toLocaleDateString('en-GB',{day:'numeric',month:'short'})} – ${range.to.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}`;

  return `
    <div class="modal-back" id="tsDetailBack"></div>
    <div class="modal" role="dialog" style="width:min(820px, calc(100vw - 16px));max-height:92vh">
      <div class="modal-head">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          <div class="av" style="background:${avColor(0)};width:36px;height:36px;font-size:13px">${initials(d.agentName)}</div>
          <div style="min-width:0">
            <h3 style="margin:0;font-size:16px">${escapeHtml(d.agentName)}</h3>
            <div style="font-size:12px;color:var(--muted);font-weight:600">${escapeHtml(rangeLabel)}</div>
          </div>
        </div>
        <button class="modal-close" id="tsDetailClose">${icon('x', 18, 'var(--muted)')}</button>
      </div>
      <div class="modal-body" style="padding-bottom:18px">
        <div class="ts-summary">
          <div><span class="lbl">Total hours</span><span class="val tnum">${fmtHM(grandTotal)}</span></div>
          <div><span class="lbl">Worked days</span><span class="val tnum">${workedDays.size}</span></div>
          <div><span class="lbl">Shifts</span><span class="val tnum">${shifts.length}</span></div>
        </div>
        ${blocks.length === 0 ? `<div class="muted" style="padding:20px 0;text-align:center">No shifts in this period.</div>` : ''}
        ${blocks.map(b => `
          <div class="ts-block">
            <div class="ts-block-head">
              <span>${escapeHtml(b.label)}</span>
              <span class="tnum">Weekly total · ${fmtHM(b.total)}</span>
            </div>
            <div class="ts-day-list">
              ${b.days.map(day => `
                <div class="ts-day">
                  <div class="ts-day-head">
                    <span class="ts-day-name">${day.date.toLocaleDateString('en-GB', { weekday: 'short' })} ${day.date.getDate()}/${day.date.getMonth() + 1}</span>
                    <span class="ts-day-total tnum">${fmtHM(day.total)}</span>
                  </div>
                  ${day.rows.map(s => `
                    <div class="ts-shift">
                      <span class="ts-time tnum">${s.tin} – ${s.tout}</span>
                      <span class="ts-shift-hrs tnum">${fmtHM(s.hrs)}</span>
                      <span class="ts-shift-note">${escapeHtml(s.note || '—')}</span>
                    </div>
                  `).join('')}
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn" id="tsDetailEdit">${icon('clipboard', 15)} Edit events</button>
        <button class="btn primary" id="tsDetailExport">${icon('download', 15)} Export CSV</button>
      </div>
    </div>`;
}

function wireTsDetail() {
  const close = () => { state.tsDetail = null; render(); };
  document.getElementById('tsDetailBack').addEventListener('click', close);
  document.getElementById('tsDetailClose').addEventListener('click', close);
  document.getElementById('tsDetailEdit').addEventListener('click', () => {
    const d = state.tsDetail;
    state.tsDetail = null;
    openEventEditor(d.agentId, d.agentName);
  });
  document.getElementById('tsDetailExport').addEventListener('click', exportTsDetailCSV);
}

function exportTsDetailCSV() {
  const d = state.tsDetail; if (!d) return;
  const period = state.tsPeriod || 'this-week';
  const events = (state.data.tsEvents || []).filter(e => e.id === d.agentId)
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const rows = [['Date','Start','End','Hours','Note']];
  let openIn = null;
  events.forEach(e => {
    if (e.action === 'in') { openIn = e; return; }
    if (e.action === 'out') {
      const inDate = openIn ? new Date(openIn.ts) : null;
      const outDate = new Date(e.ts);
      // Pair-first: prefer IN→OUT math over the cached duration_hrs
      // (was previously inverted — stale-cache exports were the
      // Warrick 24:39 pattern lurking in the CSV path).
      const hrs = inDate
        ? Math.max(0, (outDate - inDate) / 3.6e6)
        : (e.duration_hrs != null && !isNaN(e.duration_hrs) ? Number(e.duration_hrs) : 0);
      rows.push([
        sastYmd(inDate || outDate),
        inDate ? fmtTimeOf(inDate) : '',
        fmtTimeOf(outDate),
        fmtHM(hrs),
        openIn ? (openIn.note || '') : '',
      ]);
      openIn = null;
    }
  });
  const safeId = d.agentId.replace(/[^a-z0-9_-]+/gi, '-');
  downloadCSV(`timesheet-${safeId}-${period}.csv`, rows);
}

function fmtTimeOf(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function wkLabel(start, end) {
  const sd = start.getDate(); const ed = end.getDate();
  if (start.getMonth() === end.getMonth()) {
    return `${sd} – ${ed} ${end.toLocaleDateString('en-GB', { month: 'short' })}`;
  }
  return `${sd} ${start.toLocaleDateString('en-GB', { month: 'short' })} – ${ed} ${end.toLocaleDateString('en-GB', { month: 'short' })}`;
}

// ── Event editor (admin manual clock-in/out edits) ──────────────────
async function openEventEditor(agentId, agentName) {
  const sow = startOfWeek(new Date());
  // Seed with whatever's in the period-aware cache so the editor opens
  // instantly with what we already have. Then fetch the agent's FULL
  // history in the background (up to 12 months) so admins can edit any
  // shift from any cycle without being limited to the table's filter.
  const sourceEvents = (state.data.tsEvents && state.data.tsEvents.length)
    ? state.data.tsEvents
    : (state.data.weekEvents || []);
  const seed = sourceEvents
    .filter(e => e.id === agentId)
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  state.eventEditor = {
    agentId, agentName,
    weekStart: sow,
    events: seed.slice(),
    busy: false, error: '', adding: false, loadingHistory: true,
    addDraft: { action: 'in',
                date: seed.length
                  ? sastYmd(new Date(seed[seed.length - 1].ts))
                  : sastYmd(),
                time: '08:00', note: '' },
  };
  render();
  // Background fetch — agent's full history. 12 months is plenty for
  // any realistic correction; bump if anyone genuinely needs older.
  try {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 12, 1);
    const res = await api('events', {
      agent_id: agentId,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const all = (res && res.events) || [];
    // Editor may have been closed by the time the fetch resolves —
    // bail out gracefully.
    if (!state.eventEditor || state.eventEditor.agentId !== agentId) return;
    state.eventEditor.events = all
      .slice()
      .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    state.eventEditor.loadingHistory = false;
    // Re-seed the add-event default date to the agent's most recent event
    // in the now-complete history.
    if (all.length) {
      state.eventEditor.addDraft.date =
        sastYmd(new Date(all[all.length - 1].ts));
    }
    render();
  } catch (e) {
    if (!state.eventEditor || state.eventEditor.agentId !== agentId) return;
    state.eventEditor.loadingHistory = false;
    state.eventEditor.error = 'Could not load full history: ' + String(e.message || e);
    render();
  }
}

// Variant A timesheet: group events into day-per-row shape.
// Input: events sorted ascending by ts. Output: [{date, shifts:[{inIdx?,outIdx?}], hasIssues}]
// A "shift" is an IN paired with the next OUT on the same day. Unpaired
// ends (missing OUT while still clocked in, or missing IN before an OUT
// e.g. an auto-clock-out) surface as issue flags on the day.
function _groupEventsByDay(events) {
  const byDay = new Map();
  events.forEach((ev, idx) => {
    const d = new Date(ev.ts);
    const key = sastYmd(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ ev, idx });
  });
  const out = [];
  const dayKeys = [...byDay.keys()].sort().reverse(); // newest first
  dayKeys.forEach(key => {
    const list = byDay.get(key);
    const shifts = [];
    let openIn = null;
    let issues = [];
    list.forEach(item => {
      if (item.ev.action === 'in') {
        if (openIn) {
          // Two INs in a row on the same day: previous IN never got a paired OUT.
          shifts.push({ inItem: openIn, outItem: null });
          issues.push('missing-out');
        }
        openIn = item;
      } else if (item.ev.action === 'out') {
        if (openIn) {
          shifts.push({ inItem: openIn, outItem: item });
          openIn = null;
        } else {
          shifts.push({ inItem: null, outItem: item });
          issues.push('missing-in');
        }
      }
    });
    if (openIn) {
      shifts.push({ inItem: openIn, outItem: null });
      // Only flag as "still clocked in" (not an issue) if it's today.
      if (key !== sastYmd(new Date())) issues.push('missing-out');
    }
    out.push({ date: key, shifts, issues });
  });
  return out;
}

function _fmtDayLabel(ymd) {
  // "Wed 25 Jun" from a YYYY-MM-DD SAST-anchored date string.
  const [y, m, d] = ymd.split('-').map(n => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = dt.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const dm = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { wd, dm, year: String(y) };
}

function _fmtDurationMs(ms) {
  if (!(ms > 0)) return '0h 0m';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function _hhmmFromTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Small red flag glyph used on missing-IN / missing-OUT badges. Inline
// SVG so it colour-inherits from the badge without needing an icon set.
function _flagGlyph() {
  return `<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" style="margin-right:3px;vertical-align:-1px"><path d="M2 1v10h1.4V7h5.2l-.7-1.5.7-1.5H3.4V1H2z"/></svg>`;
}

// Split an existing shift note into its teams, matched to canonical casing.
// Mirrors the payroll splitter (/, &, comma, "and"). Unknown fragments are
// kept as-is so an existing value is never silently dropped on save.
function parseNoteTeams(note, canonical) {
  if (!note) return [];
  const byLc = new Map((canonical || []).map(t => [t.toLowerCase(), t]));
  const out = [], seen = new Set();
  String(note).split(/\s*(?:\/|&|,|\band\b)\s*/i).map(s => s.trim()).filter(Boolean)
    .forEach(p => {
      const v = byLc.get(p.toLowerCase()) || p;
      if (!seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
    });
  return out;
}

function renderEventEditor() {
  const e = state.eventEditor;
  const days = _groupEventsByDay(e.events);
  const teamOptions = (state.data && state.data.payrollTeams) || [];
  const todayKey = sastYmd(new Date());
  const publicHolidays = state.data.publicHolidays || new Map();

  // Weekly total: sum of PAID shifts across all days. Public holidays
  // are UNPAID at Quay 1 (same rule as absence + sick), so their clocked
  // duration does not count toward the weekly total even when the staff
  // member happened to work that day. The clock times still render on
  // the row for record-keeping.
  let weekMs = 0;
  days.forEach(day => {
    if (publicHolidays.has(day.date)) return;
    day.shifts.forEach(s => {
      if (s.inItem && s.outItem) {
        weekMs += new Date(s.outItem.ev.ts) - new Date(s.inItem.ev.ts);
      }
    });
  });

  const rows = days.map(day => {
    const lbl = _fmtDayLabel(day.date);
    const isToday = day.date === todayKey;
    // Primary shift is the FIRST IN + LAST OUT of the day for the summary row.
    const first = day.shifts[0] || {};
    const inTime  = first.inItem  ? _hhmmFromTs(first.inItem.ev.ts)  : '';
    const outTime = first.outItem ? _hhmmFromTs(first.outItem.ev.ts) : '';
    let dayMs = 0;
    day.shifts.forEach(s => {
      if (s.inItem && s.outItem) dayMs += new Date(s.outItem.ev.ts) - new Date(s.inItem.ev.ts);
    });
    const isSplit = day.shifts.filter(s => s.inItem && s.outItem).length > 1;
    const stillOpen = isToday && day.shifts.some(s => s.inItem && !s.outItem);
    const holiday = publicHolidays.get(day.date);
    const badges = [];
    if (holiday)   badges.push(`<span class="ts-badge ts-badge--holiday" title="${escapeHtml(holiday.name)} - unpaid">Public holiday</span>`);
    if (isSplit)   badges.push(`<span class="ts-badge">Split shift</span>`);
    if (stillOpen) badges.push(`<span class="ts-badge ts-badge--live">Still clocked in</span>`);
    const missingOut = day.issues.includes('missing-out') && !stillOpen;
    const missingIn  = day.issues.includes('missing-in');
    if (missingOut) badges.push(`<span class="ts-badge ts-badge--flag">${_flagGlyph()} Missing OUT</span>`);
    if (missingIn)  badges.push(`<span class="ts-badge ts-badge--flag">${_flagGlyph()} Missing IN</span>`);
    const rowFlag = missingOut || missingIn;
    // Public-holiday days: clocked time still displays for the record but
    // the paid total is zero. Show "worked X but unpaid" instead of the
    // usual duration so the manager sees WHY the payroll total ignores it.
    const totalTxt = holiday
      ? (dayMs > 0 ? `${_fmtDurationMs(dayMs)} worked - unpaid` : '0h 0m (holiday)')
      : (stillOpen && dayMs === 0 ? '- so far' : _fmtDurationMs(dayMs) + (stillOpen ? ' so far' : ''));
    const inIdx  = first.inItem  ? first.inItem.idx  : '';
    const outIdx = first.outItem ? first.outItem.idx : '';
    // Team note lives on the clock-IN event (same field payroll allocates by).
    // Show it per day so the manager can see which shifts have no team and
    // fill them before the pay run closes.
    const primaryNote = first.inItem ? String(first.inItem.ev.note || '').trim() : '';
    const noteMissing = !!first.inItem && !primaryNote;
    // Teams currently on this day's note, and the full option list (existing
    // values first so an off-list team is preserved and pre-checked).
    const selectedTeams = parseNoteTeams(primaryNote, teamOptions);
    const optionTeams = Array.from(new Set([...selectedTeams, ...teamOptions]));
    const selSet = new Set(selectedTeams.map(t => t.toLowerCase()));
    // Extra shifts on a split-shift day render as a nested list under the summary.
    const extraShiftsHtml = isSplit ? day.shifts.slice(1).map(s => {
      const sIn  = s.inItem  ? _hhmmFromTs(s.inItem.ev.ts)  : '';
      const sOut = s.outItem ? _hhmmFromTs(s.outItem.ev.ts) : '';
      const sInIdx  = s.inItem  ? s.inItem.idx  : '';
      const sOutIdx = s.outItem ? s.outItem.idx : '';
      const sMs = (s.inItem && s.outItem) ? new Date(s.outItem.ev.ts) - new Date(s.inItem.ev.ts) : 0;
      const sNote = s.inItem ? String(s.inItem.ev.note || '').trim() : '';
      return `<div class="ts-shift">
        <span class="ts-shift-lbl">IN</span>
        <input type="time" class="ts-time" data-shift-in="${sInIdx}" value="${sIn}">
        <span class="ts-shift-lbl">OUT</span>
        <input type="time" class="ts-time" data-shift-out="${sOutIdx}" value="${sOut}">
        <span class="ts-shift-total tnum">${_fmtDurationMs(sMs)}</span>
        <span class="ts-shift-note">${sNote ? escapeHtml(sNote) : '<span class="ts-note-missing">no team</span>'}</span>
      </div>`;
    }).join('') : '';
    return `<tr class="ts-row${rowFlag ? ' ts-row--flag' : ''}${holiday ? ' ts-row--holiday' : ''}" data-day="${day.date}">
      <td class="ts-col-day">
        <div class="ts-day-name">${escapeHtml(lbl.wd + ' ' + lbl.dm)}</div>
        <div class="ts-day-year">${escapeHtml(lbl.year)}</div>
        ${badges.length ? `<div class="ts-badges">${badges.join('')}</div>` : ''}
      </td>
      <td class="ts-col-in">
        <input type="time" class="ts-time${missingIn ? ' ts-time--flag' : ''}" data-in-idx="${inIdx}" value="${inTime}" ${inIdx === '' ? 'data-empty="1"' : ''}>
      </td>
      <td class="ts-col-out">
        <input type="time" class="ts-time${missingOut ? ' ts-time--flag' : ''}" data-out-idx="${outIdx}" value="${outTime}" ${outIdx === '' ? 'data-empty="1" placeholder="- -"' : ''}>
      </td>
      <td class="ts-col-note">${
        first.inItem
          ? `<div class="ts-team-picker${noteMissing ? ' ts-team-picker--flag' : ''}" data-note-in-idx="${inIdx}">
               <button type="button" class="ts-team-btn" data-team-btn>
                 <span class="ts-team-btn-label">${selectedTeams.length ? escapeHtml(selectedTeams.join(' / ')) : 'add team'}</span>
                 <span class="ts-team-caret" aria-hidden="true">&#9662;</span>
               </button>
               <div class="ts-team-menu" data-team-menu hidden>
                 <input type="text" class="ts-team-search" data-team-search placeholder="Search teams&hellip;" autocomplete="off" spellcheck="false">
                 <div class="ts-team-list">
                   ${optionTeams.map(t => `<label class="ts-team-opt"><input type="checkbox" value="${escapeHtml(t)}"${selSet.has(t.toLowerCase()) ? ' checked' : ''}><span>${escapeHtml(t)}</span></label>`).join('')}
                 </div>
               </div>
             </div>`
          : `<span class="muted">&middot;</span>`
      }</td>
      <td class="ts-col-total tnum">${escapeHtml(totalTxt)}</td>
      <td class="ts-col-actions">
        <button class="btn small primary" data-day-save="${day.date}">Save</button>
        <button class="btn small" data-day-menu="${day.date}" aria-label="More" title="More actions">&#8942;</button>
      </td>
      ${isSplit ? `<td colspan="6" class="ts-split-cell">${extraShiftsHtml}</td>` : ''}
    </tr>`;
  }).join('');

  const addBlock = e.adding ? `
    <div class="ts-addrow">
      <select id="evNewAction">
        <option value="in" ${e.addDraft.action === 'in' ? 'selected' : ''}>IN</option>
        <option value="out" ${e.addDraft.action === 'out' ? 'selected' : ''}>OUT</option>
      </select>
      <input id="evNewDate" type="date" value="${e.addDraft.date}">
      <input id="evNewTime" type="time" value="${e.addDraft.time}">
      <input id="evNewNote" type="text" value="${escapeHtml(e.addDraft.note)}" placeholder="note (optional)">
      <button class="btn small primary" id="evAdd">Add event</button>
      <button class="btn small" id="evAddCancel">Cancel</button>
    </div>` : `<div class="ts-addbtns">
      <button class="btn small primary" id="evShowAdd">+ Add event</button>
    </div>`;

  return `
    <div class="modal-back" id="evBack"></div>
    <div class="modal ts-modal" role="dialog" style="width:min(920px, calc(100vw - 32px))">
      <div class="modal-head">
        <h3>Edit timesheet: ${escapeHtml(e.agentName)}</h3>
        <button class="modal-close" id="evClose">${icon('x', 18, 'var(--muted)')}</button>
      </div>
      <div class="modal-body">
        <div class="ev-help">
          Each row is one day. Edit the IN and OUT times or the team note, then click Save on that row.
          ${e.loadingHistory ? `<span class="muted" style="margin-left:6px">Loading full history...</span>` : ''}
        </div>
        ${e.events.length === 0 ? `<div class="muted" style="font-size:13px;padding:6px 0">${e.loadingHistory ? 'Loading events for this agent...' : 'No events found for this agent.'}</div>` : `
        <table class="ts-table">
          <thead>
            <tr>
              <th class="ts-col-day">Day</th>
              <th class="ts-col-in">In</th>
              <th class="ts-col-out">Out</th>
              <th class="ts-col-note">Note / Team</th>
              <th class="ts-col-total tnum">Total</th>
              <th class="ts-col-actions"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="ts-foot-label">Total across shown days</td>
              <td class="ts-foot-total tnum">${_fmtDurationMs(weekMs)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>`}
        ${e.error ? `<div class="banner">${escapeHtml(e.error)}</div>` : ''}
        <div style="margin-top:12px">${addBlock}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="evDone">Done</button>
      </div>
    </div>`;
}

function wireEventEditor() {
  const close = () => { state.eventEditor = null; loadAll(); };
  document.getElementById('evBack').addEventListener('click', close);
  document.getElementById('evClose').addEventListener('click', close);
  document.getElementById('evDone').addEventListener('click', close);

  // Day-per-row saves + menus. Save fires event_update for whichever of the
  // day's IN and OUT rows changed vs the current DB timestamp.
  document.querySelectorAll('button[data-day-save]').forEach(btn => {
    btn.addEventListener('click', () => saveDayShift(btn.dataset.daySave));
  });
  document.querySelectorAll('button[data-day-menu]').forEach(btn => {
    btn.addEventListener('click', (ev) => openDayMenu(btn.dataset.dayMenu, ev.currentTarget));
  });
  // Team multi-select pickers (one per day row).
  wireTeamPickers();

  const showAdd = document.getElementById('evShowAdd');
  if (showAdd) showAdd.addEventListener('click', () => { state.eventEditor.adding = true; render(); });
  const cancel = document.getElementById('evAddCancel');
  if (cancel) cancel.addEventListener('click', () => { state.eventEditor.adding = false; render(); });
  const addBtn = document.getElementById('evAdd');
  if (addBtn) addBtn.addEventListener('click', addEvent);
}

// ── Team multi-select picker (per day row) ───────────────────────────
// A button that opens a searchable checkbox menu of canonical teams. The
// menu is position:fixed and positioned from the button's rect on open, so
// it escapes the scrolling modal's overflow (no clipping). Selected teams
// join with " / " into the note payroll splits on.
function wireTeamPickers() {
  document.querySelectorAll('.ts-team-picker').forEach(pick => {
    const btn = pick.querySelector('[data-team-btn]');
    const menu = pick.querySelector('[data-team-menu]');
    const label = pick.querySelector('.ts-team-btn-label');
    const search = pick.querySelector('[data-team-search]');
    if (!btn || !menu) return;
    const syncLabel = () => {
      const sel = [...menu.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
      label.textContent = sel.length ? sel.join(' / ') : 'add team';
      pick.classList.toggle('ts-team-picker--flag', sel.length === 0);
    };
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      closeAllTeamMenus();
      if (willOpen) {
        positionTeamMenu(btn, menu);
        menu.hidden = false;
        pick.classList.add('is-open');
        if (search) { search.value = ''; filterTeamOpts(menu, ''); setTimeout(() => search.focus(), 0); }
      }
    });
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    if (search) search.addEventListener('input', () => filterTeamOpts(menu, search.value));
    menu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', syncLabel));
  });
  if (!window.__teamMenuGlobalWired) {
    window.__teamMenuGlobalWired = true;
    document.addEventListener('click', closeAllTeamMenus);
    document.addEventListener('scroll', closeAllTeamMenus, true); // capture: catch modal-body scroll
    window.addEventListener('resize', closeAllTeamMenus);
  }
}

function closeAllTeamMenus() {
  document.querySelectorAll('[data-team-menu]').forEach(m => {
    if (!m.hidden) { m.hidden = true; const p = m.closest('.ts-team-picker'); if (p) p.classList.remove('is-open'); }
  });
}

function positionTeamMenu(btn, menu) {
  const r = btn.getBoundingClientRect();
  const width = 260, maxH = 300;
  // A transformed ancestor (the Edit modal is translate()-centred) becomes the
  // containing block for position:fixed, so subtract its rect to keep the menu
  // pinned under the button. No transform ancestor → cb stays 0,0 (true fixed).
  let cb = { left: 0, top: 0 };
  for (let anc = menu.parentElement; anc && anc.nodeType === 1; anc = anc.parentElement) {
    const t = getComputedStyle(anc).transform;
    if (t && t !== 'none') { cb = anc.getBoundingClientRect(); break; }
  }
  const belowSpace = window.innerHeight - r.bottom;
  let top = r.bottom + 4;
  if (belowSpace < maxH + 12 && r.top > belowSpace) top = Math.max(8, r.top - Math.min(maxH, r.top - 8) - 4);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  menu.style.position = 'fixed';
  menu.style.width = width + 'px';
  menu.style.top = (top - cb.top) + 'px';
  menu.style.left = (left - cb.left) + 'px';
}

function filterTeamOpts(menu, q) {
  const s = String(q || '').trim().toLowerCase();
  menu.querySelectorAll('.ts-team-opt').forEach(opt => {
    const t = opt.textContent.trim().toLowerCase();
    opt.style.display = (!s || t.includes(s)) ? '' : 'none';
  });
}

// Save any changes to the primary IN and OUT of a day. Uses the existing
// event_update / event_add / event_delete API atoms; batches per-row.
async function saveDayShift(dateKey) {
  const e = state.eventEditor;
  const row = document.querySelector(`tr.ts-row[data-day="${dateKey}"]`);
  if (!row || !e) return;
  const inInput  = row.querySelector('input[data-in-idx]');
  const outInput = row.querySelector('input[data-out-idx]');
  const inIdxStr  = inInput  ? inInput.dataset.inIdx  : '';
  const outIdxStr = outInput ? outInput.dataset.outIdx : '';
  const inNew  = inInput  ? inInput.value  : '';
  const outNew = outInput ? outInput.value : '';
  try {
    // Update IN row: its time and/or its team note. The note lives on the
    // clock-IN event (the field payroll allocates hours by), so this is how a
    // manager fills a missing team. Target the exact row by its UUID so a
    // duplicate-timestamp punch can't be edited by mistake.
    const picker = row.querySelector('.ts-team-picker[data-note-in-idx]');
    const pickedNote = picker
      ? [...picker.querySelectorAll('[data-team-menu] input[type="checkbox"]:checked')].map(c => c.value).join(' / ')
      : null;
    if (inIdxStr !== '' && inNew) {
      const ev = e.events[Number(inIdxStr)];
      const newNote = pickedNote != null ? pickedNote : (ev.note || '');
      const timeChanged = _hhmmFromTs(ev.ts) !== inNew;
      const noteChanged = (ev.note || '') !== newNote;
      if (timeChanged || noteChanged) {
        const upd = { agent_id: e.agentId, _event_id: ev._event_id, ts: ev.ts, dir: ev.action, note: newNote };
        if (timeChanged) upd.new_ts = new Date(dateKey + 'T' + inNew + ':00').toISOString();
        await api('event_update', upd);
        e.events[Number(inIdxStr)] = { ...ev, ts: upd.new_ts || ev.ts, note: newNote };
      }
    } else if (inIdxStr === '' && inNew) {
      // No prior IN, user typed one; insert (with the team note if given).
      const newNote = pickedNote != null ? pickedNote : '';
      const newTs = new Date(dateKey + 'T' + inNew + ':00').toISOString();
      await api('event_add', { agent_id: e.agentId, ts: newTs, dir: 'in', note: newNote });
      e.events.push({ ts: newTs, action: 'in', note: newNote });
    }
    // Update OUT row.
    if (outIdxStr !== '' && outNew) {
      const ev = e.events[Number(outIdxStr)];
      const currentHHMM = _hhmmFromTs(ev.ts);
      if (currentHHMM !== outNew) {
        const newTs = new Date(dateKey + 'T' + outNew + ':00').toISOString();
        await api('event_update', {
          agent_id: e.agentId, ts: ev.ts, new_ts: newTs, dir: ev.action, note: ev.note || '',
        });
        e.events[Number(outIdxStr)] = { ...ev, ts: newTs };
      }
    } else if (outIdxStr === '' && outNew) {
      const newTs = new Date(dateKey + 'T' + outNew + ':00').toISOString();
      await api('event_add', { agent_id: e.agentId, ts: newTs, dir: 'out', note: '' });
      e.events.push({ ts: newTs, action: 'out', note: '' });
    }
    // Re-sort so the day grouper stays consistent after inserts.
    e.events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    e.error = '';
    showToast('Saved');
  } catch (err) {
    e.error = String(err.message || err);
  }
  render();
}

// Per-day action menu on the Variant A timesheet. Offers the actions an
// admin actually needs on a payroll timesheet: delete all events for the
// day, back-date an absence (sick or other), or clear a stray absence
// row. Uses window.prompt for now; upgrade to a proper dropdown once
// this proves out.
async function openDayMenu(dateKey, anchor) {
  const e = state.eventEditor;
  if (!e) return;
  const today = sastYmd(new Date());
  const isPastOrToday = dateKey <= today;
  const action = window.prompt(
    `Day ${dateKey} - type an action:\n\n` +
    (isPastOrToday
      ? `  sick     mark this day as SICK (unpaid)\n` +
        `  absent   mark this day as ABSENT (unpaid)\n` +
        `  clear    clear any absence row for this day\n`
      : '') +
    `  delete   remove ALL clock events on this day\n` +
    `  cancel   do nothing\n`,
    'cancel');
  if (!action) return;
  const a = action.toLowerCase().trim();
  if (a === 'cancel') return;
  if (a === 'delete') {
    if (!confirm(`Delete all clock events on ${dateKey}? This cannot be undone.`)) return;
    const dayEvents = e.events.filter(ev => sastYmd(new Date(ev.ts)) === dateKey);
    for (const ev of dayEvents) {
      try { await api('event_delete', { agent_id: e.agentId, ts: ev.ts }); } catch {}
    }
    e.events = e.events.filter(ev => sastYmd(new Date(ev.ts)) !== dateKey);
    showToast('Day deleted');
    render();
    return;
  }
  if (a === 'sick' || a === 'absent') {
    // Reuse the existing absence-marker modal; it already handles the
    // single-day case, the (staff_id, date) upsert, RLS, and error banner.
    // Sick is unpaid at Quay same as absent (no paid-hours branching).
    const reason = a === 'sick' ? 'Sick' : 'Other';
    // Close the timesheet modal first so the absence modal stacks cleanly.
    state.eventEditor = null;
    openAbsenceMarker(e.agentId, { date: dateKey, reason });
    return;
  }
  if (a === 'clear') {
    // Delete any absence rows for this staff on this date.
    if (!window.sb) { e.error = 'Supabase client not ready'; render(); return; }
    try {
      const { error } = await window.sb.from('absences')
        .delete()
        .eq('staff_id', e.agentId)
        .eq('date', dateKey);
      if (error) throw error;
      showToast('Absence cleared');
    } catch (err) {
      e.error = 'Could not clear absence: ' + String(err.message || err);
    }
    render();
    return;
  }
}

async function saveEvent(idx, row) {
  const e = state.eventEditor;
  const ev = e.events[idx];
  const newAction = row.querySelector('.ev-action').value;
  const newDate   = row.querySelector('.ev-date').value;
  const newTime   = row.querySelector('.ev-time').value;
  const newNote   = row.querySelector('.ev-note').value;
  if (!newDate || !newTime) { e.error = 'Pick a valid date and time'; render(); return; }
  const newTs = new Date(newDate + 'T' + newTime + ':00').toISOString();
  try {
    await api('event_update', {
      agent_id: e.agentId,
      ts: ev.ts,
      new_ts: newTs,
      // `dir` so the in/out value doesn't clobber the outer dispatcher key.
      dir: newAction,
      note: newNote,
    });
    // mutate locally so the next save uses the new ts
    e.events[idx] = { ...ev, ts: newTs, action: newAction, note: newNote };
    e.error = '';
    showToast('Saved');
  } catch (err) {
    e.error = String(err.message || err);
  }
  render();
}

async function deleteEvent(idx) {
  const e = state.eventEditor;
  const ev = e.events[idx];
  if (!confirm('Delete this event? This can\'t be undone.')) return;
  try {
    await api('event_delete', { agent_id: e.agentId, ts: ev.ts });
    e.events.splice(idx, 1);
    e.error = '';
    showToast('Deleted');
  } catch (err) {
    e.error = String(err.message || err);
  }
  render();
}

async function addEvent() {
  const e = state.eventEditor;
  // Guard against double-fire: rapid clicks / Enter-key submits both
  // landed here before the first INSERT settled, creating two rows. The
  // flag is on the state, not the button, so it survives a render().
  if (e._adding) return;
  e._adding = true;
  const addBtn = document.getElementById('evAdd');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding…'; }
  const action = document.getElementById('evNewAction').value;
  const date = document.getElementById('evNewDate').value;
  const time = document.getElementById('evNewTime').value;
  const note = document.getElementById('evNewNote').value;
  e.addDraft = { action, date, time, note };
  if (!date || !time) {
    e.error = 'Pick a valid date and time';
    e._adding = false;
    render(); return;
  }
  const ts = new Date(date + 'T' + time + ':00').toISOString();
  try {
    const res = await api('event_add', { agent_id: e.agentId, ts, dir: action, note });
    // Defensive: surface the raw payload + response so any future "saved
    // event came back wrong direction" reproductions land with diagnostic
    // breadcrumbs in the console instead of silent state.
    console.log('[event_add]', { sent: { agent_id: e.agentId, ts, dir: action, note }, got: res });
    e.events.push({ ts, id: e.agentId, name: e.agentName, action, note, duration_hrs: null });
    e.events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    e.adding = false; e.error = '';
    showToast('Added');
  } catch (err) {
    e.error = String(err.message || err);
  } finally {
    e._adding = false;
  }
  render();
}

// ── Mark-absent modal (range × staff) ───────────────────────────────
// Inserts one absences row per calendar day in [from, to]; idempotent
// on (staff_id, date). Beats hand-rolling INSERTs in Supabase Studio,
// which lost a day on the end of Whitney's "whole week" range.
function openAbsenceMarker(preselectId, opts) {
  // Default the from/to to today so a single-day mark-absent is one click
  // away. Pre-fill the staff picker if the user clicked a per-row trigger.
  // opts: { date, reason } lets the timesheet's day-row menu launch this
  // pre-filled for back-dating a past day directly.
  const _ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = _ymd(new Date());
  const seedDate   = (opts && opts.date)   || today;
  const seedReason = (opts && opts.reason) || 'Sick';
  state.absenceMarker = {
    staffId: preselectId || '',
    fromDate: seedDate,
    toDate: seedDate,
    reason: seedReason,
    note: '',
    busy: false,
    error: '',
    success: '',
  };
  render();
}

function renderAbsenceMarker() {
  const a = state.absenceMarker;
  const exempt = exemptIdsFromRoster();
  const roster = (state.data.roster || [])
    .filter(r => !exempt.has(r.id) && r.active !== false)
    .slice()
    .sort((x, y) => (x.name || '').localeCompare(y.name || ''));
  const staffOpts = ['<option value="">— pick a staff member —</option>']
    .concat(roster.map(r =>
      `<option value="${escapeHtml(r.id)}" ${r.id === a.staffId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
    )).join('');
  const reasons = ['Sick', 'Personal', 'Family', 'Approved leave', 'Other'];
  const reasonOpts = reasons.map(r =>
    `<option value="${escapeHtml(r)}" ${r === a.reason ? 'selected' : ''}>${escapeHtml(r)}</option>`
  ).join('');
  // Day-count preview so the manager sees how many rows the click writes.
  let dayCount = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(a.fromDate) && /^\d{4}-\d{2}-\d{2}$/.test(a.toDate)) {
    const f = new Date(a.fromDate + 'T12:00:00Z');
    const t = new Date(a.toDate   + 'T12:00:00Z');
    if (t >= f) dayCount = Math.round((t - f) / 86400000) + 1;
  }
  return `
    <div class="modal-back" id="abBack"></div>
    <div class="modal" role="dialog" style="width:min(520px, calc(100vw - 32px))">
      <div class="modal-head">
        <h3>Mark absent</h3>
        <button class="modal-close" id="abClose">${icon('x', 18, 'var(--muted)')}</button>
      </div>
      <div class="modal-body">
        <div class="ev-help">
          Inserts one row per day in the range. Re-marking the same day
          overwrites the reason instead of duplicating.
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:6px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase">
            Staff
            <select id="abStaff" style="font-family:Montserrat,sans-serif;font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;text-transform:none;font-weight:500;color:var(--ink)">${staffOpts}</select>
          </label>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;flex:1 1 140px">
              From
              <input id="abFrom" type="date" value="${escapeHtml(a.fromDate)}"
                     style="font-family:Montserrat,sans-serif;font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);text-transform:none;font-weight:500">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;flex:1 1 140px">
              To
              <input id="abTo" type="date" value="${escapeHtml(a.toDate)}"
                     style="font-family:Montserrat,sans-serif;font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);text-transform:none;font-weight:500">
            </label>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase">
            Reason
            <select id="abReason" style="font-family:Montserrat,sans-serif;font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;text-transform:none;font-weight:500;color:var(--ink)">${reasonOpts}</select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase">
            Note (optional)
            <input id="abNote" type="text" value="${escapeHtml(a.note || '')}" placeholder="e.g. doctor's appointment"
                   style="font-family:Montserrat,sans-serif;font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);text-transform:none;font-weight:500">
          </label>
          ${dayCount > 0 ? `<div class="muted" style="font-size:12.5px">Will mark <b style="color:var(--ink)">${dayCount}</b> day${dayCount === 1 ? '' : 's'} absent.</div>` : ''}
          ${a.error ? `<div class="banner">${escapeHtml(a.error)}</div>` : ''}
          ${a.success ? `<div class="banner" style="background:var(--greenBg,#E2F1EA);color:var(--green,#2F8F63);border-color:var(--green,#2F8F63)">${escapeHtml(a.success)}</div>` : ''}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="abCancel">Close</button>
        <button class="btn primary" id="abSubmit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Saving…' : 'Mark absent'}</button>
      </div>
    </div>`;
}

function wireAbsenceMarker() {
  const close = () => { state.absenceMarker = null; render(); };
  document.getElementById('abBack').addEventListener('click', close);
  document.getElementById('abClose').addEventListener('click', close);
  document.getElementById('abCancel').addEventListener('click', close);
  const a = state.absenceMarker;
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { a[key] = el.value; });
  };
  bind('abStaff',  'staffId');
  bind('abFrom',   'fromDate');
  bind('abTo',     'toDate');
  bind('abReason', 'reason');
  bind('abNote',   'note');
  // Live preview: re-render so the "Will mark N days" hint updates.
  ['abFrom', 'abTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => render());
  });
  document.getElementById('abSubmit').addEventListener('click', submitAbsence);
}

async function submitAbsence() {
  const a = state.absenceMarker;
  if (a.busy) return;
  a.busy = true; a.error = ''; a.success = '';
  // Read the latest field values straight off the DOM in case any change
  // event missed (e.g. mobile date pickers don't always fire 'input').
  const get = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  a.staffId  = get('abStaff');
  a.fromDate = get('abFrom');
  a.toDate   = get('abTo');
  a.reason   = get('abReason');
  a.note     = get('abNote');
  if (!a.staffId) { a.error = 'Pick a staff member'; a.busy = false; render(); return; }
  render();
  try {
    const res = await api('absences_mark', {
      staff_id: a.staffId,
      from_date: a.fromDate,
      to_date: a.toDate,
      reason: a.reason,
      reason_note: a.note,
    });
    // Optimistically merge the new rows into the in-memory cache so the
    // timesheets surface updates without a roundtrip.
    if (res && res.absences) {
      const cache = state.data.tsAbsences || [];
      const idx = new Map(cache.map(r => [`${r.staff_id}|${r.date}`, r]));
      res.absences.forEach(r => idx.set(`${r.staff_id}|${r.date}`, r));
      state.data.tsAbsences = Array.from(idx.values()).sort((x, y) => (x.date < y.date ? -1 : 1));
      // Today's pill on the Dashboard reads from a separate cache.
      const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
      const todayRow = res.absences.find(r => r.date === todayStr);
      if (todayRow) {
        const t = state.data.absencesToday || [];
        if (!t.some(r => r.staff_id === todayRow.staff_id))
          state.data.absencesToday = t.concat([{ staff_id: todayRow.staff_id, reason: todayRow.reason, reason_note: todayRow.reason_note }]);
      }
    }
    a.success = `Marked ${res.count} day${res.count === 1 ? '' : 's'} absent.`;
    showToast('Absences saved');
  } catch (err) {
    a.error = String(err.message || err);
  } finally {
    a.busy = false;
  }
  render();
}

function showToast(msg) {
  let t = document.getElementById('adminToast');
  if (!t) { t = document.createElement('div'); t.id = 'adminToast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.style.display = 'none'; }, 1800);
}
function weekLabel(monday) {
  const sun = new Date(monday); sun.setDate(sun.getDate() + 6);
  const sd = monday.getDate(); const ed = sun.getDate();
  if (monday.getMonth() === sun.getMonth()) {
    return `${sd} – ${ed} ${sun.toLocaleDateString('en-GB', { month: 'long' })}`;
  }
  return `${sd} ${monday.toLocaleDateString('en-GB', { month: 'short' })} – ${ed} ${sun.toLocaleDateString('en-GB', { month: 'short' })}`;
}

// ───── REQUESTS (shift-time corrections only) ───────────────────────
function renderLeave() {
  const leave = state.data.leave || [];
  const counts = {
    Pending:  leave.filter(l => l.status === 'Pending').length,
    Approved: leave.filter(l => l.status === 'Approved').length,
    Declined: leave.filter(l => l.status === 'Declined').length,
  };
  const t = (v) => v ? String(v).slice(0, 5) : '';
  return `
    <div class="stat-row">
      ${statCard('clipboard', 'var(--amber)', 'var(--amberBg)', 'Pending', String(counts.Pending), 'Need your review')}
      ${statCard('check',     'var(--green)', 'var(--greenBg)', 'Approved (all-time)', String(counts.Approved), 'Across the team')}
      ${statCard('users',     'var(--blue)',  'var(--skySoft)', 'Declined (all-time)', String(counts.Declined), '')}
      ${statCard('clock',     'var(--ink)',   '#EEF0F6',        'Total requests', String(leave.length), '')}
    </div>

    <div class="card" style="overflow:hidden;margin-top:18px">
      <div class="card-head"><h3>Shift-change requests</h3>
        <button class="btn small" id="lvCsv">${icon('download', 15)} CSV</button>
      </div>
      <table>
        <thead><tr>
          <th>Employee</th><th>Shift date</th><th>Proposed times</th><th>Reason</th><th>Status</th><th class="r">Actions</th>
        </tr></thead>
        <tbody>
          ${leave.length === 0 ? `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">No requests yet.</td></tr>` : ''}
          ${leave.map(l => `<tr data-leave="${l.id}">
            <td>
              <div class="nm">
                <div class="av" style="background:${avColor(hashIdx(l.agent_name))};width:32px;height:32px;font-size:12px">${initials(l.agent_name)}</div>
                <div class="who"><div class="n">${escapeHtml(l.agent_name)}</div></div>
              </div>
            </td>
            <td>${escapeHtml(fmtDateRange(l.start_date, l.end_date))}</td>
            <td class="tnum" style="font-weight:700;font-size:12.5px;line-height:1.5">
              ${l.proposed_start ? `
                <div>
                  <span style="color:var(--muted);font-weight:600;font-size:10.5px">IN:</span>
                  <span style="color:var(--muted)">${l.original_in ? escapeHtml(t(l.original_in)) : 'no clock-in on this date'}</span>
                  <span style="color:var(--muted)">→</span>
                  <span>${escapeHtml(t(l.proposed_start))}</span>
                </div>` : ''}
              ${l.proposed_end ? `
                <div>
                  <span style="color:var(--muted);font-weight:600;font-size:10.5px">OUT:</span>
                  <span style="color:var(--muted)">${l.original_out ? escapeHtml(t(l.original_out)) : 'no clock-out on this date'}</span>
                  <span style="color:var(--muted)">→</span>
                  <span>${escapeHtml(t(l.proposed_end))}</span>
                </div>` : ''}
              ${!l.proposed_start && !l.proposed_end ? '<span style="color:var(--muted)">—</span>' : ''}
            </td>
            <td class="muted reason-cell" title="${escapeHtml(l.reason || '')}"><div class="reason-text">${escapeHtml(l.reason || '—')}</div></td>
            <td><span class="pill-st ${escapeHtml(l.status)}">${escapeHtml(l.status)}</span></td>
            <td class="r">
              ${l.status === 'Pending' ? `
                <button class="btn small success" data-act="Approved">Approve</button>
                <button class="btn small danger" data-act="Declined">Decline</button>
              ` : `<span class="muted" style="font-size:12.5px;font-weight:600">Reviewed</span>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}
function wireLeave() {
  document.querySelectorAll('tr[data-leave]').forEach(row => {
    const id = row.dataset.leave;
    row.querySelectorAll('button[data-act]').forEach(b =>
      b.addEventListener('click', () => decideLeave(id, b.dataset.act))
    );
  });
  // Item 16 — let the truncated REASON cell expand inline on click.
  // Hover already shows the native title-attr tooltip; click toggles
  // .details-open which drops the nowrap clamp so the row grows.
  document.querySelectorAll('td.reason-cell').forEach(cell => {
    cell.addEventListener('click', () => cell.classList.toggle('details-open'));
  });
  const csv = document.getElementById('lvCsv');
  if (csv) csv.addEventListener('click', exportLeaveCSV);
}

// ───── TEAM ──────────────────────────────────────────────────────────
function renderTeam() {
  const fullRoster = state.data.roster || [];
  // Live overlay so each card surfaces what team this person is currently
  // clocked into — same source the dashboard uses, including managers and
  // assistants. Lets the Team page show "Sheldon → Bulls" at a glance.
  const liveById = new Map((state.data.team || []).map(t => [t.id, t]));
  const isSuper = !!(state.admin && (state.admin.super || state.admin.is_super));
  const archivedCount = fullRoster.filter(s => s.active === false).length;
  // The Team view filters the FULL roster for display; the underlying data
  // (including archived) stays available to timesheets/payroll surfaces.
  const roster = state.showArchived ? fullRoster : fullRoster.filter(s => s.active !== false);
  const money = (n) => 'R' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = roster.map((s, i) => {
    const isArchived = s.active === false;
    const salary = s.salary != null ? money(s.salary) : '<span class="muted">—</span>';
    const rate = s.hourly_rate != null ? `${money(s.hourly_rate)}/hr` : '<span class="muted">No rate</span>';
    const live = liveById.get(s.id);
    const currentTeam = (!isArchived && live && live.status === 'in') ? (live.note || '').trim() : '';
    const onClock = isArchived
      ? `<span class="pill" style="background:#E0E4EC;color:#5A6473;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700">Cannot log in</span>`
      : `${tagFor(s.status)}${currentTeam ? ` <span class="team-on" title="Currently working on">${icon('clipboard', 12, 'var(--blue)')}<span>${escapeHtml(currentTeam)}</span></span>` : ''}`;
    const archAction = isArchived
      ? `<button class="btn small" data-unarchive-staff="${escapeHtml(s.id)}" title="Re-enable login for this staff member">Unarchive</button>`
      : `<button class="btn small" data-archive-staff="${escapeHtml(s.id)}" data-staff-name="${escapeHtml(s.name)}" title="Disable login but keep historical clocks">Archive</button>`;
    const badge = s.super
      ? ' <span style="font-size:10px;background:var(--blue);color:#fff;padding:2px 6px;border-radius:6px;vertical-align:middle">SUPER</span>'
      : (s.admin ? ' <span style="font-size:10px;background:var(--yellow);color:var(--ink);padding:2px 6px;border-radius:6px;vertical-align:middle">ADMIN</span>' : '');
    const archBadge = isArchived ? ' <span style="font-size:10px;background:#E0E4EC;color:#5A6473;padding:2px 6px;border-radius:6px;vertical-align:middle">ARCHIVED</span>' : '';
    return `<tr data-search="${escapeHtml(((s.name||'') + ' ' + (s.id||'')).toLowerCase())}"${isArchived ? ' style="opacity:.62"' : ''}>
      <td>
        <div style="display:flex;align-items:center;gap:11px;min-width:0">
          <div class="av" style="background:${avColor(i)};width:38px;height:38px;font-size:14px;flex:none${isArchived ? ';filter:grayscale(100%)' : ''}">${initials(s.name)}</div>
          <div style="min-width:0">
            <div class="name" style="font-size:14px">${escapeHtml(s.name)}${badge}${archBadge}</div>
            <div class="muted" style="font-size:12px">@${escapeHtml(s.id || '—')}</div>
          </div>
        </div>
      </td>
      <td style="white-space:nowrap">${salary}</td>
      <td style="white-space:nowrap">${rate}</td>
      <td>${onClock}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn small" data-edit-staff="${escapeHtml(s.id)}">Edit</button>
        ${isSuper ? archAction : ''}
      </td>
    </tr>`;
  }).join('');
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap">
      <label class="show-arch" style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--slate);cursor:pointer">
        <input type="checkbox" id="showArchived" ${state.showArchived ? 'checked' : ''}>
        Show archived${state.showArchived && archivedCount ? ` (${archivedCount})` : ''}
      </label>
      ${isSuper
        ? `<button class="btn primary small" id="addStaffBtn">+ Add staff</button>`
        : `<span class="muted" style="font-size:12.5px">Only superusers can add staff.</span>`}
    </div>
    <div class="card" style="padding:0;overflow:hidden;overflow-x:auto">
      <table class="tbl team-list" style="width:100%">
        <thead><tr>
          <th>Name</th><th>Salary</th><th>Hourly rate</th><th>On clock</th><th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody>${roster.length ? rows : `<tr><td colspan="5" class="muted" style="text-align:center;padding:28px">No staff yet${isSuper ? ' — click <b>+ Add staff</b> to add your first.' : ' — ask a superuser to add them.'}</td></tr>`}</tbody>
      </table>
    </div>
    ${state.staffModal ? renderStaffModal() : ''}
  `;
}

function wireTeam() {
  const btn = document.getElementById('addStaffBtn');
  if (btn) btn.addEventListener('click', () => {
    state.staffModal = { mode: 'add', name: '', id: '', role: '', team: '', pin: '',
                        admin: false, super: false, hourly_rate: '', weekly_hours: '', salary: '',
                        designation: 'fancy', division: '',
                        error: '', busy: false };
    render();
  });
  document.querySelectorAll('button[data-edit-staff]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.editStaff;
    const s = (state.data.roster || []).find(x => x.id === id);
    if (!s) return;
    state.staffModal = {
      mode: 'edit',
      id: s.id, name: s.name, role: s.role || '', team: s.team || '',
      pin: '', admin: !!s.admin, super: !!s.super,
      hourly_rate: s.hourly_rate != null ? String(s.hourly_rate) : '',
      weekly_hours: s.weekly_hours != null ? String(s.weekly_hours) : '',
      salary: s.salary != null ? String(s.salary) : '',
      designation: s.designation || '',
      division: s.division || '',
      active: s.active !== false, error: '', busy: false,
    };
    render();
  }));

  // "Show archived" toggle — just flips the display filter; the roster
  // already contains everyone (boot loads with include_inactive=true).
  const showArch = document.getElementById('showArchived');
  if (showArch) showArch.addEventListener('change', () => {
    state.showArchived = !!showArch.checked;
    render();
  });

  // Archive / Unarchive — staff stays in the DB so their historical clock
  // events still count for payroll, but `active=false` blocks login (see
  // quay-data.js login handler) and hides them from PWA roster surfaces.
  const flipActive = async (id, name, active, btn) => {
    if (!active && name && !confirm(`Archive ${name}? They won't be able to log in. Historical clocks stay in payroll.`)) return;
    btn.disabled = true; btn.textContent = active ? 'Unarchiving…' : 'Archiving…';
    const res = await api('roster_set_active', { id, active });
    if (!res || res.ok === false) {
      alert('Could not update: ' + (res && res.error || 'unknown error'));
      btn.disabled = false; btn.textContent = active ? 'Unarchive' : 'Archive';
      return;
    }
    // Mutate the in-memory row so we re-render without a network round-trip.
    const row = (state.data.roster || []).find(x => x.id === id);
    if (row) row.active = active;
    render();
  };
  document.querySelectorAll('button[data-archive-staff]').forEach(b => b.addEventListener('click', () =>
    flipActive(b.dataset.archiveStaff, b.dataset.staffName || b.dataset.archiveStaff, false, b)));
  document.querySelectorAll('button[data-unarchive-staff]').forEach(b => b.addEventListener('click', () =>
    flipActive(b.dataset.unarchiveStaff, null, true, b)));

  if (state.staffModal) wireStaffModal();
}

// One modal handles both add + edit. f.mode = 'add' | 'edit'.
function renderStaffModal() {
  const f = state.staffModal;
  const isEdit = f.mode === 'edit';
  const err = f.error || '';
  return `
    <div class="modal-back" id="staffBack"></div>
    <div class="modal" role="dialog">
      <div class="modal-head">
        <h3>${isEdit ? 'Edit ' + escapeHtml(f.name) : 'Add a staff member'}</h3>
        <button class="modal-close" id="staffClose" aria-label="Close">${icon('x', 18, 'var(--muted)')}</button>
      </div>
      <div class="modal-body">
        <label class="field"><span>Name</span>
          <input id="sfName" type="text" value="${escapeHtml(f.name)}" placeholder="e.g. Thandi Mokoena" ${isEdit ? '' : 'autofocus'}>
        </label>
        ${isEdit ? `
          <label class="field"><span>Username</span>
            <input type="text" value="${escapeHtml(f.id)}" disabled>
            <div class="hint">Username can't be changed after creation.</div>
          </label>
        ` : `
          <label class="field"><span>Username</span>
            <input id="sfId" type="text" value="${escapeHtml(f.id)}" placeholder="auto from name — lowercase, no spaces" autocapitalize="off" autocomplete="off">
            <div class="hint">Used as the login id. Auto-generated from name; edit to override.</div>
          </label>
        `}
        <div class="field-row">
          <label class="field"><span>Role</span>
            <input id="sfRole" type="text" value="${escapeHtml(f.role)}" placeholder="Sales Agent">
          </label>
          <label class="field"><span>Team</span>
            <input id="sfTeam" type="text" value="${escapeHtml(f.team)}" placeholder="Sales">
          </label>
        </div>
        <label class="field"><span>Monthly salary (R)</span>
          <input id="sfSalary" type="number" step="0.01" min="0" value="${escapeHtml(f.salary)}" placeholder="e.g. 12000.00">
          <div class="hint">Admin-only. Shown on the Team list.</div>
        </label>
        <div class="field-row">
          <label class="field"><span>Hourly rate (R)</span>
            <input id="sfRate" type="number" step="0.01" min="0" value="${escapeHtml(f.hourly_rate)}" placeholder="e.g. 75.00">
          </label>
          <label class="field"><span>Weekly hours</span>
            <input id="sfHours" type="number" step="0.5" min="0" max="80" value="${escapeHtml(f.weekly_hours)}" placeholder="e.g. 45">
          </label>
        </div>
        <div class="field-row">
          <label class="field"><span>Designation</span>
            <select id="sfDesignation">
              ${['super_admin','manager','rm','fancy','ln','assistant','admin_assistant','payroll'].map(d => `
                <option value="${d}" ${f.designation === d ? 'selected' : ''}>${
                  d === 'super_admin'     ? 'Super Admin' :
                  d === 'manager'         ? 'Manager' :
                  d === 'rm'              ? 'RM (Relationship Manager)' :
                  d === 'fancy'           ? 'Fancy Caller' :
                  d === 'ln'              ? 'LN (Lead Nurturer)' :
                  d === 'admin_assistant' ? 'Admin Assistant' :
                  d === 'payroll'         ? 'Payroll (dashboard access)' :
                  'Assistant'
                }</option>`).join('')}
            </select>
            <div class="hint">LN + Assistant get the end-of-day report form on clock-out. Admin Assistant is exempt.</div>
          </label>
          <label class="field"><span>Division</span>
            <input id="sfDivision" type="text" list="sfDivisionList" value="${escapeHtml(f.division || '')}" placeholder="e.g. Engine Room">
            <datalist id="sfDivisionList">
              <option value="Engine Room"></option>
              <option value="RM"></option>
              <option value="Fancy"></option>
              <option value="Inbound"></option>
              <option value="Outbound"></option>
            </datalist>
          </label>
        </div>
        ${isEdit ? (
          (state.admin && (state.admin.super || state.admin.is_super)) ? `
          <label class="field"><span>Reset PIN</span>
            <input id="sfPin" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" value="${escapeHtml(f.pin)}" placeholder="Leave blank to keep current — enter 6 digits to change">
            <div class="hint">Only fill this in if you want to change ${escapeHtml(f.name || 'their')} login PIN.</div>
          </label>
        ` : ''
        ) : `
          <label class="field"><span>PIN</span>
            <input id="sfPin" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" value="${escapeHtml(f.pin)}" placeholder="6 digits — they'll use this to log in">
          </label>
        `}
        <label class="check">
          <input id="sfAdmin" type="checkbox" ${f.admin ? 'checked' : ''}>
          <span>Admin — can open the manager dashboard</span>
        </label>
        <label class="check">
          <input id="sfSuper" type="checkbox" ${f.super ? 'checked' : ''}>
          <span>Superuser — can also see the Leadership tab</span>
        </label>
        ${err ? `<div class="banner">${escapeHtml(err)}</div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn" id="staffCancel">Cancel</button>
        <button class="btn primary" id="staffSave" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Add staff')}</button>
      </div>
    </div>`;
}

function wireStaffModal() {
  const close = () => { state.staffModal = null; render(); };
  document.getElementById('staffBack').addEventListener('click', close);
  document.getElementById('staffClose').addEventListener('click', close);
  document.getElementById('staffCancel').addEventListener('click', close);

  const f = state.staffModal;
  const isEdit = f.mode === 'edit';
  const name  = document.getElementById('sfName');
  const idIn  = document.getElementById('sfId'); // null in edit mode
  const role  = document.getElementById('sfRole');
  const team  = document.getElementById('sfTeam');
  const rate  = document.getElementById('sfRate');
  const hours = document.getElementById('sfHours');
  const salary = document.getElementById('sfSalary');
  const pin   = document.getElementById('sfPin');
  const adm   = document.getElementById('sfAdmin');
  const sup   = document.getElementById('sfSuper');

  // Auto-slug the username from name (add mode only) until user touches id.
  let idTouched = !!f.id;
  name.addEventListener('input', () => {
    f.name = name.value;
    if (!isEdit && !idTouched && idIn) {
      const slug = name.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      idIn.value = slug; f.id = slug;
    }
  });
  if (idIn) idIn.addEventListener('input', () => { idTouched = true; f.id = idIn.value; });
  role.addEventListener('input',  () => { f.role  = role.value; });
  team.addEventListener('input',  () => { f.team  = team.value; });
  rate.addEventListener('input',  () => { f.hourly_rate  = rate.value; });
  hours.addEventListener('input', () => { f.weekly_hours = hours.value; });
  if (salary) salary.addEventListener('input', () => { f.salary = salary.value; });
  const desig = document.getElementById('sfDesignation');
  if (desig) desig.addEventListener('change', () => {
    f.designation = desig.value;
    // Auto-sync Admin + Super to match the role so demoting someone via
    // the designation dropdown (e.g. 'super_admin' → 'fancy') also clears
    // their old super/admin flags.
    const isSuper = f.designation === 'super_admin';
    const isAdmin = isSuper || f.designation === 'manager';
    f.super = isSuper;
    f.admin = isAdmin;
    if (adm) adm.checked = isAdmin;
    if (sup) sup.checked = isSuper;
  });
  const division = document.getElementById('sfDivision');
  if (division) division.addEventListener('input', () => { f.division = division.value; });
  if (pin) pin.addEventListener('input', () => { f.pin = pin.value.replace(/[^0-9]/g, '').slice(0, 6); pin.value = f.pin; });
  adm.addEventListener('change', () => { f.admin = adm.checked; });
  if (sup) sup.addEventListener('change', () => { f.super = sup.checked; });

  document.getElementById('staffSave').addEventListener('click', submitStaffModal);
}

async function submitStaffModal() {
  const f = state.staffModal;
  if (!f) return;
  f.error = '';
  if (!f.name.trim()) { f.error = 'Name is required'; render(); return; }
  if (f.mode === 'add' && (!f.pin || f.pin.length !== 6)) {
    f.error = 'PIN must be 6 digits'; render(); return;
  }
  f.busy = true; render();
  try {
    if (f.mode === 'add') {
      await api('roster_add', {
        name: f.name.trim(),
        id: f.id.trim() || f.name,
        role: f.role.trim(),
        team: f.team.trim(),
        pin: f.pin,
        admin: !!f.admin,
        super: !!f.super,
        hourly_rate:  f.hourly_rate  === '' ? null : Number(f.hourly_rate),
        weekly_hours: f.weekly_hours === '' ? null : Number(f.weekly_hours),
        salary:       f.salary       === '' ? null : Number(f.salary),
        designation: f.designation || null,
        division: f.division || null,
      });
    } else {
      // Validate optional PIN reset before any writes.
      const newPin = (f.pin || '').trim();
      if (newPin && newPin.length !== 6) {
        f.busy = false; f.error = 'New PIN must be 6 digits (or leave blank to keep current).';
        render(); return;
      }
      await api('staff_update', {
        id: f.id,
        name: f.name.trim(),
        role: f.role.trim(),
        team: f.team.trim(),
        admin: !!f.admin,
        super: !!f.super,
        hourly_rate:  f.hourly_rate  === '' ? null : Number(f.hourly_rate),
        weekly_hours: f.weekly_hours === '' ? null : Number(f.weekly_hours),
        salary:       f.salary       === '' ? null : Number(f.salary),
        designation: f.designation || null,
        division: f.division || null,
      });
      if (newPin) {
        await api('staff_set_pin', { id: f.id, pin: newPin });
      }
    }
    state.staffModal = null;
    await loadAll();
    render();
  } catch (e) {
    f.busy = false;
    f.error = String(e.message || e);
    render();
  }
}

// ───── EXPORTS ───────────────────────────────────────────────────────
function exportCurrent() {
  if (state.view === 'dashboard' || state.view === 'team') exportTeamCSV();
  else if (state.view === 'timesheets') exportTimesheetsCSV();
  else if (state.view === 'leave')      exportLeaveCSV();
}
function exportTeamCSV() {
  const team = state.data.team || [];
  const rows = [['Name','Role','Status','Clock-in','Note','Hours today']];
  team.forEach(t => rows.push([t.name, t.role || '', statusLabel(t.status), t.cin || '', t.note || '', fmtHM(t.todayHrs || 0)]));
  downloadCSV(`team-${new Date().toISOString().slice(0,10)}.csv`, rows);
}
function exportTimesheetsCSV() {
  // List layout → Connecteam-compatible per-shift CSV (location columns omitted
  // per project decision). Grid layout → the per-day matrix below.
  const period = state.tsPeriod || 'this-week';
  const range = periodRange(period, state.tsCustomFrom, state.tsCustomTo);
  if ((state.tsLayout || 'grid') === 'list') {
    return exportTimesheetsListCSV(range, period);
  }
  const events = state.data.tsEvents || [];
  const roster = state.data.roster || [];
  const cols = range.kind === 'month' ? monthlyBuckets(range) : weeklyBuckets(range);
  const grid = {};
  roster.forEach(a => { grid[a.id] = { name: a.name, role: a.role, vals: cols.map(_ => 0) }; });
  // Pair-first — attribute each shift's real duration to its IN-time
  // column (so an overnight shift lands in the day it started). This
  // was previously summing raw duration_hrs which dropped manual shifts
  // and trusted stale cache values.
  pairShifts(events).forEach(sh => {
    if (sh.hrs <= 0) return;
    if (!grid[sh.staff_id]) {
      const r = roster.find(a => a.id === sh.staff_id);
      grid[sh.staff_id] = { name: (r && r.name) || sh.staff_id, role: (r && r.role) || '', vals: cols.map(_ => 0) };
    }
    const anchorTs = sh.in_ts != null ? sh.in_ts : sh.out_ts;
    const idx = cols.findIndex(c => anchorTs >= c.from && anchorTs <= c.to);
    if (idx >= 0) grid[sh.staff_id].vals[idx] += sh.hrs;
  });
  // Column header dates depend on period
  const headers = cols.map(c => {
    const d = new Date(c.from);
    if (range.kind === 'week') return d.toISOString().slice(0, 10);
    return c.label; // W1, W2, ...
  });
  const rows = [['Employee', 'Role', ...headers, 'Total']];
  Object.values(grid).forEach(v => {
    const total = v.vals.reduce((s, h) => s + h, 0);
    rows.push([v.name, v.role || '', ...v.vals.map(h => h.toFixed(2)), total.toFixed(2)]);
  });
  const tag = range.kind === 'month'
    ? range.from.toISOString().slice(0, 7)
    : range.from.toISOString().slice(0, 10);
  downloadCSV(`timesheets-${period}-${tag}.csv`, rows);
}

// Connecteam-format export — one row per shift, daily/weekly totals stamped
// on the LAST shift of each day/week (blank otherwise), matching the
// "May timesheets - May 2026 Connecteams.csv" layout minus location columns.
function exportTimesheetsListCSV(range, period) {
  const rows = buildShiftRows(range);
  const header = [
    'First name', 'Last name', 'Type', 'Sub-job',
    'Start Date', 'In', 'End Date', 'Out',
    'Employee notes', 'Manager notes',
    'Shift hours', 'Daily total hours', 'Weekly total hours',
  ];
  const splitName = (full) => {
    const parts = String(full || '').trim().split(/\s+/);
    return [parts[0] || '', parts.slice(1).join(' ')];
  };
  const isoDate = (d) => d ? d.toISOString().slice(0, 10) : '';
  const out = [header];
  rows.forEach(s => {
    const [first, last] = splitName(s.agentName);
    out.push([
      first, last,
      'Shift', s.role || '',
      isoDate(s.inDate || s.outDate),
      s.inDate ? fmtTimeOf(s.inDate) : '',
      isoDate(s.outDate || s.inDate),
      s.outDate ? fmtTimeOf(s.outDate) : '',
      s.note || '', s.mgrNote || '',
      fmtHM(s.hrs),
      s.dailyTotal  != null ? fmtHM(s.dailyTotal)  : '',
      s.weeklyTotal != null ? fmtHM(s.weeklyTotal) : '',
    ]);
  });
  const tag = range.from.toISOString().slice(0, 10) + '_to_' + range.to.toISOString().slice(0, 10);
  downloadCSV(`timesheets-connecteam-${period}-${tag}.csv`, out);
}

function exportLeaveCSV() {
  const leave = state.data.leave || [];
  const rows = [['ID', 'Submitted', 'Employee', 'Type', 'Start', 'End', 'Days', 'Status', 'Decided by', 'Reason']];
  leave.forEach(l => rows.push([l.id, l.ts, l.agent_name, l.type, l.start_date, l.end_date, l.days, l.status, l.decided_by, l.reason]));
  downloadCSV(`leave-${new Date().toISOString().slice(0,10)}.csv`, rows);
}
function statusLabel(s) {
  if (s === 'in')    return 'On the clock';
  if (s === 'break') return 'On break';
  if (s === 'leave') return 'On leave';
  return 'Clocked out';
}

// ───── GATE (Admin sign-in: username + PIN) ──────────────────────────
function renderGate() {
  const dots = [0,1,2,3,4,5].map(i => `<div class="dot ${i < state.pinBuf.length ? 'filled' : ''}"></div>`).join('');
  const userPref = (typeof localStorage !== 'undefined' && localStorage.getItem('quay_admin_last_user')) || state.loginUser || '';
  return `<div class="gate">
    <div class="box ${state.pinErr ? 'pin-error' : ''}">
      <img src="../assets/quay1-logo-white.png" alt="Quay 1">
      <h2>Admin Dashboard</h2>
      <div class="sub">Sign in with your admin username + PIN</div>
      <input id="gateUser" class="gate-user" type="text" autocomplete="username"
             autocapitalize="none" autocorrect="off"
             placeholder="username" value="${escapeHtml(userPref)}">
      <div class="dots">${dots}</div>
      <div class="err">${state.error ? escapeHtml(state.error) : ''}</div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-d="${n}">${n}</button>`).join('')}
        <button class="key alt" data-back>← Back</button>
        <button class="key" data-d="0">0</button>
        <button class="key alt" data-clear>Clear</button>
      </div>
      <div class="foot">Only roster rows with <b>admin = true</b> can sign in.</div>
    </div>
  </div>`;
}
function wireGate() {
  const u = document.getElementById('gateUser');
  if (u) u.addEventListener('input', () => { state.loginUser = u.value; });
  document.querySelectorAll('.gate .key[data-d]').forEach(b => b.addEventListener('click', () => {
    if (state.pinBuf.length >= 6) return;
    state.pinBuf += b.dataset.d; state.pinErr = false; state.error = null; render();
    if (state.pinBuf.length === 6) submitAdminPin();
  }));
  const back = document.querySelector('.gate .key[data-back]');
  if (back) back.addEventListener('click', () => { state.pinBuf = state.pinBuf.slice(0, -1); render(); });
  const clr = document.querySelector('.gate .key[data-clear]');
  if (clr) clr.addEventListener('click', () => { state.pinBuf = ''; state.error = null; render(); });
}
async function submitAdminPin() {
  const u = document.getElementById('gateUser');
  if (u) state.loginUser = u.value;
  const username = String(state.loginUser || '').trim().toLowerCase();
  if (!username) {
    state.pinErr = true; state.error = 'Enter your username first'; state.pinBuf = '';
    setTimeout(() => { state.pinErr = false; render(); }, 600); render(); return;
  }
  try {
    const data = await api('admin_check', { username, pin: state.pinBuf });
    state.admin = { ...data.admin };
    writeSession(state.admin);
    try { localStorage.setItem('quay_admin_last_user', username); } catch {}
    state.pinBuf = ''; state.error = null;
    await loadAll();
    render();
  } catch (e) {
    state.pinErr = true; state.error = String(e.message || e); state.pinBuf = '';
    setTimeout(() => { state.pinErr = false; render(); }, 600);
    render();
  }
}

// ───── BOOT ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// ───── REALTIME ─────────────────────────────────────────────────────
// Subscribe to events + requests via Supabase Realtime so changes
// surface immediately (live who's-on-now, instant approval feedback).
// Falls back to a 5-min poll in case the websocket drops.
let _rtChannel = null;
let _rtReloadTimer = null;
function rtReload() {
  // Debounce — collapse bursts (e.g. clock-in writes an 'in' row, then an
  // 'out' a moment later) into a single reload.
  clearTimeout(_rtReloadTimer);
  _rtReloadTimer = setTimeout(() => {
    if (state.admin && document.visibilityState === 'visible') loadAll();
  }, 1500);
}
function subscribeRealtime() {
  if (_rtChannel || !state.admin || !window.sb) return;
  try {
    _rtChannel = window.sb
      .channel('admin-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' },   rtReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, rtReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' },    rtReload)
      .subscribe();
  } catch (e) { console.warn('[rt] subscribe failed', e); }
}
// Wire the subscription as soon as we have an admin session. boot() may run
// before state.admin is set, so re-attempt opportunistically.
setInterval(subscribeRealtime, 2000);
// Belt-and-suspenders: a slow poll in case the websocket dies silently.
setInterval(() => { if (state.admin && document.visibilityState === 'visible') loadAll(); }, 5 * 60 * 1000);

})();
