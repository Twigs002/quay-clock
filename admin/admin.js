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
  tsPeriod: 'this-week', // this-week | last-week | this-month | last-month
  tsDetail: null,        // { agentId, agentName } when detail modal open
};

const $root = document.getElementById('admin');

// ───── BOOT ──────────────────────────────────────────────────────────
function boot() {
  // Redirected standalone visits skip booting so the redirect message stays put.
  if (window.__quayAdminRedirect) return;
  const stored = readSession();
  if (stored && stored.id && stored.pin) {
    state.admin = stored;
    loadAll();
  }
  render();

  // In embed mode, ask the parent dashboard to hand off the admin session.
  // The parent is expected to reply with { type: 'quay-admin-session', admin: {...} }.
  if (EMBED && window.parent && window.parent !== window) {
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m || m.type !== 'quay-admin-session' || !m.admin || !m.admin.pin) return;
      state.admin = m.admin;
      writeSession(state.admin);
      loadAll();
    });
    try { window.parent.postMessage({ type: 'quay-admin-ready' }, '*'); } catch {}
  }
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
async function api(action, payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

// ───── HELPERS ───────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
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
const AV = ['#3D5BA6','#D20A03','#1FA463','#7A5AB6','#C8920A','#2F8FB3'];
const avColor = (i) => AV[(i || 0) % AV.length];
function startOfWeek(d) {
  const x = new Date(d); const day = (x.getDay() + 6) % 7;
  x.setHours(0,0,0,0); x.setDate(x.getDate() - day); return x;
}
function endOfWeek(d) { const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate() + 6); e.setHours(23,59,59,999); return e; }

const PERIOD_LABELS = {
  'this-week':  'This Week',
  'last-week':  'Last Week',
  'this-month': 'This Month',
  'last-month': 'Last Month',
};
function periodRange(p) {
  const now = new Date();
  if (p === 'last-week') {
    const lw = new Date(now); lw.setDate(lw.getDate() - 7);
    return { from: startOfWeek(lw), to: endOfWeek(lw), kind: 'week' };
  }
  if (p === 'this-month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0),
             to:   new Date(now.getFullYear(), now.getMonth() + 1, 0, 23,59,59),
             kind: 'month' };
  }
  if (p === 'last-month') {
    return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1, 0,0,0),
             to:   new Date(now.getFullYear(), now.getMonth(), 0, 23,59,59),
             kind: 'month' };
  }
  return { from: startOfWeek(now), to: endOfWeek(now), kind: 'week' };
}
function periodLabel(p) {
  const r = periodRange(p);
  if (r.kind === 'week') return weekLabel(r.from);
  return r.from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
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
      api('roster', {}),
      api('events', { from, to }),
    ]);
    state.data.team = team.team || [];
    state.data.summary = summary.summary || [];
    state.data.leave = (leave.leave || []).map(l => ({ ...l, dates: fmtDateRange(l.start_date, l.end_date) }));
    state.data.roster = roster.roster || [];
    state.data.weekEvents = events.events || [];
    // Initial Timesheets payload mirrors the dashboard's current-week events.
    if (state.tsPeriod === 'this-week') state.data.tsEvents = state.data.weekEvents;
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false; render();
  }
}

async function loadTsEvents(period) {
  state.tsPeriod = period;
  if (period === 'this-week' && state.data.weekEvents) {
    state.data.tsEvents = state.data.weekEvents;
    render(); return;
  }
  const r = periodRange(period);
  state.loading = true; render();
  try {
    const data = await api('events', { from: r.from.toISOString(), to: r.to.toISOString() });
    state.data.tsEvents = data.events || [];
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
    <button class="signout-mini" id="signOut" title="Sign out">${icon('chevron', 16, 'rgba(255,255,255,0.6)')}</button>
  </div>`;
}

// ── Topbar ───────────────────────────────────────────────────────────
const TITLES = {
  dashboard:  ['Dashboard',  'Live overview of your team today'],
  timesheets: ['Timesheets', 'Review & approve hours'],
  leave:      ['Requests',   'Leave & shift-change requests'],
  team:       ['Team',       'Staff directory & status'],
};
function renderTopbar() {
  const [t, sub] = TITLES[state.view] || ['', ''];
  const now = new Date();
  return `<div class="topbar">
    <div>
      <h1>${escapeHtml(t)}</h1>
      <div class="sub">${escapeHtml(sub)}</div>
    </div>
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
  if (so) so.addEventListener('click', () => {
    writeSession(null); state.admin = null; render();
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
    default:           return '';
  }
}

// ───── DASHBOARD ─────────────────────────────────────────────────────
function renderDashboard() {
  const team = state.data.team || [];
  const onNow = team.filter(s => s.status === 'in').length;
  const onLeave = (state.data.leave || []).filter(l =>
    l.status === 'Approved' && isToday(l.start_date, l.end_date)
  );
  const hoursToday = team.reduce((s, t) => s + (t.todayHrs || 0), 0);
  const pending = (state.data.leave || []).filter(l => l.status === 'Pending');

  return `
    <div class="stat-row">
      ${statCard('clock', 'var(--green)', 'var(--greenBg)', 'On the clock', String(onNow), `of ${team.length} staff`)}
      ${statCard('clipboard', 'var(--amber)', 'var(--amberBg)', 'Pending requests', String(pending.length), pending.length ? 'needs your review' : 'all caught up')}
      ${statCard('calendar', 'var(--blue)', 'var(--skySoft)', 'On leave', String(onLeave.length), onLeave.map(l => l.agent_name).join(', ') || '—')}
      ${statCard('chart', 'var(--ink)', '#EEF0F6', 'Hours logged today', fmtHM(hoursToday), 'across the team')}
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
        <table>
          <thead><tr>
            <th>Employee</th><th>Status</th><th>Clock-in</th>
            <th>Location</th><th>Today</th><th>Shift note</th>
          </tr></thead>
          <tbody>
            ${team.length === 0 ? `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">No staff in the roster yet — add rows to the sheet.</td></tr>` : ''}
            ${team.map((s, i) => `<tr class="${(s.status === 'off' || s.status === 'leave') ? 'dim' : ''}" data-search="${escapeHtml(((s.name||'') + ' ' + (s.role||'') + ' ' + (s.id||'')).toLowerCase())}">
              <td>
                <div class="nm">
                  <div class="av" style="background:${avColor(i)};width:34px;height:34px;font-size:12.5px">${initials(s.name)}</div>
                  <div class="who"><div class="n">${escapeHtml(s.name)}</div><div class="r">${escapeHtml(s.role || '')}</div></div>
                </div>
              </td>
              <td>${tagFor(s.status)}</td>
              <td class="tnum">${s.cin || '—'}</td>
              <td>${s.loc ? `<span class="pin">${icon('pin', 14, 'var(--blue)')}${escapeHtml(s.loc)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="tnum" style="color:var(--blue);font-weight:800">${fmtHM(s.todayHrs || 0)}</td>
              <td class="muted" style="max-width:240px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.note || '—')}</div></td>
            </tr>`).join('')}
          </tbody>
        </table>
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
      </div>
    </div>
  `;
}

function renderWeekHoursChart() {
  const events = state.data.weekEvents || [];
  const byDay = [0,0,0,0,0,0,0];
  events.forEach(e => {
    if (e.action !== 'out' || e.duration_hrs == null) return;
    const d = new Date(e.ts);
    const idx = (d.getDay() + 6) % 7;
    byDay[idx] += e.duration_hrs;
  });
  const max = Math.max(8, ...byDay);
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
  if (!state.admin || !state.admin.pin) { state.error = 'Admin session expired — sign in again.'; render(); return; }
  try {
    await api('leave_decide', { id, status, admin_pin: state.admin.pin });
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
  const today = new Date().toISOString().slice(0, 10);
  return today >= start && today <= (end || start);
}

// ───── TIMESHEETS ────────────────────────────────────────────────────
function renderTimesheets() {
  const period = state.tsPeriod || 'this-week';
  const range = periodRange(period);
  const events = state.data.tsEvents || [];
  const roster = state.data.roster || [];
  const isMonth = range.kind === 'month';

  const periodChips = ['this-week','last-week','this-month','last-month']
    .map(p => `<button class="seg-btn ${p === period ? 'on' : ''}" data-ts-period="${p}">${PERIOD_LABELS[p]}</button>`)
    .join('');

  // Aggregate by agent → choose column layout based on weekly vs monthly.
  const cols = isMonth ? monthlyBuckets(range) : weeklyBuckets();
  const grid = {};
  roster.forEach(a => { grid[a.id] = { name: a.name, role: a.role, vals: cols.map(_ => 0), total: 0, days: {} }; });
  events.forEach(e => {
    if (e.action !== 'out' || e.duration_hrs == null) return;
    const ts = new Date(e.ts).getTime();
    if (!grid[e.id]) grid[e.id] = { name: e.name, role: '', vals: cols.map(_ => 0), total: 0, days: {} };
    const idx = cols.findIndex(c => ts >= c.from && ts <= c.to);
    if (idx >= 0) {
      grid[e.id].vals[idx] += e.duration_hrs;
      grid[e.id].total += e.duration_hrs;
      const dayKey = new Date(e.ts).toISOString().slice(0, 10);
      grid[e.id].days[dayKey] = (grid[e.id].days[dayKey] || 0) + e.duration_hrs;
    }
  });
  const rows = Object.entries(grid)
    .filter(([, v]) => v.total > 0 || roster.some(a => a.name === v.name))
    .sort((a, b) => b[1].total - a[1].total);

  return `<div class="card" style="overflow:hidden">
    <div class="card-head" style="flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h3>${escapeHtml(periodLabel(period))}</h3>
        <div class="seg-pills" role="tablist">${periodChips}</div>
      </div>
      <button class="btn small" id="tsCsv">${icon('download', 15)} Export CSV</button>
    </div>
    <div class="ts-table-wrap ${isMonth ? 'ts-table-wrap--month' : ''}">
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
            ${v.vals.map((h, ci) => `<td class="ctr tnum ${cols[ci].weekend ? 'ts-weekend' : ''}" style="${h ? '' : 'color:var(--muted)'}">${fmtHM(h)}</td>`).join('')}
            <td class="ctr tnum ts-total-col" style="color:var(--blue);font-weight:800">${fmtHM(v.total)}</td>
            <td class="r ts-act-col">
              <button class="btn small" data-detail-events="${escapeHtml(id)}" data-name="${escapeHtml(v.name)}">View</button>
              <button class="btn small" data-edit-events="${escapeHtml(id)}" data-name="${escapeHtml(v.name)}" style="margin-left:6px">Edit</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${state.eventEditor ? renderEventEditor() : ''}
    ${state.tsDetail ? renderTsDetail() : ''}
  </div>`;
}

function weeklyBuckets() {
  const sow = startOfWeek(new Date());
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
  document.querySelectorAll('button[data-edit-events]').forEach(b => b.addEventListener('click', () => {
    openEventEditor(b.dataset.editEvents, b.dataset.name);
  }));
  document.querySelectorAll('button[data-detail-events]').forEach(b => b.addEventListener('click', () => {
    openTsDetail(b.dataset.detailEvents, b.dataset.name);
  }));
  if (state.eventEditor) wireEventEditor();
  if (state.tsDetail) wireTsDetail();
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
      const hrs = (e.duration_hrs != null && !isNaN(e.duration_hrs))
        ? Number(e.duration_hrs)
        : (inDate ? (outDate - inDate) / 3.6e6 : 0);
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
    const wk = startOfWeek(s.date).toISOString().slice(0, 10);
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
      const k = s.date.toISOString().slice(0, 10);
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
      const hrs = (e.duration_hrs != null) ? Number(e.duration_hrs) : (inDate ? (outDate - inDate) / 3.6e6 : 0);
      rows.push([
        (inDate || outDate).toISOString().slice(0, 10),
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
function openEventEditor(agentId, agentName) {
  const sow = startOfWeek(new Date());
  const events = (state.data.weekEvents || [])
    .filter(e => e.id === agentId)
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  state.eventEditor = {
    agentId, agentName,
    weekStart: sow,
    events: events.slice(),
    busy: false, error: '', adding: false,
    addDraft: { action: 'in', date: new Date().toISOString().slice(0,10), time: '08:00', note: '', loc: '' },
  };
  render();
}

function renderEventEditor() {
  const e = state.eventEditor;
  const items = e.events.map((ev, idx) => {
    const d = new Date(ev.ts);
    const date = d.toISOString().slice(0,10);
    const hh = pad(d.getHours()), mm = pad(d.getMinutes());
    return `<div class="evrow" data-idx="${idx}">
      <select class="ev-action">
        <option value="in"  ${ev.action === 'in'  ? 'selected' : ''}>IN</option>
        <option value="out" ${ev.action === 'out' ? 'selected' : ''}>OUT</option>
      </select>
      <input class="ev-date" type="date" value="${date}">
      <input class="ev-time" type="time" value="${hh}:${mm}">
      <input class="ev-note" type="text" value="${escapeHtml(ev.note || '')}" placeholder="note">
      <button class="btn small" data-save="${idx}">Save</button>
      <button class="btn small danger" data-del="${idx}">Delete</button>
    </div>`;
  }).join('');
  const addBlock = e.adding ? `
    <div class="evrow add">
      <select id="evNewAction">
        <option value="in" ${e.addDraft.action === 'in' ? 'selected' : ''}>IN</option>
        <option value="out" ${e.addDraft.action === 'out' ? 'selected' : ''}>OUT</option>
      </select>
      <input id="evNewDate" type="date" value="${e.addDraft.date}">
      <input id="evNewTime" type="time" value="${e.addDraft.time}">
      <input id="evNewNote" type="text" value="${escapeHtml(e.addDraft.note)}" placeholder="note">
      <button class="btn small primary" id="evAdd">Add</button>
      <button class="btn small" id="evAddCancel">Cancel</button>
    </div>` : `<button class="btn small primary" id="evShowAdd">+ Add event</button>`;
  return `
    <div class="modal-back" id="evBack"></div>
    <div class="modal" role="dialog" style="width:min(640px, calc(100vw - 32px))">
      <div class="modal-head">
        <h3>Edit events — ${escapeHtml(e.agentName)}</h3>
        <button class="modal-close" id="evClose">${icon('x', 18, 'var(--muted)')}</button>
      </div>
      <div class="modal-body">
        <div class="ev-help">
          Manually adjust this week's clock events. Pair each IN with an OUT for the duration to count.
        </div>
        ${e.events.length === 0 ? `<div class="muted" style="font-size:13px;padding:6px 0">No events this week.</div>` : ''}
        ${items}
        ${e.error ? `<div class="banner">${escapeHtml(e.error)}</div>` : ''}
        <div style="margin-top:6px">${addBlock}</div>
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

  document.querySelectorAll('.evrow[data-idx]').forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelector('button[data-save]').addEventListener('click', () => saveEvent(idx, row));
    row.querySelector('button[data-del]').addEventListener('click', () => deleteEvent(idx));
  });

  const showAdd = document.getElementById('evShowAdd');
  if (showAdd) showAdd.addEventListener('click', () => { state.eventEditor.adding = true; render(); });
  const cancel = document.getElementById('evAddCancel');
  if (cancel) cancel.addEventListener('click', () => { state.eventEditor.adding = false; render(); });
  const addBtn = document.getElementById('evAdd');
  if (addBtn) addBtn.addEventListener('click', addEvent);
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
      admin_pin: state.admin.pin,
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
    await api('event_delete', { admin_pin: state.admin.pin, agent_id: e.agentId, ts: ev.ts });
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
  const action = document.getElementById('evNewAction').value;
  const date = document.getElementById('evNewDate').value;
  const time = document.getElementById('evNewTime').value;
  const note = document.getElementById('evNewNote').value;
  e.addDraft = { action, date, time, note, loc: '' };
  if (!date || !time) { e.error = 'Pick a valid date and time'; render(); return; }
  const ts = new Date(date + 'T' + time + ':00').toISOString();
  try {
    await api('event_add', { admin_pin: state.admin.pin, agent_id: e.agentId, ts, dir: action, note });
    e.events.push({ ts, id: e.agentId, name: e.agentName, action, note, loc: '', duration_hrs: null });
    e.events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    e.adding = false; e.error = '';
    showToast('Added');
  } catch (err) {
    e.error = String(err.message || err);
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

// ───── LEAVE ─────────────────────────────────────────────────────────
function renderLeave() {
  const leave = state.data.leave || [];
  const counts = {
    Pending:  leave.filter(l => l.status === 'Pending').length,
    Approved: leave.filter(l => l.status === 'Approved').length,
    Declined: leave.filter(l => l.status === 'Declined').length,
  };
  const outToday = leave.filter(l => l.status === 'Approved' && isToday(l.start_date, l.end_date)).length;
  return `
    <div class="stat-row">
      ${statCard('calendar', 'var(--amber)', 'var(--amberBg)', 'Pending requests', String(counts.Pending), 'Needs your review')}
      ${statCard('check', 'var(--green)', 'var(--greenBg)', 'Approved (all-time)', String(counts.Approved), 'Across the team')}
      ${statCard('users', 'var(--blue)', 'var(--skySoft)', 'Out today', String(outToday), 'on approved leave')}
      ${statCard('sun', 'var(--ink)', '#EEF0F6', 'Total declined', String(counts.Declined), '')}
    </div>

    <div class="card" style="overflow:hidden;margin-top:18px">
      <div class="card-head"><h3>All requests</h3>
        <button class="btn small" id="lvCsv">${icon('download', 15)} CSV</button>
      </div>
      <table>
        <thead><tr>
          <th>Employee</th><th>Type</th><th>Dates</th><th>Reason</th><th>Status</th><th class="r">Actions</th>
        </tr></thead>
        <tbody>
          ${leave.length === 0 ? `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">No leave requests yet.</td></tr>` : ''}
          ${leave.map(l => `<tr data-leave="${l.id}">
            <td>
              <div class="nm">
                <div class="av" style="background:${avColor(hashIdx(l.agent_name))};width:32px;height:32px;font-size:12px">${initials(l.agent_name)}</div>
                <div class="who"><div class="n">${escapeHtml(l.agent_name)}</div></div>
              </div>
            </td>
            <td>${escapeHtml(l.type)}<div class="muted" style="font-size:11.5px;font-weight:500">${l.days || 1} ${(l.days || 1) === 1 ? 'day' : 'days'}</div></td>
            <td>${escapeHtml(l.dates || fmtDateRange(l.start_date, l.end_date))}</td>
            <td class="muted" style="max-width:240px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(l.reason || '—')}</div></td>
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
  const csv = document.getElementById('lvCsv');
  if (csv) csv.addEventListener('click', exportLeaveCSV);
}

// ───── TEAM ──────────────────────────────────────────────────────────
function renderTeam() {
  const roster = state.data.roster || [];
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <button class="btn primary small" id="addStaffBtn">+ Add staff</button>
    </div>
    <div class="team-grid">
      ${roster.length === 0 ? `<div class="empty card" style="grid-column:1/-1">No staff yet — click <b>+ Add staff</b> to add your first.</div>` : ''}
      ${roster.map((s, i) => `<div class="card team-card" data-search="${escapeHtml(((s.name||'') + ' ' + (s.role||'') + ' ' + (s.id||'')).toLowerCase())}">
        <div class="top">
          <div class="av" style="background:${avColor(i)};width:46px;height:46px;font-size:17px">${initials(s.name)}</div>
          <div style="min-width:0">
            <div class="name">${escapeHtml(s.name)}${s.admin ? ' <span style="font-size:10px;background:var(--yellow);color:var(--ink);padding:2px 6px;border-radius:6px;vertical-align:middle">ADMIN</span>' : ''}</div>
            <div class="role">${escapeHtml(s.role || '')}</div>
          </div>
        </div>
        <div style="margin-top:14px">${tagFor(s.status)}</div>
        <div class="meta">
          <div class="li">${icon('users', 14, 'var(--muted)')}@${escapeHtml(s.id || '—')}</div>
          <div class="li">${icon('pin', 14, 'var(--muted)')}${escapeHtml(s.lastLoc || '—')}</div>
        </div>
      </div>`).join('')}
    </div>
    ${state.addStaff ? renderAddStaffModal() : ''}
  `;
}

function wireTeam() {
  const btn = document.getElementById('addStaffBtn');
  if (btn) btn.addEventListener('click', () => {
    state.addStaff = { name: '', id: '', role: '', team: '', pin: '', admin: false, error: '', busy: false };
    render();
  });
  if (state.addStaff) wireAddStaffModal();
}

function renderAddStaffModal() {
  const f = state.addStaff;
  const err = f.error || '';
  return `
    <div class="modal-back" id="staffBack"></div>
    <div class="modal" role="dialog">
      <div class="modal-head">
        <h3>Add a staff member</h3>
        <button class="modal-close" id="staffClose" aria-label="Close">${icon('x', 18, 'var(--muted)')}</button>
      </div>
      <div class="modal-body">
        <label class="field"><span>Name</span>
          <input id="sfName" type="text" value="${escapeHtml(f.name)}" placeholder="e.g. Thandi Mokoena" autofocus>
        </label>
        <label class="field"><span>Username</span>
          <input id="sfId" type="text" value="${escapeHtml(f.id)}" placeholder="auto from name — lowercase, no spaces" autocapitalize="off" autocomplete="off">
          <div class="hint">Used as the login id. Auto-generated from name; edit to override.</div>
        </label>
        <div class="field-row">
          <label class="field"><span>Role</span>
            <input id="sfRole" type="text" value="${escapeHtml(f.role)}" placeholder="Sales Agent">
          </label>
          <label class="field"><span>Team</span>
            <input id="sfTeam" type="text" value="${escapeHtml(f.team)}" placeholder="Sales">
          </label>
        </div>
        <label class="field"><span>PIN</span>
          <input id="sfPin" type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" value="${escapeHtml(f.pin)}" placeholder="4 digits — they'll use this to log in">
        </label>
        <label class="check">
          <input id="sfAdmin" type="checkbox" ${f.admin ? 'checked' : ''}>
          <span>Admin — can open this dashboard</span>
        </label>
        ${err ? `<div class="banner">${escapeHtml(err)}</div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn" id="staffCancel">Cancel</button>
        <button class="btn primary" id="staffSave" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Adding…' : 'Add staff'}</button>
      </div>
    </div>`;
}

function wireAddStaffModal() {
  const close = () => { state.addStaff = null; render(); };
  document.getElementById('staffBack').addEventListener('click', close);
  document.getElementById('staffClose').addEventListener('click', close);
  document.getElementById('staffCancel').addEventListener('click', close);

  const f = state.addStaff;
  const name = document.getElementById('sfName');
  const idIn = document.getElementById('sfId');
  const role = document.getElementById('sfRole');
  const team = document.getElementById('sfTeam');
  const pin  = document.getElementById('sfPin');
  const adm  = document.getElementById('sfAdmin');

  // Auto-slug the username from name UNTIL the user types in the id field.
  let idTouched = !!f.id;
  name.addEventListener('input', () => {
    f.name = name.value;
    if (!idTouched) {
      const slug = name.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      idIn.value = slug;
      f.id = slug;
    }
  });
  idIn.addEventListener('input', () => { idTouched = true; f.id = idIn.value; });
  role.addEventListener('input', () => { f.role = role.value; });
  team.addEventListener('input', () => { f.team = team.value; });
  pin.addEventListener('input', () => { f.pin = pin.value.replace(/[^0-9]/g, '').slice(0, 4); pin.value = f.pin; });
  adm.addEventListener('change', () => { f.admin = adm.checked; });

  document.getElementById('staffSave').addEventListener('click', submitAddStaff);
}

async function submitAddStaff() {
  const f = state.addStaff;
  if (!f) return;
  f.error = '';
  if (!f.name.trim()) { f.error = 'Name is required'; render(); return; }
  if (f.pin.length !== 4) { f.error = 'PIN must be 4 digits'; render(); return; }
  f.busy = true; render();
  try {
    await api('roster_add', {
      admin_pin: state.admin.pin,
      name: f.name.trim(),
      id: f.id.trim() || f.name,
      role: f.role.trim(),
      team: f.team.trim(),
      pin: f.pin,
      admin: !!f.admin,
    });
    state.addStaff = null;
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
  else if (state.view === 'leave') exportLeaveCSV();
}
function exportTeamCSV() {
  const team = state.data.team || [];
  const rows = [['Name','Role','Status','Clock-in','Location','Note','Hours today']];
  team.forEach(t => rows.push([t.name, t.role || '', statusLabel(t.status), t.cin || '', t.loc || '', t.note || '', fmtHM(t.todayHrs || 0)]));
  downloadCSV(`team-${new Date().toISOString().slice(0,10)}.csv`, rows);
}
function exportTimesheetsCSV() {
  // Exports the current Timesheets view (period-aware: week or month).
  const period = state.tsPeriod || 'this-week';
  const range = periodRange(period);
  const events = state.data.tsEvents || [];
  const roster = state.data.roster || [];
  const cols = range.kind === 'month' ? monthlyBuckets(range) : weeklyBuckets();
  const grid = {};
  roster.forEach(a => { grid[a.id] = { name: a.name, role: a.role, vals: cols.map(_ => 0) }; });
  events.forEach(e => {
    if (e.action !== 'out' || e.duration_hrs == null) return;
    const ts = new Date(e.ts).getTime();
    if (!grid[e.id]) grid[e.id] = { name: e.name, role: '', vals: cols.map(_ => 0) };
    const idx = cols.findIndex(c => ts >= c.from && ts <= c.to);
    if (idx >= 0) grid[e.id].vals[idx] += e.duration_hrs;
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

// ───── GATE (Admin PIN) ──────────────────────────────────────────────
function renderGate() {
  const dots = [0,1,2,3].map(i => `<div class="dot ${i < state.pinBuf.length ? 'filled' : ''}"></div>`).join('');
  return `<div class="gate">
    <div class="box ${state.pinErr ? 'pin-error' : ''}">
      <img src="../assets/quay1-logo-white.png" alt="Quay 1">
      <h2>Admin Dashboard</h2>
      <div class="sub">Enter your admin PIN</div>
      <div class="dots">${dots}</div>
      <div class="err">${state.error ? escapeHtml(state.error) : ''}</div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-d="${n}">${n}</button>`).join('')}
        <button class="key alt" data-back>← Back</button>
        <button class="key" data-d="0">0</button>
        <button class="key alt" data-clear>Clear</button>
      </div>
      <div class="foot">Roster row needs <b>admin = true</b> to unlock this view.</div>
    </div>
  </div>`;
}
function wireGate() {
  document.querySelectorAll('.gate .key[data-d]').forEach(b => b.addEventListener('click', () => {
    if (state.pinBuf.length >= 4) return;
    state.pinBuf += b.dataset.d; state.pinErr = false; state.error = null; render();
    if (state.pinBuf.length === 4) submitAdminPin();
  }));
  const back = document.querySelector('.gate .key[data-back]');
  if (back) back.addEventListener('click', () => { state.pinBuf = state.pinBuf.slice(0, -1); render(); });
  const clr = document.querySelector('.gate .key[data-clear]');
  if (clr) clr.addEventListener('click', () => { state.pinBuf = ''; state.error = null; render(); });
}
async function submitAdminPin() {
  try {
    const data = await api('admin_check', { pin: state.pinBuf });
    state.admin = { ...data.admin, pin: state.pinBuf };
    writeSession(state.admin);
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

// auto-refresh every 60s when signed in
setInterval(() => { if (state.admin && document.visibilityState === 'visible') loadAll(); }, 60000);

})();
