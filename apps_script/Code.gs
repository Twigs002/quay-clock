/**
 * Quay 1 — Clock In/Out backend (Google Apps Script Web App)
 * =============================================================
 * Backs the quay-clock PWA. Accepts POST {action, ...} requests from the
 * browser (text/plain to avoid CORS preflight) and reads/writes a Google
 * Sheet with two tabs:
 *
 *   tab "Roster"  columns:  id | name | team | pin | active
 *   tab "Events"  columns:  ts | id | name | action | duration_hrs | source_ip
 *
 * SETUP (see apps_script/SETUP.md for screenshots):
 *  1. Create the sheet with the two tabs (sample first row included).
 *  2. Extensions → Apps Script → paste this whole file → Save.
 *  3. Deploy → New deployment → Type "Web app".
 *  4. Execute as: Me. Who has access: Anyone. Deploy → copy the URL.
 *  5. Paste the URL into quay-clock/app.js (APPS_SCRIPT_URL constant).
 */

// ------------ CONFIG -------------------------------------------------------
// Optional: hard-code the sheet ID to avoid `getActiveSpreadsheet` ambiguity
// when the script is later moved to a stand-alone project. Leave blank to use
// the currently-bound sheet (i.e. the one Extensions→Apps Script was opened
// from).
var SHEET_ID = '';

var TAB_ROSTER = 'Roster';
var TAB_EVENTS = 'Events';


// ------------ ENTRY POINTS --------------------------------------------------
function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var action = body.action;
    if (action === 'roster') return reply({ ok: true, roster: getRoster() });
    if (action === 'clock')  return reply(handleClock(body, e));
    return reply({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  // Convenience: GET /?action=roster works too (browser sanity check).
  if (e && e.parameter && e.parameter.action === 'roster') {
    return reply({ ok: true, roster: getRoster() });
  }
  return reply({ ok: true, hint: 'POST {action: "roster" | "clock", ...}' });
}


// ------------ HANDLERS ------------------------------------------------------
function getRoster() {
  var sh = sheet_(TAB_ROSTER);
  var rows = sh.getDataRange().getValues();
  if (rows.length < 2) return [];
  var hdr = headerIndex_(rows[0]);
  var roster = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var id   = String(r[hdr.id] || '').trim();
    var name = String(r[hdr.name] || '').trim();
    if (!id || !name) continue;
    if (hdr.active != null && String(r[hdr.active]).toLowerCase() === 'false') continue;
    var status = lastStatusFor_(id);
    roster.push({
      id: id,
      name: name,
      team: hdr.team != null ? r[hdr.team] : '',
      status: status.status,
      lastIn:  status.lastIn,
      lastOut: status.lastOut
    });
  }
  // Sort: clocked-in agents first, then alphabetical
  roster.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'in' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return roster;
}

function handleClock(body, e) {
  var id     = String(body.agentId || '').trim();
  var pin    = String(body.pin || '').trim();
  var action = body.action; // 'in' or 'out'
  if (!id || !pin || !action) return { ok: false, error: 'Missing agentId/pin/action' };

  // Look up the agent + verify PIN
  var sh = sheet_(TAB_ROSTER);
  var rows = sh.getDataRange().getValues();
  var hdr = headerIndex_(rows[0]);
  var found = null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][hdr.id]).trim() === id) { found = rows[i]; break; }
  }
  if (!found) return { ok: false, error: 'Unknown agent' };
  if (String(found[hdr.pin]).trim() !== pin) return { ok: false, error: 'Invalid PIN' };

  // Sanity: don't allow double clock-in / double clock-out
  var st = lastStatusFor_(id);
  if (action === 'in'  && st.status === 'in')  return { ok: false, error: 'Already clocked in at ' + st.lastIn };
  if (action === 'out' && st.status === 'out') return { ok: false, error: 'You are not clocked in.' };

  // Append the event
  var ev = sheet_(TAB_EVENTS);
  var now = new Date();
  var durationHrs = '';
  if (action === 'out' && st.lastIn) {
    durationHrs = ((now - new Date(st.lastIn)) / 3.6e6).toFixed(3);
  }
  ev.appendRow([
    now.toISOString(),
    id,
    String(found[hdr.name]).trim(),
    action,
    durationHrs,
    (e && e.parameter && e.parameter.ip) || ''
  ]);

  return {
    ok: true,
    event: {
      ts: now.toISOString(),
      action: action,
      duration: durationHrs ? humanDuration_(durationHrs) : ''
    }
  };
}


// ------------ HELPERS -------------------------------------------------------
function sheet_(name) {
  var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found.');
  return sh;
}
function headerIndex_(row) {
  var ix = {};
  for (var i = 0; i < row.length; i++) ix[String(row[i]).toLowerCase().trim()] = i;
  return ix;
}

// Walk Events bottom-up to find this agent's most recent in/out
function lastStatusFor_(id) {
  var ev = sheet_(TAB_EVENTS);
  var rows = ev.getDataRange().getValues();
  if (rows.length < 2) return { status: 'out', lastIn: '', lastOut: '' };
  var hdr = headerIndex_(rows[0]);
  var lastIn = '', lastOut = '';
  for (var i = rows.length - 1; i >= 1; i--) {
    var r = rows[i];
    if (String(r[hdr.id]).trim() !== id) continue;
    var act = String(r[hdr.action]).toLowerCase();
    if (act === 'in'  && !lastIn)  lastIn  = r[hdr.ts];
    if (act === 'out' && !lastOut) lastOut = r[hdr.ts];
    if (lastIn && lastOut) break;
  }
  // 'in' if the most recent event is in
  var status = 'out';
  if (lastIn && (!lastOut || new Date(lastIn) > new Date(lastOut))) status = 'in';
  return { status: status, lastIn: isoString_(lastIn), lastOut: isoString_(lastOut) };
}

function isoString_(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function humanDuration_(hrsStr) {
  var hrs = parseFloat(hrsStr) || 0;
  var totalMin = Math.round(hrs * 60);
  return Math.floor(totalMin / 60) + 'h ' + (totalMin % 60) + 'm';
}
function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
