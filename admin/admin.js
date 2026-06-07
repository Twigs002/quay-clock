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
    locations: null,     // [{ name, address, lat, lng, radius_m }]
    weekEvents: null,    // weekly events for timesheet view
    roster: null,        // for staff directory + counts
  },
};

const $root = document.getElementById('admin');

// ───── BOOT ──────────────────────────────────────────────────────────
function boot() {
  const stored = readSession();
  if (stored && stored.id && stored.pin) {
    state.admin = stored;
    loadAll();
  }
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
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
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
    const [team, summary, leave, locs, roster, events] = await Promise.all([
      api('team_today', {}),
      api('summary', { from, to }),
      api('leave_list', {}),
      api('locations', {}),
      api('roster', {}),
      api('events', { from, to }),
    ]);
    state.data.team = team.team || [];
    state.data.summary = summary.summary || [];
    state.data.leave = (leave.leave || []).map(l => ({ ...l, dates: fmtDateRange(l.start_date, l.end_date) }));
    state.data.locations = locs.locations || [];
    state.data.roster = roster.roster || [];
    state.data.weekEvents = events.events || [];
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false; render();
  }
}

// ───── RENDER ────────────────────────────────────────────────────────
function render() {
  if (!state.admin) { $root.innerHTML = renderGate(); wireGate(); return; }
  $root.innerHTML = `<div class="app">
    ${renderSidebar()}
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
    ['leave','calendar','Leave'],
    ['team','users','Team'],
    ['locations','map','Locations'],
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

// ── Topbar ───────────────────────────────────────────────────────────
const TITLES = {
  dashboard:  ['Dashboard',  'Live overview of your team today'],
  timesheets: ['Timesheets', 'Review & approve hours'],
  leave:      ['Leave',      'Requests & approvals'],
  team:       ['Team',       'Staff directory & status'],
  locations:  ['Locations',  'Office geofences'],
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
  // view-specific wiring
  if (state.view === 'dashboard') wireDashboard();
  if (state.view === 'leave')     wireLeave();
  if (state.view === 'timesheets') wireTimesheets();
}

function renderView() {
  switch (state.view) {
    case 'dashboard':  return renderDashboard();
    case 'timesheets': return renderTimesheets();
    case 'leave':      return renderLeave();
    case 'team':       return renderTeam();
    case 'locations':  return renderLocations();
    default:           return '';
  }
}

// ───── DASHBOARD ─────────────────────────────────────────────────────
function renderDashboard() {
  const team = state.data.team || [];
  const onNow = team.filter(s => s.status === 'in').length;
  const onBreak = 0; // not tracked yet
  const onLeave = (state.data.leave || []).filter(l =>
    l.status === 'Approved' && isToday(l.start_date, l.end_date)
  );
  const hoursToday = team.reduce((s, t) => s + (t.todayHrs || 0), 0);
  const pending = (state.data.leave || []).filter(l => l.status === 'Pending');

  return `
    <div class="stat-row">
      ${statCard('clock', 'var(--green)', 'var(--greenBg)', 'On the clock', String(onNow), `of ${team.length} staff`)}
      ${statCard('coffee', 'var(--amber)', 'var(--amberBg)', 'On break', String(onBreak), '—')}
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
            ${team.map((s, i) => `<tr class="${(s.status === 'off' || s.status === 'leave') ? 'dim' : ''}">
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
  const sow = startOfWeek(new Date());
  const week = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const events = state.data.weekEvents || [];
  const roster = state.data.roster || [];
  // build per-agent per-day hours
  const grid = {};
  roster.forEach(a => { grid[a.id] = { name: a.name, role: a.role, days: [0,0,0,0,0,0,0], total: 0 }; });
  events.forEach(e => {
    if (e.action !== 'out' || e.duration_hrs == null) return;
    const d = new Date(e.ts);
    const idx = (d.getDay() + 6) % 7;
    if (!grid[e.id]) grid[e.id] = { name: e.name, role: '', days: [0,0,0,0,0,0,0], total: 0 };
    grid[e.id].days[idx] += e.duration_hrs;
    grid[e.id].total += e.duration_hrs;
  });
  const rows = Object.entries(grid)
    .filter(([, v]) => v.total > 0 || roster.some(a => a.name === v.name))
    .sort((a, b) => b[1].total - a[1].total);

  return `<div class="card" style="overflow:hidden">
    <div class="card-head">
      <div style="display:flex;align-items:center;gap:12px">
        <h3>Week of ${weekLabel(sow)}</h3>
      </div>
      <button class="btn small" id="tsCsv">${icon('download', 15)} Export CSV</button>
    </div>
    <table>
      <thead><tr>
        <th>Employee</th>
        ${week.map(d => `<th class="ctr">${d}</th>`).join('')}
        <th class="ctr">Total</th>
      </tr></thead>
      <tbody>
        ${rows.length === 0 ? `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">No clock-in data this week yet.</td></tr>` : ''}
        ${rows.map(([id, v], i) => `<tr>
          <td>
            <div class="nm">
              <div class="av" style="background:${avColor(i)};width:32px;height:32px;font-size:12px">${initials(v.name)}</div>
              <div class="who"><div class="n">${escapeHtml(v.name)}</div><div class="r">${escapeHtml(v.role || '')}</div></div>
            </div>
          </td>
          ${v.days.map(h => `<td class="ctr tnum" style="${h ? '' : 'color:var(--muted)'}">${fmtHM(h)}</td>`).join('')}
          <td class="ctr tnum" style="color:var(--blue);font-weight:800">${fmtHM(v.total)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}
function wireTimesheets() {
  const csv = document.getElementById('tsCsv');
  if (csv) csv.addEventListener('click', exportTimesheetsCSV);
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
  return `<div class="team-grid">
    ${roster.length === 0 ? `<div class="empty card" style="grid-column:1/-1">No staff in the Roster tab yet.</div>` : ''}
    ${roster.map((s, i) => `<div class="card team-card">
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
  </div>`;
}

// ───── LOCATIONS ─────────────────────────────────────────────────────
function renderLocations() {
  const locs = state.data.locations || [];
  const team = state.data.team || [];
  return `<div class="loc-grid">
    ${locs.map(s => {
      const here = team.filter(t => t.status === 'in' && (t.loc || '').toLowerCase() === s.name.toLowerCase()).length;
      return `<div class="card loc-card">
        <div class="loc-map">
          <div class="pin"><div class="outer"><div class="inner">${icon('pin', 17, '#fff')}</div></div></div>
          <span class="here">${here} on site</span>
        </div>
        <div class="loc-info">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="addr">${escapeHtml(s.address || '')}</div>
          <div class="geo">${icon('map', 15, 'var(--blue)')} Geofence radius · ${s.radius_m ? s.radius_m + ' m' : '—'}</div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ───── EXPORTS ───────────────────────────────────────────────────────
function exportCurrent() {
  if (state.view === 'dashboard' || state.view === 'team') exportTeamCSV();
  else if (state.view === 'timesheets') exportTimesheetsCSV();
  else if (state.view === 'leave') exportLeaveCSV();
  else if (state.view === 'locations') exportLocationsCSV();
}
function exportTeamCSV() {
  const team = state.data.team || [];
  const rows = [['Name','Role','Status','Clock-in','Location','Note','Hours today']];
  team.forEach(t => rows.push([t.name, t.role || '', statusLabel(t.status), t.cin || '', t.loc || '', t.note || '', fmtHM(t.todayHrs || 0)]));
  downloadCSV(`team-${new Date().toISOString().slice(0,10)}.csv`, rows);
}
function exportTimesheetsCSV() {
  const events = state.data.weekEvents || [];
  const roster = state.data.roster || [];
  const grid = {};
  roster.forEach(a => { grid[a.id] = { id: a.id, name: a.name, role: a.role, days: [0,0,0,0,0,0,0] }; });
  events.forEach(e => {
    if (e.action !== 'out' || e.duration_hrs == null) return;
    const idx = (new Date(e.ts).getDay() + 6) % 7;
    if (!grid[e.id]) grid[e.id] = { id: e.id, name: e.name, role: '', days: [0,0,0,0,0,0,0] };
    grid[e.id].days[idx] += e.duration_hrs;
  });
  const sow = startOfWeek(new Date());
  const dates = [...Array(7)].map((_, i) => {
    const d = new Date(sow); d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const rows = [['Employee', 'Role', ...dates, 'Total']];
  Object.values(grid).forEach(v => {
    const total = v.days.reduce((s, h) => s + h, 0);
    rows.push([v.name, v.role || '', ...v.days.map(h => h.toFixed(2)), total.toFixed(2)]);
  });
  downloadCSV(`timesheets-week-${sow.toISOString().slice(0,10)}.csv`, rows);
}
function exportLeaveCSV() {
  const leave = state.data.leave || [];
  const rows = [['ID', 'Submitted', 'Employee', 'Type', 'Start', 'End', 'Days', 'Status', 'Decided by', 'Reason']];
  leave.forEach(l => rows.push([l.id, l.ts, l.agent_name, l.type, l.start_date, l.end_date, l.days, l.status, l.decided_by, l.reason]));
  downloadCSV(`leave-${new Date().toISOString().slice(0,10)}.csv`, rows);
}
function exportLocationsCSV() {
  const locs = state.data.locations || [];
  const rows = [['Name', 'Address', 'Lat', 'Lng', 'Radius (m)']];
  locs.forEach(l => rows.push([l.name, l.address, l.lat, l.lng, l.radius_m]));
  downloadCSV(`locations.csv`, rows);
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
