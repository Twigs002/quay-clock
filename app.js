/* Quay 1 — Signal-language PWA · vanilla JS, no build step
 * ----------------------------------------------------------------------
 * Per-user app: log in once with your PIN, stay signed in.
 * Tabs: Home · Timesheet · Requests · Team.
 * Backend: see apps_script/Code.gs (v2).
 */
(function () {
'use strict';

// ───── CONFIG ────────────────────────────────────────────────────────
const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbw3g6cdmfIbWC6TVSybVk5CECKhnSBneDuWGzM4krxcTFgOhS7Ef4InD6F1x9llnl27AA/exec';
const LS_KEY = 'quay_clock_agent_v2';
// Location was removed from the app on user request — no longer recorded.

// ───── STATE ─────────────────────────────────────────────────────────
const state = {
  agent: null,           // { id, name, role, team, admin }
  tab: 'home',
  loading: false,
  error: null,
  loginUser: (typeof localStorage !== 'undefined' && localStorage.getItem('quay_last_user')) || '',
  pinBuf: '',
  pinErr: false,
  // tab data caches
  home: null,            // { status, lastIn, lastNote, todayHrs, weekHrs, weekTarget }
  timesheet: null,       // { weekBars, entries, totalHrs, target }
  leave: null,           // { balances, requests }
  team: null,            // [ { id, name, role, status, cin, loc, note } ]
  // UI flags
  sheet: null,           // { type: 'note' | 'request', ... }
  toast: null,
};

// ───── BOOT ──────────────────────────────────────────────────────────
const $app = document.getElementById('app');

async function boot() {
  // Recover the supabase session first, then resolve our staff row.
  try {
    const staff = window.QD ? await window.QD.loadSelfStaff() : null;
    if (staff && staff.active !== false) {
      state.agent = { id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '', admin: !!staff.is_admin };
      writeStored(state.agent);
      state.tab = (location.hash || '#home').slice(1) || 'home';
      loadTab(state.tab);
    } else {
      const stored = readStored();
      if (stored && stored.id) writeStored(null);
    }
  } catch (e) {
    // Network/auth hiccup — fall through to login screen.
  }
  render();
  window.addEventListener('hashchange', () => {
    const t = (location.hash || '#home').slice(1) || 'home';
    if (t !== state.tab && state.agent) { state.tab = t; loadTab(t); render(); }
  });
}

function readStored() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
  catch { return null; }
}
function writeStored(v) {
  if (v) localStorage.setItem(LS_KEY, JSON.stringify(v));
  else localStorage.removeItem(LS_KEY);
}

// ───── API ───────────────────────────────────────────────────────────
// Backed by Supabase via QD (window.QD). Returns the same {ok, ...} shape
// the older Apps Script handlers used to, so call sites are unchanged.
async function api(action, payload = {}) {
  if (!window.QD) throw new Error('Data layer not ready');
  const data = await window.QD.call(action, payload);
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

// ───── HELPERS ───────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtDate(d) {
  return d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
}
function fmtHM(hrs) {
  if (hrs == null || isNaN(hrs)) return '0:00';
  const total = Math.max(0, Math.round(hrs * 60));
  return Math.floor(total / 60) + ':' + pad(total % 60);
}
function fmtHMShort(hrs) {
  const total = Math.max(0, Math.round((hrs || 0) * 60));
  return Math.floor(total / 60) + 'h ' + pad(total % 60) + 'm';
}
function fmtElapsed(startIso) {
  if (!startIso) return '0:00:00';
  const s = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
  return Math.floor(s/3600) + ':' + pad(Math.floor((s%3600)/60)) + ':' + pad(s%60);
}
function initials(name) {
  return (name || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
const AV_COLORS = ['#3D5BA6','#D20A03','#1FA463','#7A5AB6','#E7B000','#2F8FB3'];
const avColor = (i) => AV_COLORS[(i || 0) % AV_COLORS.length];

function startOfWeek(d) {
  const x = new Date(d); const day = (x.getDay() + 6) % 7;
  x.setHours(0,0,0,0); x.setDate(x.getDate() - day); return x;
}
function endOfWeek(d) {
  const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate() + 6); e.setHours(23,59,59,999); return e;
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
function showToast(msg) {
  state.toast = msg;
  render();
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { state.toast = null; render(); }, 2400);
}

// ───── ICONS ────────────────────────────────────────────────────────
const ICON = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  calendar: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9h17M8 3v3M16 3v3"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="3"/><path d="M9 4.5a3 3 0 0 1 6 0M9 11h6M9 15h4"/>',
  users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 7.5a3 3 0 0 1 0 5.8M16.5 19a5.4 5.4 0 0 0-1.3-3.5"/>',
  home: '<path d="M4 11l8-6 8 6M6 10v9h12v-9"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  logout: '<path d="M14 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M10 12h10m0 0-3-3m3 3-3 3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 19.5h15"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
function icon(name, size = 22, stroke = 'currentColor', sw = 1.8) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="display:block">${ICON[name] || ''}</svg>`;
}

// ───── DATA LOADERS ──────────────────────────────────────────────────
async function loadTab(tab) {
  if (!state.agent) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    if (tab === 'home')      await loadHome();
    if (tab === 'timesheet') await loadTimesheet();
    if (tab === 'leave')     await loadLeave();
    if (tab === 'team')      await loadTeam();
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function loadHome() {
  const data = await api('me', { agent_id: state.agent.id });
  state.home = {
    status: data.status,
    lastIn: data.lastIn, lastOut: data.lastOut,
    lastNote: data.lastNote,
    todayHrs: data.todayHrs || 0,
    weekHrs: data.weekHrs || 0,
    weekTarget: data.weekTarget || 40,
  };
}
async function loadTimesheet() {
  const now = new Date();
  const from = startOfWeek(now).toISOString();
  const to   = endOfWeek(now).toISOString();
  const data = await api('events', { agent_id: state.agent.id, from, to });
  state.timesheet = buildTimesheet(data.events, now);
}
async function loadLeave() {
  // "leave" name kept for state continuity; this tab is now Requests
  // (shift-time corrections only — no annual/sick/family leave).
  const data = await api('leave_list', { agent_id: state.agent.id });
  state.leave = { requests: data.leave || [] };
}
async function loadTeam() {
  const data = await api('team_today', {});
  state.team = data.team || [];
}

function buildTimesheet(events, now) {
  // Pair in/out within the week (Mon-Sun). Hours are attributed to the
  // day the shift ENDED (so a 23:30→02:00 shift counts on the OUT day),
  // matching how Apps Script computes duration_hrs at clock-out time.
  const sow = startOfWeek(now);
  const entries = [];
  const byDay = [0,0,0,0,0,0,0]; // Mon..Sun
  let openIn = null;
  const sorted = events.slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  sorted.forEach(e => {
    if (e.action === 'in') { openIn = e; return; }
    if (e.action !== 'out') return;
    const outDate = new Date(e.ts);
    const inDate = openIn ? new Date(openIn.ts) : null;
    const hrs = (e.duration_hrs != null && !isNaN(e.duration_hrs))
      ? Number(e.duration_hrs)
      : (inDate ? (outDate - inDate) / 3.6e6 : 0);
    const refDate = inDate || outDate;
    // Attribute to OUT day so the bar chart reflects when the work finished.
    const outIdx = (outDate.getDay() + 6) % 7;
    if (outIdx >= 0 && outIdx < 7 && hrs > 0) byDay[outIdx] += hrs;
    entries.push({
      sortAt: refDate.getTime(),
      day: refDate.toLocaleDateString('en-GB', { weekday: 'short' }),
      date: refDate.getDate(),
      monthShort: refDate.toLocaleDateString('en-GB', { month: 'short' }),
      tin: openIn ? fmtTime(openIn.ts) : '—',
      tout: fmtTime(e.ts),
      hrs: fmtHM(hrs),
      hrsNum: hrs,
      note: openIn ? (openIn.note || '') : (e.note || ''),
      live: false,
    });
    openIn = null;
  });
  // If there's an open clock-in (still on the clock), add it as live.
  if (openIn) {
    const inDate = new Date(openIn.ts);
    const dayIdx = (inDate.getDay() + 6) % 7;
    const hrs = (Date.now() - inDate.getTime()) / 3.6e6;
    if (dayIdx >= 0 && dayIdx < 7) byDay[dayIdx] += hrs;
    entries.unshift({
      sortAt: inDate.getTime() + 1e13, // pin live row to top
      day: inDate.toLocaleDateString('en-GB', { weekday: 'short' }),
      date: inDate.getDate(),
      monthShort: inDate.toLocaleDateString('en-GB', { month: 'short' }),
      tin: fmtTime(openIn.ts),
      tout: '—',
      hrs: fmtHM(hrs),
      hrsNum: hrs,
      note: openIn.note || '',
      live: true,
    });
  }
  entries.sort((a, b) => b.sortAt - a.sortAt); // newest first; handles month boundaries
  const total = byDay.reduce((s,v) => s+v, 0);
  const max = Math.max(8, ...byDay);
  const todayIdx = (now.getDay() + 6) % 7;
  const weekBars = ['M','T','W','T','F','S','S'].map((l, i) => ({
    l, v: Math.max(0, byDay[i] / max), today: i === todayIdx,
  }));
  return {
    weekBars, entries,
    totalHrs: total,
    target: 40,
    weekStart: sow,
  };
}


// ───── RENDER ────────────────────────────────────────────────────────
function render() {
  if (!state.agent) {
    $app.innerHTML = renderLogin();
    wireLogin();
    return;
  }
  let body;
  if (state.tab === 'home')      body = renderHome();
  else if (state.tab === 'timesheet') body = renderTimesheet();
  else if (state.tab === 'leave')     body = renderLeave();
  else if (state.tab === 'team')      body = renderTeam();
  else body = '<div class="loading">…</div>';

  let extra = '';
  if (state.sheet) extra += renderSheet();
  if (state.toast) extra += `<div class="toast">${escapeHtml(state.toast)}</div>`;

  $app.innerHTML = `<div class="shell">${body}${renderTabBar()}</div>${extra}`;
  wireTabs();
  if (state.tab === 'home') wireHome();
  if (state.tab === 'timesheet') wireTimesheet();
  if (state.tab === 'leave') wireLeave();
  if (state.tab === 'team') wireTeam();
  if (state.sheet) wireSheet();
}

function renderTabBar() {
  const tabs = [
    ['home','Home','home'],
    ['timesheet','Timesheet','clipboard'],
    ['leave','Requests','calendar'],
    ['team','Team','users'],
  ];
  return `<div class="tabbar">
    ${tabs.map(([k, label, ic]) => `
      <button class="tab ${k === state.tab ? 'on' : ''}" data-tab="${k}">
        ${icon(ic, 23, 'currentColor', k === state.tab ? 2.1 : 1.8)}
        <span>${label}</span>
      </button>
    `).join('')}
  </div>`;
}
function wireTabs() {
  document.querySelectorAll('.tabbar .tab').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tab;
    location.hash = '#' + t;
  }));
}

// ───── LOGIN ─────────────────────────────────────────────────────────
function renderLogin() {
  const dots = [0,1,2,3].map(i =>
    `<div class="pin-dot ${i < state.pinBuf.length ? 'filled' : ''}"></div>`).join('');
  return `<div class="login ${state.pinErr ? 'pin-error' : ''}">
    <div class="top">
      <img src="assets/quay1-logo-white.png" alt="Quay 1">
      <div class="tag">clock-in &amp; time tracking</div>
    </div>
    <div class="pin-area">
      <h2>Sign in</h2>
      <input id="loginUser" class="login-user" type="text" autocomplete="username"
             inputmode="text" autocapitalize="none" autocorrect="off"
             placeholder="username (e.g. thandi)" value="${escapeHtml(state.loginUser || '')}">
      <div style="text-align:center;color:rgba(255,255,255,0.85);font-size:13px;font-weight:600;margin:4px 0 6px">PIN</div>
      <div class="pin-dots">${dots}</div>
      <div class="err">${state.error ? escapeHtml(state.error) : ''}</div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-d="${n}">${n}</button>`).join('')}
        <button class="key alt" data-back>← Back</button>
        <button class="key" data-d="0">0</button>
        <button class="key alt" data-clear>Clear</button>
      </div>
    </div>
    <div class="foot">Quay 1 International Realty</div>
  </div>`;
}
function wireLogin() {
  const u = document.getElementById('loginUser');
  if (u) u.addEventListener('input', () => { state.loginUser = u.value; }); // silent — no rerender
  document.querySelectorAll('.key[data-d]').forEach(b => b.addEventListener('click', () => {
    if (state.pinBuf.length >= 4) return;
    state.pinBuf += b.dataset.d; state.pinErr = false; state.error = null;
    render();
    if (state.pinBuf.length === 4) submitPin();
  }));
  const back = document.querySelector('.key[data-back]');
  if (back) back.addEventListener('click', () => {
    state.pinBuf = state.pinBuf.slice(0, -1); render();
  });
  const clr = document.querySelector('.key[data-clear]');
  if (clr) clr.addEventListener('click', () => { state.pinBuf = ''; state.error = null; render(); });
}
async function submitPin() {
  // Pick up the latest username typed into the input (may not have triggered a render).
  const u = document.getElementById('loginUser');
  if (u) state.loginUser = u.value;
  const username = String(state.loginUser || '').trim().toLowerCase();
  if (!username) {
    state.pinErr = true; state.error = 'Enter your username first'; state.pinBuf = '';
    setTimeout(() => { state.pinErr = false; render(); }, 600); render(); return;
  }
  try {
    const data = await api('login', { username, pin: state.pinBuf });
    state.agent = data.agent;
    writeStored(state.agent);
    try { localStorage.setItem('quay_last_user', username); } catch {}
    state.pinBuf = ''; state.error = null;
    state.tab = 'home'; location.hash = '#home';
    await loadHome();
    render();
  } catch (e) {
    state.pinErr = true;
    state.error = String(e.message || e);
    state.pinBuf = '';
    setTimeout(() => { state.pinErr = false; render(); }, 600);
    render();
  }
}

// ───── HEADER (Signal) ───────────────────────────────────────────────
function renderHeader({ centerLogo, title, sub, greet, date, action } = {}) {
  const top = centerLogo
    ? `<div class="hdr-top">
         <div style="width:22px"></div>
         <div class="hdr-logo-center"><img src="assets/quay1-logo-white.png" alt="Quay 1"></div>
         <div class="bell">${icon('bell', 22, 'rgba(255,255,255,0.9)')}<span class="dot"></span></div>
       </div>`
    : `<div class="hdr-top">
         <img class="hdr-logo" src="assets/quay1-logo-white.png" alt="Quay 1">
         ${action || `<div class="bell">${icon('bell', 22, 'rgba(255,255,255,0.9)')}<span class="dot"></span></div>`}
       </div>`;
  let body = '';
  if (greet) body = `<div class="hdr-date">${escapeHtml(date)}</div><div class="hdr-greet">${escapeHtml(greet)}</div>`;
  else if (title) body = `<div class="hdr-title">${escapeHtml(title)}</div>${sub ? `<div class="hdr-sub">${escapeHtml(sub)}</div>` : ''}`;
  return `<div class="hdr">${top}${body}</div>`;
}

// ───── HOME ──────────────────────────────────────────────────────────
function renderHome() {
  const h = state.home || {};
  const now = new Date();
  const greet = greetingFor(now) + ', ' + firstName(state.agent.name);
  const on = h.status === 'in';
  const elapsed = on ? fmtElapsed(h.lastIn) : '0:00:00';
  const todayDisplay = on ? elapsed.slice(0, elapsed.lastIndexOf(':')) : fmtHM(h.todayHrs);
  const weekDisplay = fmtHM(h.weekHrs);
  const weekPct = Math.min(1, (h.weekHrs || 0) / (h.weekTarget || 40));
  const ring = on
    ? `<circle cx="104" cy="104" r="98" fill="none" stroke="var(--yellow)" stroke-width="8" stroke-linecap="round" stroke-dasharray="615" stroke-dashoffset="430" transform="rotate(-90 104 104)"/>`
    : '';

  const header = renderHeader({ centerLogo: true, greet, date: fmtDate(now) });
  return `${header}
    <div class="content">
      ${state.error ? `<div class="banner">${escapeHtml(state.error)}</div>` : ''}
      <div class="card-big pad-lg home-card">
        <div class="pill ${on ? 'pill-status-in' : 'pill-status-out'}"><span class="dot"></span>${on ? 'On the clock' : 'Clocked out'}</div>
        <div class="dial">
          <svg width="208" height="208" viewBox="0 0 208 208">
            <circle cx="104" cy="104" r="98" fill="none" stroke="var(--line)" stroke-width="8"/>
            ${ring}
          </svg>
          <button class="dial-btn ${on ? 'on' : ''}" id="dialBtn">
            ${icon(on ? 'logout' : 'clock', 38, on ? 'var(--red)' : 'var(--ink)', 2)}
            <span class="lbl">${on ? 'CLOCK OUT' : 'CLOCK IN'}</span>
            ${on ? `<span class="elapsed tnum">${elapsed}</span>` : ''}
          </button>
        </div>
        ${on && h.lastNote ? `<div class="note-bubble">
            ${icon('clipboard', 17, 'var(--blue)')}
            <span>${escapeHtml(h.lastNote)}</span>
          </div>` : ''}
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-lbl">Today</div>
          <div class="stat-val"><span class="v">${todayDisplay}</span><span class="u">hrs</span></div>
        </div>
        <div class="stat">
          <div class="stat-lbl">This week</div>
          <div class="stat-val"><span class="v">${weekDisplay}</span><span class="u">of ${h.weekTarget || 40}h</span></div>
          <div class="stat-bar"><div style="width:${(weekPct * 100).toFixed(0)}%"></div></div>
        </div>
      </div>
    </div>
  `;
}

function wireHome() {
  const btn = document.getElementById('dialBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!state.home) return;
    if (state.home.status === 'in') {
      // LN + Assistant must fill the end-of-day report before clocking
      // out — the form clocks them out itself on submit.
      const d = String((state.agent && state.agent.designation) || '').toLowerCase();
      if (d === 'ln' || d === 'assistant') {
        openClockOutReport();
      } else {
        submitClock('out');
      }
    } else {
      openNoteSheet();
    }
  });
}

function greetingFor(d) {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function firstName(n) { return String(n || '').split(/\s+/)[0]; }

function openNoteSheet() {
  state.sheet = { type: 'note', value: '' };
  render();
}

async function submitClock(action) {
  const note = state.sheet && state.sheet.value ? state.sheet.value.trim() : (state.home && state.home.lastNote) || '';
  // Mark sheet busy; update CTA in place so we don't lose textarea focus mid-flow.
  if (state.sheet) {
    state.sheet.busy = true;
    state.sheet.error = '';
    const go = document.getElementById('sheetGo');
    if (go) { go.classList.add('disabled'); go.classList.remove('ok'); go.innerHTML = 'Clocking in…'; }
    const eb = document.getElementById('sheetErr');
    if (eb) { eb.style.display = 'none'; eb.textContent = ''; }
  }
  try {
    await api('clock', {
      agent_id: state.agent.id,
      // Use `dir` so the inner field doesn't clobber the outer `action`
      // (which is the dispatcher key on the Apps Script side).
      dir: action,
      note: action === 'in' ? note : '',
    });
    state.sheet = null;
    showToast(action === 'in' ? 'Clocked in ✓' : 'Clocked out ✓');
    await loadHome();
    render();
  } catch (e) {
    const msg = String(e.message || e);
    if (state.sheet) {
      state.sheet.busy = false;
      state.sheet.error = msg;
      const eb = document.getElementById('sheetErr');
      const go = document.getElementById('sheetGo');
      if (eb) { eb.textContent = msg; eb.style.display = 'block'; }
      const ok = note.length > 0;
      if (go) {
        go.classList.toggle('ok', ok);
        go.classList.toggle('disabled', !ok);
        go.innerHTML = ok ? 'CONFIRM &amp; CLOCK IN' : 'Add a note to continue';
      }
    } else {
      state.error = msg;
      render();
    }
  }
}

// ───── CLOCK-OUT REPORT SHEET (LN / Assistant) ──────────────────────
// End-of-day capture form. Submitting writes a clock_out_reports row
// AND clocks the user out atomically — closing the modal without
// submitting just leaves them clocked in.
function openClockOutReport() {
  state.sheet = {
    type: 'report',
    busy: false,
    error: '',
    values: {
      division: (state.agent && state.agent.division) || '',
      hs_tasks_completed: '', hs_calls_made: '', hs_emails_sent: '',
      hs_whatsapps_sent: '', hs_answered_contacts: '',
      hs_leads_vals: '', hs_reconverted_leads: '',
      df_calls: '', df_email_successes: '', df_leads_vals: '', df_hours: '',
      wa_sent: '', wa_responses: '', wa_leads_vals: '',
      notes: '',
    },
  };
  render();
}

function renderReportSheet() {
  const v = state.sheet.values;
  const err = state.sheet.error || '';
  const busy = state.sheet.busy || false;
  const num = (key, label, emoji) => `
    <label class="rep-field">
      <span class="rep-label">${emoji} ${label}</span>
      <input class="rep-input tnum" type="number" min="0" inputmode="numeric"
             data-rep-key="${key}" value="${v[key]}" placeholder="0">
    </label>`;
  // Currently divisions are free-text against the staff.division field;
  // until we wire a config-driven picker we offer the most common
  // examples + the agent's current value as a datalist.
  const knownDivisions = ['Engine Room', 'RM', 'Fancy', 'Inbound', 'Outbound'];
  const divisionOptions = knownDivisions
    .map(d => `<option value="${escapeHtml(d)}"></option>`).join('');
  return `<div class="sheet-wrap" id="sheetWrap">
    <div class="sheet-back" id="sheetBack"></div>
    <div class="sheet sheet-report" role="dialog">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <h3>End-of-day Report</h3>
        <button class="sheet-close" id="sheetClose">${icon('x', 20, 'var(--muted)')}</button>
      </div>
      <div class="sheet-sub">
        <div>👤 <b>${escapeHtml(state.agent.name)}</b></div>
        <div class="rep-division-row">
          <label class="rep-label" for="repDivision">🏷️ Division</label>
          <input id="repDivision" class="rep-input" list="repDivisionList"
                 value="${escapeHtml(v.division)}" placeholder="Division">
          <datalist id="repDivisionList">${divisionOptions}</datalist>
        </div>
      </div>
      <div class="sheet-body" style="overflow-y:auto;max-height:60vh">
        <div class="rep-section-head">📊 HubSpot Work Summary</div>
        <div class="rep-grid">
          ${num('hs_tasks_completed',  'Tasks Completed',     '📋')}
          ${num('hs_calls_made',       'Calls Made',          '📞')}
          ${num('hs_emails_sent',      'Emails Sent',         '💻')}
          ${num('hs_whatsapps_sent',   "WhatsApp's sent",     '📲')}
          ${num('hs_answered_contacts','Answered Contacts',   '✅')}
          ${num('hs_leads_vals',       'Leads/Vals',          '🎯')}
          ${num('hs_reconverted_leads','Reconverted Leads',   '♻️')}
        </div>

        <div class="rep-section-head">☎️🔥 DialFire Canvassing</div>
        <div class="rep-grid">
          ${num('df_calls',            'Calls',               '📞')}
          ${num('df_email_successes',  'Email Successes',     '📧')}
          ${num('df_leads_vals',       'Leads/Vals',          '🏡')}
          ${num('df_hours',            'Hours',               '⏰')}
        </div>

        <div class="rep-section-head">📲 WhatsApp Campaigns</div>
        <div class="rep-grid">
          ${num('wa_sent',             "WhatsApps sent",      '🤳')}
          ${num('wa_responses',        'Responses',           '▶️')}
          ${num('wa_leads_vals',       'Leads/Vals',          '🎯')}
        </div>

        <div class="rep-section-head">🔷📈 Additional Admin / Notes</div>
        <label class="rep-field rep-field-wide">
          <textarea id="repNotes" class="rep-input" rows="3"
                    placeholder="P24 listings, email campaigns, vals, etc.">${escapeHtml(v.notes)}</textarea>
        </label>

        ${err ? `<div class="banner" id="sheetErr" style="display:block">${escapeHtml(err)}</div>` : ''}
      </div>
      <div class="sheet-cta">
        <button class="sheet-go ok ${busy ? 'disabled' : ''}" id="sheetGo">
          ${busy ? 'Submitting…' : 'Submit &amp; Clock out'}
        </button>
      </div>
    </div>
  </div>`;
}

function wireReportSheet() {
  const close = () => { state.sheet = null; render(); };
  document.getElementById('sheetBack').addEventListener('click', close);
  document.getElementById('sheetClose').addEventListener('click', close);
  // Bind inputs back to state so re-renders preserve typed values.
  document.querySelectorAll('[data-rep-key]').forEach(el => {
    el.addEventListener('input', e => {
      state.sheet.values[el.dataset.repKey] = e.target.value;
    });
  });
  const div = document.getElementById('repDivision');
  if (div) div.addEventListener('input', e => { state.sheet.values.division = e.target.value; });
  const nt = document.getElementById('repNotes');
  if (nt) nt.addEventListener('input', e => { state.sheet.values.notes = e.target.value; });
  const go = document.getElementById('sheetGo');
  if (go) go.addEventListener('click', () => submitClockOutReport());
}

async function submitClockOutReport() {
  if (!state.sheet || state.sheet.busy) return;
  // Validate: every numeric must be a non-negative integer (0 OK).
  const v = state.sheet.values;
  const numericKeys = [
    'hs_tasks_completed','hs_calls_made','hs_emails_sent','hs_whatsapps_sent',
    'hs_answered_contacts','hs_leads_vals','hs_reconverted_leads',
    'df_calls','df_email_successes','df_leads_vals','df_hours',
    'wa_sent','wa_responses','wa_leads_vals',
  ];
  const missing = numericKeys.filter(k => v[k] === '' || v[k] == null);
  if (missing.length) {
    state.sheet.error = 'Every count is required (0 is fine). Missing: ' + missing.length + ' field' + (missing.length === 1 ? '' : 's') + '.';
    render();
    return;
  }
  if (!v.division.trim()) {
    state.sheet.error = 'Pick a division before submitting.';
    render();
    return;
  }
  state.sheet.busy = true; state.sheet.error = ''; render();
  try {
    const res = await api('clock_out_report_submit', v);
    if (!res || res.ok === false) throw new Error(res && res.error || 'Submit failed');
    // Now actually clock out (re-use the existing path so events log + home reloads).
    state.sheet = null;
    await submitClock('out');
  } catch (e) {
    state.sheet.busy = false;
    state.sheet.error = String(e.message || e);
    render();
  }
}

// ───── NOTE SHEET (and LEAVE SHEET) ─────────────────────────────────
function renderSheet() {
  if (!state.sheet) return '';
  if (state.sheet.type === 'note') return renderNoteSheet();
  if (state.sheet.type === 'request') return renderLeaveSheet();
  if (state.sheet.type === 'report')  return renderReportSheet();
  return '';
}

function renderNoteSheet() {
  const v = state.sheet.value || '';
  const ok = v.trim().length > 0;
  const err = state.sheet.error || '';
  const busy = state.sheet.busy || false;
  const quick = ['At the office desk', 'Client viewing', 'Property inspection', 'Off-site meeting'];
  return `<div class="sheet-wrap" id="sheetWrap">
    <div class="sheet-back" id="sheetBack"></div>
    <div class="sheet">
      <div class="sheet-grip"></div>
      <div style="display:flex;align-items:center;gap:9px">
        ${icon('clipboard', 22, 'var(--blue)')}
        <div>
          <h2>Add a note to clock in</h2>
          <div class="req">Required · what are you working on?</div>
        </div>
      </div>
      <textarea id="sheetTxt" placeholder="e.g. Client viewing at 14 Ocean View Dr, then back to office" autofocus>${escapeHtml(v)}</textarea>
      <div class="chips">
        ${quick.map(q => `<button class="chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}
      </div>
      <div id="sheetErr" class="banner" style="${err ? '' : 'display:none'};margin-top:14px;margin-bottom:0">${escapeHtml(err)}</div>
      <button class="btn-cta ${ok && !busy ? 'ok' : 'disabled'}" id="sheetGo">
        ${busy ? 'Clocking in…' : (ok ? 'CONFIRM &amp; CLOCK IN' : 'Add a note to continue')}
      </button>
    </div>
  </div>`;
}

function renderLeaveSheet() {
  // Shift-time correction only. Pre-filled with today so it's fast to file.
  const s = state.sheet;
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="sheet-wrap" id="sheetWrap">
    <div class="sheet-back" id="sheetBack"></div>
    <div class="sheet">
      <div class="sheet-grip"></div>
      <div style="display:flex;align-items:center;gap:9px">
        ${icon('clock', 22, 'var(--blue)')}
        <div>
          <h2>Shift-time change request</h2>
          <div style="font-size:12.5px;font-weight:600;color:var(--muted);margin-top:1px">e.g. you forgot to clock in at 8 — let admin know the real times</div>
        </div>
      </div>
      <label style="display:block;margin-top:14px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px">Date</label>
      <input id="reqFrom" type="date" value="${s.start || today}" style="margin-top:4px">
      <div style="display:flex;gap:10px;margin-top:10px">
        <div style="flex:1">
          <label style="display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px">Started at</label>
          <input id="reqStartTime" type="time" value="${s.start_time || '08:00'}" style="margin-top:4px">
        </div>
        <div style="flex:1">
          <label style="display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px">Finished at</label>
          <input id="reqEndTime" type="time" value="${s.end_time || '17:00'}" style="margin-top:4px">
        </div>
      </div>
      <textarea id="reqReason" placeholder="What happened? (e.g. forgot to clock in, system was down)" style="margin-top:10px;min-height:60px">${escapeHtml(s.reason || '')}</textarea>
      <button class="btn-cta blue" id="sheetGo">SUBMIT REQUEST</button>
    </div>
  </div>`;
}

function wireSheet() {
  const back = document.getElementById('sheetBack');
  if (back) back.addEventListener('click', () => { state.sheet = null; render(); });
  if (state.sheet.type === 'report') { wireReportSheet(); return; }
  if (state.sheet.type === 'note') {
    const txt = document.getElementById('sheetTxt');
    const go  = document.getElementById('sheetGo');
    // Focus the textarea on open. autofocus alone is unreliable after innerHTML reflows.
    if (txt) { setTimeout(() => { try { txt.focus(); txt.setSelectionRange(txt.value.length, txt.value.length); } catch {} }, 0); }
    // Update state silently on every keystroke; reflect button state directly
    // in the DOM so we don't re-render and lose focus.
    if (txt && go) {
      txt.addEventListener('input', () => {
        state.sheet.value = txt.value;
        const ok = txt.value.trim().length > 0 && !state.sheet.busy;
        go.classList.toggle('ok', ok);
        go.classList.toggle('disabled', !ok);
        go.innerHTML = state.sheet.busy ? 'Clocking in…' : (ok ? 'CONFIRM &amp; CLOCK IN' : 'Add a note to continue');
      });
    }
    document.querySelectorAll('.sheet .chip').forEach(c => c.addEventListener('click', () => {
      const q = c.dataset.q;
      state.sheet.value = q;
      if (txt) {
        txt.value = q;
        txt.focus();
        try { txt.setSelectionRange(q.length, q.length); } catch {}
        txt.dispatchEvent(new Event('input'));
      }
    }));
    if (go) go.addEventListener('click', () => {
      if (state.sheet.busy) return;
      if (!state.sheet.value || !state.sheet.value.trim()) return;
      submitClock('in');
    });
  }
  if (state.sheet.type === 'request') {
    document.getElementById('reqFrom').addEventListener('change', e => state.sheet.start = e.target.value);
    document.getElementById('reqStartTime').addEventListener('change', e => state.sheet.start_time = e.target.value);
    document.getElementById('reqEndTime').addEventListener('change', e => state.sheet.end_time = e.target.value);
    document.getElementById('reqReason').addEventListener('input', e => state.sheet.reason = e.target.value);
    document.getElementById('sheetGo').addEventListener('click', submitRequest);
  }
}

async function submitRequest() {
  const s = state.sheet || {};
  const date = s.start || document.getElementById('reqFrom').value;
  const st   = s.start_time || document.getElementById('reqStartTime').value;
  const et   = s.end_time   || document.getElementById('reqEndTime').value;
  const reason = s.reason || document.getElementById('reqReason').value;
  if (!date) { showToast('Pick the date of the shift'); return; }
  if (!st || !et) { showToast('Pick start and finish times'); return; }
  try {
    await api('leave_create', {
      agent_id: state.agent.id,
      type: 'Shift change',
      start: date, end: date,
      proposed_start: st, proposed_end: et,
      reason: reason || '',
    });
    state.sheet = null;
    showToast('Request submitted');
    await loadLeave();
    render();
  } catch (e) {
    state.error = e.message; render();
  }
}

// ───── TIMESHEET ─────────────────────────────────────────────────────
function renderTimesheet() {
  const ts = state.timesheet;
  const head = renderHeader({
    title: 'Timesheet',
    sub: ts ? weekLabel(ts.weekStart) : '',
    action: `<button class="exp-btn" id="tsExport">${icon('download', 14, '#fff', 2)} CSV</button>`,
  });
  if (!ts) return head + (state.loading ? '<div class="loading">Loading…</div>' : '<div class="loading">No data yet</div>');
  const overtime = ts.totalHrs - ts.target;
  const otTxt = overtime > 0 ? `+${fmtHM(overtime)} overtime` : `${fmtHM(ts.target - ts.totalHrs)} to go`;

  return `${head}
    <div class="content tight">
      <div class="card pad">
        <div class="between">
          <div>
            <div class="label-eyebrow">Total this week</div>
            <div style="display:flex;align-items:baseline;gap:6px;margin-top:4px">
              <span style="font-size:34px;font-weight:800" class="tnum">${fmtHM(ts.totalHrs)}</span>
              <span style="font-size:13px;font-weight:600;color:var(--muted)">of ${ts.target}h</span>
            </div>
          </div>
          <span class="pill" style="background:var(--skySoft);color:var(--blue)">${otTxt}</span>
        </div>
        <div class="bars mt-4">
          ${ts.weekBars.map(b => `
            <div class="bar-col">
              <div class="bar-track"><div class="bar ${b.today ? 'today':''}" style="height:${Math.max(4, b.v * 100).toFixed(0)}%"></div></div>
              <span class="bar-lbl">${b.l}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="section-title">Entries</div>
      <div class="col">
        ${ts.entries.length === 0 ? `<div class="card pad-sm" style="text-align:center;color:var(--muted)">No entries this week.</div>` : ''}
        ${ts.entries.map(e => `
          <div class="card entry ${e.live ? 'live':''}">
            <div class="day"><div class="d">${e.day}</div><div class="n">${e.date}</div></div>
            <div class="body">
              <div class="times">
                <b>${e.tin} – ${e.tout}</b>
                ${e.live ? `<span class="pill pill-on"><span class="dot"></span>Live</span>` : ''}
              </div>
              <div class="note ellipsis">${escapeHtml(e.note || e.loc || '—')}</div>
            </div>
            <div class="hrs tnum">${e.hrs}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function wireTimesheet() {
  const btn = document.getElementById('tsExport');
  if (btn) btn.addEventListener('click', exportTimesheetCSV);
}
function weekLabel(d) {
  const s = startOfWeek(d); const e = endOfWeek(d);
  const sd = s.getDate(), ed = e.getDate();
  const month = e.toLocaleDateString('en-GB', { month: 'long' });
  if (s.getMonth() === e.getMonth()) return `Week of ${sd}–${ed} ${month}`;
  const sm = s.toLocaleDateString('en-GB', { month: 'short' });
  const em = e.toLocaleDateString('en-GB', { month: 'short' });
  return `Week of ${sd} ${sm} – ${ed} ${em}`;
}
function exportTimesheetCSV() {
  const ts = state.timesheet;
  if (!ts) return;
  const rows = [['Day','Date','Clock In','Clock Out','Hours','Note','Location']];
  ts.entries.forEach(e => rows.push([e.day, `${e.date} ${e.monthShort || ''}`.trim(), e.tin, e.tout, e.hrs, e.note, e.loc]));
  rows.push([]);
  rows.push(['Total', '', '', '', fmtHM(ts.totalHrs), `target ${ts.target}h`, '']);
  const safeId = String(state.agent.id || 'me').replace(/[^a-z0-9_-]+/gi, '-');
  downloadCSV(`timesheet-${safeId}-${ts.weekStart.toISOString().slice(0,10)}.csv`, rows);
}

// ───── REQUESTS (leave + shift changes) ─────────────────────────────
function renderLeave() {
  const lv = state.leave;
  const head = renderHeader({ title: 'Requests', sub: 'Shift-time corrections' });
  if (!lv) return head + (state.loading ? '<div class="loading">Loading…</div>' : '<div class="loading">No data</div>');
  const tFmt = (t) => (t ? String(t).slice(0, 5) : '');
  return `${head}
    <div class="content tight">
      <div class="card pad-sm" style="text-align:left;font-size:13px;color:var(--muted);line-height:1.5">
        Use this to ask admin to correct a shift — for example if you forgot to clock in at 8am.
      </div>
      <button class="btn-cta ok" id="leaveBtn" style="margin-top:14px">
        ${icon('plus', 22, 'var(--ink)', 2.4)} NEW REQUEST
      </button>
      <div class="section-title">Your requests</div>
      <div class="col">
        ${(lv.requests || []).length === 0 ? `<div class="card pad-sm" style="text-align:center;color:var(--muted)">No requests yet.</div>` : ''}
        ${(lv.requests || []).map(r => {
          const cls = (r.status === 'Approved' ? 'pill-approved'
                    : r.status === 'Declined' ? 'pill-declined' : 'pill-pending');
          const times = (r.proposed_start || r.proposed_end)
            ? `${tFmt(r.proposed_start) || '—'} → ${tFmt(r.proposed_end) || '—'}`
            : '';
          return `<div class="card req-row">
              <div class="ic">${icon('clock', 20, 'var(--blue)')}</div>
              <div class="body">
                <div class="t">${escapeHtml(formatDateRange(r.start_date, r.end_date))}</div>
                <div class="m">${escapeHtml(times || (r.reason || ''))}</div>
              </div>
              <span class="pill ${cls}"><span class="dot"></span>${escapeHtml(r.status || 'Pending')}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}
function wireLeave() {
  const btn = document.getElementById('leaveBtn');
  if (btn) btn.addEventListener('click', () => {
    state.sheet = { type: 'request', start: '', end: '', start_time: '08:00', end_time: '17:00', reason: '' };
    render();
  });
}
function formatDateRange(a, b) {
  if (!a) return '';
  const da = new Date(a); const db = b ? new Date(b) : da;
  if (isNaN(da)) return a;
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (a === b || !b) return fmt(da);
  return fmt(da) + ' – ' + fmt(db);
}

// ───── TEAM ─────────────────────────────────────────────────────────
function renderTeam() {
  const team = state.team;
  const head = renderHeader({
    title: 'Team', sub: 'Live status · today',
    action: `<button class="exp-btn" id="teamExport">${icon('download', 14, '#fff', 2)} CSV</button>`,
  });
  if (!team) return head + (state.loading ? '<div class="loading">Loading…</div>' : '<div class="loading">No data</div>');

  const counts = {
    on: team.filter(t => t.status === 'in').length,
    off: team.filter(t => t.status === 'out').length,
  };
  const total = team.length;
  const ratio = total ? counts.on / total : 0;
  const dash = 170;

  const groups = [
    ['in', 'Working now'],
    ['out', 'Clocked out'],
  ];
  return `${head}
    <div class="content tight">
      <div class="card team-summary">
        <div class="team-donut">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="27" fill="none" stroke="var(--line)" stroke-width="7"/>
            <circle cx="32" cy="32" r="27" fill="none" stroke="var(--green)" stroke-width="7" stroke-linecap="round"
              stroke-dasharray="${dash}" stroke-dashoffset="${(dash - dash * ratio).toFixed(2)}" transform="rotate(-90 32 32)"/>
          </svg>
          <div class="num">${counts.on}/${total}</div>
        </div>
        <div>
          <div style="font-size:17px;font-weight:800">${counts.on} on the clock</div>
          <div style="font-size:13px;color:var(--muted);font-weight:500;margin-top:3px">${counts.off} out</div>
        </div>
      </div>

      ${groups.map(([key, label]) => {
        const list = team.filter(t => t.status === key);
        if (!list.length) return '';
        return `<div>
          <div class="section-title">${label} · ${list.length}</div>
          <div class="card" style="overflow:hidden">
            ${list.map((t, i) => `
              <div class="team-row">
                <div class="av-wrap">
                  <div class="av" style="background:${avColor(i)};width:40px;height:40px;font-size:14px">${initials(t.name)}</div>
                  <span class="pres-dot" style="background:${t.status === 'in' ? 'var(--green)' : '#B6BAC8'}"></span>
                </div>
                <div class="body">
                  <div class="n ellipsis">${escapeHtml(t.name)}</div>
                  <div class="m">${escapeHtml(t.role || '')}${t.cin ? ' · Since ' + escapeHtml(t.cin) : ''}</div>
                </div>
                ${t.status === 'in' && t.loc ? `<span class="loc">${icon('pin', 13, 'var(--blue)')}${escapeHtml(t.loc)}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>`;
      }).join('')}

      <button class="signout" id="signOut">${icon('logout', 18, 'var(--red)')} Sign out</button>
    </div>
  `;
}
function wireTeam() {
  const exp = document.getElementById('teamExport');
  if (exp) exp.addEventListener('click', exportTeamCSV);
  const so = document.getElementById('signOut');
  if (so) so.addEventListener('click', async () => {
    try { await window.QD.call('logout', {}); } catch {}
    writeStored(null);
    state.agent = null; state.home = state.timesheet = state.leave = state.team = null;
    state.pinBuf = ''; state.pinErr = false; state.error = null;
    location.hash = '';
    render();
  });
}
function exportTeamCSV() {
  const team = state.team || [];
  const rows = [['Name','Role','Status','Clock-in','Location','Note','Hours today']];
  team.forEach(t => rows.push([
    t.name, t.role || '', statusLabel(t.status),
    t.cin || '', t.loc || '', t.note || '', fmtHM(t.todayHrs || 0),
  ]));
  downloadCSV(`team-${new Date().toISOString().slice(0,10)}.csv`, rows);
}
function statusLabel(s) {
  if (s === 'in')    return 'On the clock';
  if (s === 'break') return 'On break';
  if (s === 'leave') return 'On leave';
  return 'Clocked out';
}

// ───── KICK OFF ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// Tick once a second when on home + clocked in, to keep elapsed live
setInterval(() => {
  if (state.tab === 'home' && state.home && state.home.status === 'in') {
    const el = document.querySelector('.dial-btn .elapsed');
    if (el) el.textContent = fmtElapsed(state.home.lastIn);
  }
}, 1000);

})();
