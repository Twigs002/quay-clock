/**
 * Quay 1 — Clock In/Out + Leave backend (Google Apps Script Web App, v2)
 * ======================================================================
 * Backs the quay-clock PWA + admin dashboard. Accepts POST {action, ...}
 * (text/plain to dodge CORS preflight) and reads/writes a Google Sheet
 * with four tabs:
 *
 *   tab "Roster"     id | name | role | team | pin | active | admin
 *   tab "Events"     ts | id | name | action | note | location | duration_hrs
 *   tab "Leave"      id | ts | agent_id | agent_name | type | start_date | end_date | days | reason | status | decided_by | decided_ts
 *   tab "Locations"  name | address | lat | lng | radius_m
 *
 * Missing tabs are auto-created with the expected header row so setup is
 * fault-tolerant.
 *
 * SETUP (see apps_script/SETUP.md):
 *  1. Open the sheet → Extensions → Apps Script → paste this file → Save.
 *  2. Deploy → New deployment → Web app, Execute as Me, Anyone access.
 *  3. Copy the URL → paste into quay-clock/app.js (APPS_SCRIPT_URL).
 *
 * Actions:
 *   roster                            → list of agents (no pin returned)
 *   login {pin}                       → verify pin, return agent profile
 *   me {agent_id}                     → today's hours, week hours, last event/note
 *   clock {agent_id, action, note?, loc?} → append event (in/out)
 *   events {from?, to?, agent_id?}    → raw events for a window (default: this week)
 *   summary {from?, to?, agent_id?}   → per-agent total hours for a window
 *   team_today                        → live status for every active agent
 *   leave_list {agent_id?}            → all leave requests (or one agent's)
 *   leave_create {agent_id, type, start, end, reason} → append a request
 *   leave_decide {id, status, admin_pin}              → Approve/Decline
 *   admin_check {pin}                 → verify admin pin
 *   locations                         → list of offices/geofences
 *   roster_add {admin_pin, id, name, role?, team?, pin, active?, admin?} → append staff row
 *   roster_set_active {admin_pin, id, active}         → toggle active
 *   event_add    {admin_pin, agent_id, ts, action, note?, loc?, duration_hrs?} → append a manual event
 *   event_update {admin_pin, agent_id, ts, new_ts?, note?, loc?, action?, duration_hrs?} → edit by composite key
 *   event_delete {admin_pin, agent_id, ts}            → delete by composite key
 */

var SHEET_ID = ''; // leave blank to use the bound sheet
var TAB_ROSTER    = 'Roster';
var TAB_EVENTS    = 'Events';
var TAB_LEAVE     = 'Leave';
var TAB_LOCATIONS = 'Locations';

// --- entry points ----------------------------------------------------------
function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    return reply(dispatch_(body.action, body, e));
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return reply(dispatch_(e.parameter.action, e.parameter, e));
  }
  return reply({ ok: true, hint: 'POST {action, ...}. v2.' });
}

function dispatch_(action, body, e) {
  switch (action) {
    case 'roster':       return { ok: true, roster: getRoster_() };
    case 'login':        return loginAction_(body);
    case 'me':           return meAction_(body);
    case 'clock':        return clockAction_(body, e);
    case 'events':       return { ok: true, events: getEvents_(body.from, body.to, body.agent_id) };
    case 'summary':      return { ok: true, summary: getSummary_(body.from, body.to, body.agent_id) };
    case 'team_today':   return { ok: true, team: getTeamToday_() };
    case 'leave_list':   return { ok: true, leave: getLeave_(body.agent_id) };
    case 'leave_create': return leaveCreateAction_(body);
    case 'leave_decide': return leaveDecideAction_(body);
    case 'admin_check':  return adminCheckAction_(body);
    case 'locations':    return { ok: true, locations: getLocations_() };
    case 'roster_add':        return rosterAddAction_(body);
    case 'roster_set_active': return rosterSetActiveAction_(body);
    case 'event_add':         return eventAddAction_(body);
    case 'event_update':      return eventUpdateAction_(body);
    case 'event_delete':      return eventDeleteAction_(body);
  }
  return { ok: false, error: 'Unknown action: ' + String(action) };
}

// --- actions ---------------------------------------------------------------
function loginAction_(body) {
  var pin = String(body.pin || '').trim();
  if (!pin) return { ok: false, error: 'Missing PIN' };
  var agent = findAgentByPin_(pin);
  if (!agent) return { ok: false, error: 'PIN not recognised' };
  return { ok: true, agent: publicAgent_(agent) };
}

function meAction_(body) {
  var id = String(body.agent_id || '').trim();
  if (!id) return { ok: false, error: 'Missing agent_id' };
  var agent = findAgentById_(id);
  if (!agent) return { ok: false, error: 'Unknown agent' };
  var st = lastStatusFor_(id);
  var w = weekRange_();
  var today = todayRange_();
  var weekHrs = sumHoursForAgent_(id, w.from, w.to);
  var todayHrs = sumHoursForAgent_(id, today.from, today.to);
  return {
    ok: true,
    agent: publicAgent_(agent),
    status: st.status,
    lastIn: st.lastIn,
    lastOut: st.lastOut,
    lastNote: st.lastNote,
    lastLoc: st.lastLoc,
    todayHrs: todayHrs,
    weekHrs: weekHrs,
    weekTarget: 40,
  };
}

function clockAction_(body, e) {
  var id     = String(body.agent_id || '').trim();
  var action = String(body.action || '').toLowerCase();
  var note   = String(body.note || '').trim();
  var loc    = String(body.loc  || '').trim();
  if (!id || (action !== 'in' && action !== 'out')) {
    return { ok: false, error: 'Missing agent_id or action(in|out)' };
  }
  var agent = findAgentById_(id);
  if (!agent) return { ok: false, error: 'Unknown agent' };

  var st = lastStatusFor_(id);
  if (action === 'in'  && st.status === 'in')  return { ok: false, error: 'Already clocked in at ' + st.lastIn };
  if (action === 'out' && st.status === 'out') return { ok: false, error: 'You are not clocked in.' };
  if (action === 'in'  && !note) return { ok: false, error: 'A shift note is required to clock in.' };

  var sh = sheet_(TAB_EVENTS);
  var now = new Date();
  var durationHrs = '';
  if (action === 'out' && st.lastIn) {
    durationHrs = ((now - new Date(st.lastIn)) / 3.6e6).toFixed(3);
  }
  sh.appendRow([
    now.toISOString(),
    id,
    agent.name,
    action,
    note,
    loc,
    durationHrs,
  ]);
  return {
    ok: true,
    event: {
      ts: now.toISOString(),
      action: action,
      note: note,
      loc: loc,
      duration: durationHrs ? humanDuration_(durationHrs) : '',
    },
  };
}

function leaveCreateAction_(body) {
  var id = String(body.agent_id || '').trim();
  var type = String(body.type || '').trim();
  var start = String(body.start || '').trim();
  var end = String(body.end || start).trim();
  var reason = String(body.reason || '').trim();
  if (!id || !type || !start) return { ok: false, error: 'Missing agent_id/type/start' };
  var agent = findAgentById_(id);
  if (!agent) return { ok: false, error: 'Unknown agent' };
  var sh = sheet_(TAB_LEAVE);
  var rid = 'L' + Date.now().toString(36).toUpperCase();
  var days = dayDiff_(start, end);
  sh.appendRow([rid, new Date().toISOString(), id, agent.name, type, start, end, days, reason, 'Pending', '', '']);
  return { ok: true, id: rid };
}

function leaveDecideAction_(body) {
  var rid = String(body.id || '').trim();
  var status = String(body.status || '').trim();
  var adminPin = String(body.admin_pin || '').trim();
  if (!rid || (status !== 'Approved' && status !== 'Declined')) {
    return { ok: false, error: 'Missing id / status(Approved|Declined)' };
  }
  var admin = findAdminByPin_(adminPin);
  if (!admin) return { ok: false, error: 'Admin PIN required' };

  var sh = sheet_(TAB_LEAVE);
  var rows = sh.getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.id == null || hdr.status == null) {
    return { ok: false, error: 'Leave sheet missing required columns (id/status). Check the header row.' };
  }
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][hdr.id]).trim() === rid) {
      sh.getRange(i + 1, hdr.status + 1).setValue(status);
      if (hdr.decided_by != null) sh.getRange(i + 1, hdr.decided_by + 1).setValue(admin.name);
      if (hdr.decided_ts != null) sh.getRange(i + 1, hdr.decided_ts + 1).setValue(new Date().toISOString());
      return { ok: true };
    }
  }
  return { ok: false, error: 'Request not found' };
}

function adminCheckAction_(body) {
  var pin = String(body.pin || '').trim();
  var admin = findAdminByPin_(pin);
  if (!admin) return { ok: false, error: 'Invalid admin PIN' };
  return { ok: true, admin: publicAgent_(admin) };
}

function rosterAddAction_(body) {
  var admin = findAdminByPin_(String(body.admin_pin || '').trim());
  if (!admin) return { ok: false, error: 'Admin PIN required' };

  var id   = slugify_(body.id || body.name);
  var name = String(body.name || '').trim();
  var pin  = normalisePin_(body.pin);
  if (!id)   return { ok: false, error: 'A username (id) is required' };
  if (!name) return { ok: false, error: 'Name is required' };
  if (!pin || pin.length < 4) return { ok: false, error: 'PIN must be 4 digits' };

  var role   = String(body.role   || '').trim();
  var team   = String(body.team   || '').trim();
  var active = body.active == null ? 'true' : (isFalse_(body.active) ? 'false' : 'true');
  var isAdm  = body.admin === true || String(body.admin).toLowerCase() === 'true' ? 'true' : 'false';

  var sh = sheet_(TAB_ROSTER);
  var rows = sh.getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.id == null || hdr.name == null || hdr.pin == null) {
    return { ok: false, error: 'Roster sheet missing required columns (id/name/pin).' };
  }
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][hdr.id]).trim().toLowerCase() === id.toLowerCase()) {
      return { ok: false, error: 'Username "' + id + '" is already taken.' };
    }
    if (normalisePin_(rows[i][hdr.pin]) === pin) {
      return { ok: false, error: 'That PIN is already in use — pick a different one.' };
    }
  }
  // Build the new row in the order of the existing header so we tolerate
  // sheets where the user has re-ordered columns.
  var newRow = [];
  for (var c = 0; c < rows[0].length; c++) {
    var col = String(rows[0][c]).toLowerCase().trim();
    if (col === 'id')          newRow.push(id);
    else if (col === 'name')   newRow.push(name);
    else if (col === 'role')   newRow.push(role);
    else if (col === 'team')   newRow.push(team);
    else if (col === 'pin')    newRow.push(pin);
    else if (col === 'active') newRow.push(active);
    else if (col === 'admin')  newRow.push(isAdm);
    else newRow.push('');
  }
  sh.appendRow(newRow);
  return { ok: true, agent: { id: id, name: name, role: role, team: team, admin: isAdm === 'true' } };
}

function rosterSetActiveAction_(body) {
  var admin = findAdminByPin_(String(body.admin_pin || '').trim());
  if (!admin) return { ok: false, error: 'Admin PIN required' };
  var id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'Missing id' };
  var active = isFalse_(body.active) ? 'false' : 'true';
  var sh = sheet_(TAB_ROSTER);
  var rows = sh.getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.id == null || hdr.active == null) {
    return { ok: false, error: 'Roster missing id/active columns.' };
  }
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][hdr.id]).trim() === id) {
      sh.getRange(i + 1, hdr.active + 1).setValue(active);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Staff member not found' };
}

// ── manual event editing (admin) ────────────────────────────────────
function eventAddAction_(body) {
  var admin = findAdminByPin_(String(body.admin_pin || '').trim());
  if (!admin) return { ok: false, error: 'Admin PIN required' };
  var id = String(body.agent_id || '').trim();
  var action = String(body.action || '').toLowerCase();
  var ts = toIsoOrEmpty_(body.ts);
  if (!id || !ts || (action !== 'in' && action !== 'out')) {
    return { ok: false, error: 'Need agent_id, ts, action(in|out)' };
  }
  var agent = findAgentById_(id);
  if (!agent) return { ok: false, error: 'Unknown agent' };
  var sh = sheet_(TAB_EVENTS);
  sh.appendRow([
    ts, id, agent.name, action,
    String(body.note || ''), String(body.loc || ''),
    body.duration_hrs != null && body.duration_hrs !== '' ? Number(body.duration_hrs) : '',
  ]);
  return { ok: true, event: { ts: ts, agent_id: id, action: action } };
}

function eventUpdateAction_(body) {
  var admin = findAdminByPin_(String(body.admin_pin || '').trim());
  if (!admin) return { ok: false, error: 'Admin PIN required' };
  var id = String(body.agent_id || '').trim();
  var ts = String(body.ts || '').trim();
  if (!id || !ts) return { ok: false, error: 'Need agent_id + ts to identify the row' };
  var sh = sheet_(TAB_EVENTS);
  var rows = sh.getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.ts == null || hdr.id == null) return { ok: false, error: 'Events sheet missing ts/id columns' };
  for (var i = 1; i < rows.length; i++) {
    if (isoString_(rows[i][hdr.ts]) === ts && String(rows[i][hdr.id]).trim() === id) {
      if (body.new_ts != null) {
        var nts = toIsoOrEmpty_(body.new_ts);
        if (!nts) return { ok: false, error: 'Invalid new_ts' };
        sh.getRange(i + 1, hdr.ts + 1).setValue(nts);
      }
      if (body.action != null && hdr.action != null) {
        var a = String(body.action).toLowerCase();
        if (a !== 'in' && a !== 'out') return { ok: false, error: 'action must be in|out' };
        sh.getRange(i + 1, hdr.action + 1).setValue(a);
      }
      if (body.note != null && hdr.note != null) sh.getRange(i + 1, hdr.note + 1).setValue(String(body.note));
      if (body.loc  != null && hdr.location != null) sh.getRange(i + 1, hdr.location + 1).setValue(String(body.loc));
      if (body.duration_hrs != null && hdr.duration_hrs != null) {
        sh.getRange(i + 1, hdr.duration_hrs + 1)
          .setValue(body.duration_hrs === '' ? '' : Number(body.duration_hrs));
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'Event not found' };
}

function eventDeleteAction_(body) {
  var admin = findAdminByPin_(String(body.admin_pin || '').trim());
  if (!admin) return { ok: false, error: 'Admin PIN required' };
  var id = String(body.agent_id || '').trim();
  var ts = String(body.ts || '').trim();
  if (!id || !ts) return { ok: false, error: 'Need agent_id + ts' };
  var sh = sheet_(TAB_EVENTS);
  var rows = sh.getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.ts == null || hdr.id == null) return { ok: false, error: 'Events sheet missing ts/id columns' };
  for (var i = 1; i < rows.length; i++) {
    if (isoString_(rows[i][hdr.ts]) === ts && String(rows[i][hdr.id]).trim() === id) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Event not found' };
}

function slugify_(raw) {
  return String(raw || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// --- readers ---------------------------------------------------------------
function getRoster_() {
  var rows = sheet_(TAB_ROSTER).getDataRange().getValues();
  if (rows.length < 2) return [];
  var hdr = headerIndex_(rows[0]);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var id = String(r[hdr.id] || '').trim();
    var name = String(r[hdr.name] || '').trim();
    if (!id || !name) continue;
    if (hdr.active != null && isFalse_(r[hdr.active])) continue;
    var st = lastStatusFor_(id);
    out.push({
      id: id, name: name,
      role: hdr.role != null ? String(r[hdr.role] || '') : '',
      team: hdr.team != null ? String(r[hdr.team] || '') : '',
      admin: hdr.admin != null ? (String(r[hdr.admin]).toLowerCase() === 'true') : false,
      status: st.status, lastIn: st.lastIn, lastOut: st.lastOut,
      lastNote: st.lastNote, lastLoc: st.lastLoc,
    });
  }
  out.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'in' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function getEvents_(from, to, agentId) {
  var w = parseRange_(from, to);
  var rows = sheet_(TAB_EVENTS).getDataRange().getValues();
  if (rows.length < 2) return [];
  var hdr = headerIndex_(rows[0]);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var ts = isoString_(r[hdr.ts]);
    if (!ts) continue;
    if (w.from && ts < w.from) continue;
    if (w.to && ts > w.to) continue;
    var id = String(r[hdr.id] || '').trim();
    if (agentId && id !== agentId) continue;
    out.push({
      ts: ts, id: id,
      name: String(r[hdr.name] || ''),
      action: String(r[hdr.action] || '').toLowerCase(),
      note: hdr.note != null ? String(r[hdr.note] || '') : '',
      loc: hdr.location != null ? String(r[hdr.location] || '') : '',
      duration_hrs: r[hdr.duration_hrs] === '' || r[hdr.duration_hrs] == null
        ? null : Number(r[hdr.duration_hrs]),
    });
  }
  return out;
}

function getSummary_(from, to, agentId) {
  var events = getEvents_(from, to, agentId);
  var byAgent = {};
  events.forEach(function (e) {
    if (!byAgent[e.id]) byAgent[e.id] = { id: e.id, name: e.name, hours: 0, sessions: 0 };
    if (e.action === 'out' && e.duration_hrs != null && !isNaN(e.duration_hrs)) {
      byAgent[e.id].hours += e.duration_hrs;
      byAgent[e.id].sessions += 1;
    }
  });
  return Object.keys(byAgent).map(function (k) {
    return { id: byAgent[k].id, name: byAgent[k].name,
      hours: +byAgent[k].hours.toFixed(3), sessions: byAgent[k].sessions };
  });
}

function getTeamToday_() {
  // One pass over Events to compute today's hours per agent; one pass over
  // Roster to format. Was O(N²) before (lastStatusFor_ scanned per agent).
  var roster = getRoster_();
  var today = todayRange_();
  var todayEvents = getEvents_(today.from, today.to);
  var hrsByAgent = {};
  todayEvents.forEach(function (e) {
    if (e.action === 'out' && e.duration_hrs != null && !isNaN(e.duration_hrs)) {
      hrsByAgent[e.id] = (hrsByAgent[e.id] || 0) + e.duration_hrs;
    }
  });
  var nowMs = Date.now();
  return roster.map(function (a) {
    var liveBonus = (a.status === 'in' && a.lastIn)
      ? Math.max(0, (nowMs - new Date(a.lastIn).getTime()) / 3.6e6) : 0;
    return {
      id: a.id, name: a.name, role: a.role, team: a.team,
      status: a.status,
      cin: a.status === 'in' ? fmtClockTime_(a.lastIn) : '',
      loc: a.lastLoc || '',
      note: a.status === 'in' ? a.lastNote : '',
      todayHrs: +(((hrsByAgent[a.id] || 0) + liveBonus)).toFixed(3),
    };
  });
}

function getLeave_(agentId) {
  var sh = sheet_(TAB_LEAVE);
  var rows = sh.getDataRange().getValues();
  if (rows.length < 2) return [];
  var hdr = headerIndex_(rows[0]);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var id = String(r[hdr.id] || '').trim();
    if (!id) continue;
    var aid = String(r[hdr.agent_id] || '').trim();
    if (agentId && aid !== agentId) continue;
    out.push({
      id: id,
      ts: isoString_(r[hdr.ts]),
      agent_id: aid,
      agent_name: String(r[hdr.agent_name] || ''),
      type: String(r[hdr.type] || ''),
      start_date: isoDate_(r[hdr.start_date]),
      end_date: isoDate_(r[hdr.end_date]),
      days: Number(r[hdr.days] || 0),
      reason: String(r[hdr.reason] || ''),
      status: String(r[hdr.status] || 'Pending'),
      decided_by: hdr.decided_by != null ? String(r[hdr.decided_by] || '') : '',
      decided_ts: hdr.decided_ts != null ? isoString_(r[hdr.decided_ts]) : '',
    });
  }
  return out.sort(function (a, b) { return (b.ts || '').localeCompare(a.ts || ''); });
}

function getLocations_() {
  var sh = sheet_(TAB_LOCATIONS);
  var rows = sh.getDataRange().getValues();
  if (rows.length < 2) return defaultLocations_();
  var hdr = headerIndex_(rows[0]);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var name = String(r[hdr.name] || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      address: String(r[hdr.address] || ''),
      lat: r[hdr.lat] === '' ? null : Number(r[hdr.lat]),
      lng: r[hdr.lng] === '' ? null : Number(r[hdr.lng]),
      radius_m: r[hdr.radius_m] === '' ? null : Number(r[hdr.radius_m]),
    });
  }
  return out.length ? out : defaultLocations_();
}

// --- helpers ---------------------------------------------------------------
function sheet_(name) {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  var header;
  if (name === TAB_ROSTER)         header = ['id','name','role','team','pin','active','admin'];
  else if (name === TAB_EVENTS)    header = ['ts','id','name','action','note','location','duration_hrs'];
  else if (name === TAB_LEAVE)     header = ['id','ts','agent_id','agent_name','type','start_date','end_date','days','reason','status','decided_by','decided_ts'];
  else if (name === TAB_LOCATIONS) header = ['name','address','lat','lng','radius_m'];
  if (header) { sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}

function headerIndex_(row) {
  var ix = {};
  for (var i = 0; i < row.length; i++) ix[String(row[i]).toLowerCase().trim()] = i;
  return ix;
}

function findAgentById_(id) {
  var rows = sheet_(TAB_ROSTER).getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.id == null) return null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][hdr.id]).trim() === id) return rowToAgent_(rows[i], hdr);
  }
  return null;
}
function findAgentByPin_(pin) {
  var rows = sheet_(TAB_ROSTER).getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  if (hdr.pin == null) return null; // safer than scanning `undefined` cells
  var needle = normalisePin_(pin);
  for (var i = 1; i < rows.length; i++) {
    if (normalisePin_(rows[i][hdr.pin]) !== needle) continue;
    if (hdr.active != null && isFalse_(rows[i][hdr.active])) continue;
    return rowToAgent_(rows[i], hdr);
  }
  return null;
}
// Sheets stores numeric PINs as numbers; "0123" becomes 123. Normalise both
// sides to a left-padded 4-digit string so login is robust to cell formatting.
function normalisePin_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (s === '') return '';
  // strip any non-digit, then left-pad to 4 (the expected PIN length)
  var digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits : ('0000' + digits).slice(-4);
}
function isFalse_(v) {
  if (v === false) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'false' || s === 'no' || s === '0';
}
function findAdminByPin_(pin) {
  var a = findAgentByPin_(pin);
  return (a && a.admin) ? a : null;
}
function rowToAgent_(r, hdr) {
  return {
    id: String(r[hdr.id] || '').trim(),
    name: String(r[hdr.name] || '').trim(),
    role: hdr.role != null ? String(r[hdr.role] || '') : '',
    team: hdr.team != null ? String(r[hdr.team] || '') : '',
    pin: String(r[hdr.pin] || '').trim(),
    admin: hdr.admin != null ? (String(r[hdr.admin]).toLowerCase() === 'true') : false,
  };
}
function publicAgent_(a) {
  return { id: a.id, name: a.name, role: a.role, team: a.team, admin: !!a.admin };
}

function lastStatusFor_(id) {
  var ev = sheet_(TAB_EVENTS);
  var rows = ev.getDataRange().getValues();
  if (rows.length < 2) return { status: 'out', lastIn: '', lastOut: '', lastNote: '', lastLoc: '' };
  var hdr = headerIndex_(rows[0]);
  var lastIn = '', lastOut = '', lastNote = '', lastLoc = '';
  for (var i = rows.length - 1; i >= 1; i--) {
    var r = rows[i];
    if (String(r[hdr.id]).trim() !== id) continue;
    var act = String(r[hdr.action]).toLowerCase();
    if (act === 'in' && !lastIn) {
      lastIn = isoString_(r[hdr.ts]);
      lastNote = hdr.note != null ? String(r[hdr.note] || '') : '';
      lastLoc  = hdr.location != null ? String(r[hdr.location] || '') : '';
    }
    if (act === 'out' && !lastOut) lastOut = isoString_(r[hdr.ts]);
    if (lastIn && lastOut) break;
  }
  var status = 'out';
  if (lastIn && (!lastOut || new Date(lastIn) > new Date(lastOut))) status = 'in';
  return { status: status, lastIn: lastIn, lastOut: lastOut, lastNote: lastNote, lastLoc: lastLoc };
}

function sumHoursForAgent_(id, fromIso, toIso) {
  var events = getEvents_(fromIso, toIso, id);
  var total = 0;
  events.forEach(function (e) {
    if (e.action === 'out' && e.duration_hrs != null && !isNaN(e.duration_hrs)) total += e.duration_hrs;
  });
  return +total.toFixed(3);
}

// --- dates -----------------------------------------------------------------
function isoString_(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function isoDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var d = new Date(s);
  if (!isNaN(d)) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return s;
}
function fmtClockTime_(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function humanDuration_(hrsStr) {
  var hrs = parseFloat(hrsStr) || 0;
  var totalMin = Math.round(hrs * 60);
  return Math.floor(totalMin / 60) + 'h ' + (totalMin % 60) + 'm';
}
function parseRange_(from, to) {
  var f = from ? toIsoOrEmpty_(from) : '';
  var t = to   ? toIsoOrEmpty_(to)   : '';
  if (!f && !t) { var w = weekRange_(); return w; }
  return { from: f, to: t };
}
function toIsoOrEmpty_(v) {
  if (!v) return '';
  var d = (v instanceof Date) ? v : new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}
function weekRange_() {
  // Monday 00:00 → Sunday 23:59:59
  var now = new Date();
  var day = (now.getDay() + 6) % 7; // 0 = Mon
  var mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 0, 0, 0);
  var sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59);
  return { from: mon.toISOString(), to: sun.toISOString() };
}
function todayRange_() {
  var now = new Date();
  var s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  var e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { from: s.toISOString(), to: e.toISOString() };
}
function dayDiff_(start, end) {
  // Counts working days (Mon-Fri) only, inclusive of both endpoints.
  var s = new Date(start); var e = new Date(end || start);
  if (isNaN(s) || isNaN(e)) return 1;
  if (e < s) { var t = s; s = e; e = t; }
  var days = 0;
  var cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  var stop = new Date(e.getFullYear(), e.getMonth(), e.getDate());
  while (cur <= stop) {
    var d = cur.getDay();
    if (d !== 0 && d !== 6) days++; // skip Sun(0) + Sat(6)
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, days);
}

function defaultLocations_() {
  return [
    { name:'V&A Waterfront Office', address:'19 Dock Rd, V&A Waterfront, Cape Town', lat:-33.9036, lng:18.4194, radius_m:150 },
    { name:'Sea Point Branch',      address:'120 Main Rd, Sea Point, Cape Town',     lat:-33.9249, lng:18.3886, radius_m:120 },
    { name:'Camps Bay Showroom',    address:'42 Victoria Rd, Camps Bay, Cape Town',  lat:-33.9527, lng:18.3776, radius_m:100 },
    { name:'Remote / Field',        address:'Geofence disabled — clock in anywhere', lat:null,     lng:null,    radius_m:null },
  ];
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
