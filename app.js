/* Quay 1 — Clock In/Out PWA · vanilla JS, no build step */
(function () {
  // ---- CONFIG ---------------------------------------------------------------
  // After deploying the Apps Script Web App (see apps_script/SETUP.md),
  // paste its URL below. Until set, the app shows a setup message.
  const APPS_SCRIPT_URL = ''; // e.g. 'https://script.google.com/macros/s/AKfycb.../exec'

  // ---- STATE ----------------------------------------------------------------
  let roster = [];           // [{id, name, team, status, lastIn, lastOut}, ...]
  let selectedAgent = null;
  let pinBuffer = '';

  const $content = document.getElementById('content');
  const $clock = document.getElementById('liveClock');
  const $conn = document.getElementById('connStatus');

  // ---- TIME -----------------------------------------------------------------
  function tick() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    $clock.textContent = `${hh}:${mm}`;
  }
  tick();
  setInterval(tick, 30 * 1000);

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function fmtDuration(fromIso, toIso) {
    const ms = new Date(toIso) - new Date(fromIso);
    if (isNaN(ms) || ms < 0) return '';
    const mins = Math.floor(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }
  function initials(name) {
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  // ---- API ------------------------------------------------------------------
  async function api(action, payload) {
    if (!APPS_SCRIPT_URL) throw new Error('SETUP_PENDING');
    // Apps Script web apps accept POST without CORS preflight when we use
    // text/plain content type (no Content-Type=application/json header).
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
  function setConn(ok) {
    $conn.className = ok ? 'conn-ok' : 'conn-bad';
    $conn.textContent = (ok ? '●' : '●') + ' ' + (ok ? 'online' : 'offline');
  }

  // ---- RENDER ---------------------------------------------------------------
  function renderSetupHelp() {
    $content.innerHTML = `
      <div class="error-banner">
        <b>Setup pending.</b> Edit <code>app.js</code> and paste your Apps Script
        Web App URL into <code>APPS_SCRIPT_URL</code>. See
        <code>apps_script/SETUP.md</code> for the 5-minute setup.
      </div>`;
  }

  function renderRoster(err) {
    const tiles = roster.map(a => {
      const status = a.status === 'in'
        ? `<div class="st">Clocked in ${fmtTime(a.lastIn)}</div>`
        : `<div class="st">Tap to clock in</div>`;
      return `<div class="agent-tile ${a.status === 'in' ? 'is-in' : ''}" data-agent="${a.id}">
        <div class="ava">${initials(a.name)}</div>
        <div class="nm">${a.name}</div>
        ${status}
      </div>`;
    }).join('');

    $content.innerHTML = `
      ${err ? `<div class="error-banner">${err}</div>` : ''}
      <div class="section-title">Tap your name</div>
      <div class="roster">${tiles}</div>`;

    document.querySelectorAll('.agent-tile').forEach(el =>
      el.addEventListener('click', () => {
        selectedAgent = roster.find(a => a.id === el.dataset.agent);
        pinBuffer = '';
        renderPin();
      }));
  }

  function renderPin(showError) {
    const a = selectedAgent;
    const statusPill = a.status === 'in'
      ? `<span class="status in">CLOCKED IN · since ${fmtTime(a.lastIn)}</span>`
      : `<span class="status out">CLOCKED OUT</span>`;
    const dots = [0, 1, 2, 3].map(i =>
      `<div class="pin-dot ${i < pinBuffer.length ? 'filled' : ''}"></div>`).join('');

    $content.innerHTML = `
      <div class="pin-screen ${showError ? 'pin-error' : ''}">
        <div class="ava-big">${initials(a.name)}</div>
        <h2>${a.name}</h2>
        ${statusPill}
        <div class="pin-prompt">${a.status === 'in' ? 'Enter your PIN to clock out' : 'Enter your PIN to clock in'}</div>
        <div class="pin-dots">${dots}</div>
        <div class="keypad">
          ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-d="${n}">${n}</button>`).join('')}
          <button class="key alt" data-back>← Back</button>
          <button class="key" data-d="0">0</button>
          <button class="key alt" data-clear>Clear</button>
        </div>
      </div>`;

    document.querySelectorAll('.key[data-d]').forEach(b =>
      b.addEventListener('click', () => {
        if (pinBuffer.length >= 4) return;
        pinBuffer += b.dataset.d;
        renderPin();
        if (pinBuffer.length === 4) submitClock();
      }));
    document.querySelector('.key[data-back]').addEventListener('click', () => {
      selectedAgent = null; pinBuffer = ''; renderRoster();
    });
    document.querySelector('.key[data-clear]').addEventListener('click', () => {
      pinBuffer = ''; renderPin();
    });
  }

  function renderConfirm(action, event) {
    const isIn = action === 'in';
    $content.innerHTML = `
      <div class="confirm ${isIn ? 'in' : 'out'}">
        <div class="check">${isIn ? '✓' : '⏏'}</div>
        <h2>${isIn ? 'Welcome, ' + selectedAgent.name.split(' ')[0] : 'See you tomorrow!'}</h2>
        <div class="sub">${isIn ? 'You are now clocked in.' : 'You are now clocked out.'}</div>
        <div class="ts">${fmtTime(event.ts)}</div>
        ${!isIn && event.duration ? `<div class="duration">Worked ${event.duration} today</div>` : ''}
        <div><button class="btn-back" id="btnDone">Done</button></div>
      </div>`;
    document.getElementById('btnDone').addEventListener('click', () => {
      selectedAgent = null; pinBuffer = '';
      loadRoster();
    });
    // Auto-return after 6s so the kiosk is ready for the next person
    setTimeout(() => {
      if (document.getElementById('btnDone')) {
        selectedAgent = null; pinBuffer = '';
        loadRoster();
      }
    }, 6000);
  }

  // ---- ACTIONS --------------------------------------------------------------
  async function loadRoster() {
    $content.innerHTML = `<div class="loading">Loading roster…</div>`;
    try {
      if (!APPS_SCRIPT_URL) { renderSetupHelp(); return; }
      const data = await api('roster', {});
      roster = data.roster || [];
      setConn(true);
      renderRoster();
    } catch (e) {
      setConn(false);
      renderRoster('Couldn’t load roster: ' + e.message);
    }
  }
  async function submitClock() {
    const a = selectedAgent;
    const targetAction = a.status === 'in' ? 'out' : 'in';
    try {
      const res = await api('clock', { agentId: a.id, pin: pinBuffer, action: targetAction });
      renderConfirm(targetAction, res.event);
    } catch (e) {
      pinBuffer = '';
      if (String(e.message).toLowerCase().includes('pin')) {
        renderPin(true);
        // After flash, restore unfilled dots
        setTimeout(() => renderPin(), 600);
      } else {
        renderRoster('Clock action failed: ' + e.message);
      }
    }
  }

  loadRoster();
})();
