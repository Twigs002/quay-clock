/* Quay 1 — Supabase data layer.
 * Drop-in replacement for the Apps Script `api(action, payload)` interface.
 * Loaded after quay-config.js + the supabase UMD bundle.
 *
 *   await QD.call('clock', { agent_id: 'thandi', dir: 'in', note: '...' });
 *
 * Returns the same { ok, ... } shape the Apps Script handlers used to,
 * so call sites in app.js / admin/admin.js can stay unchanged.
 */
(function () {
'use strict';

const sb = window.sb;
if (!sb) { console.error('[QD] window.sb (supabase client) not initialised'); return; }

const CFG = window.QUAY_CFG || {};
const EMAIL_DOMAIN = CFG.AUTH_EMAIL_DOMAIN || 'quay1.local';
const emailFor = (id) => `${String(id).toLowerCase().trim()}@${EMAIL_DOMAIN}`;

// ─── small helpers ──────────────────────────────────────────────────
const startOfWeek = (d) => {
  const x = new Date(d); const dow = (x.getDay() + 6) % 7;
  x.setHours(0,0,0,0); x.setDate(x.getDate() - dow); return x;
};
const endOfWeek = (d) => {
  const s = startOfWeek(d); const e = new Date(s);
  e.setDate(e.getDate() + 6); e.setHours(23,59,59,999); return e;
};
const todayRange = () => {
  const n = new Date();
  return {
    from: new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0,0,0).toISOString(),
    to:   new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23,59,59).toISOString(),
  };
};
const fmtClockTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
};
const humanDuration = (hrs) => {
  const total = Math.max(0, Math.round((hrs || 0) * 60));
  return Math.floor(total / 60) + 'h ' + ('0' + (total % 60)).slice(-2) + 'm';
};
const dayDiffBusiness = (start, end) => {
  // Count weekdays inclusive of both endpoints.
  const s = new Date(start); const e = new Date(end || start);
  if (isNaN(s) || isNaN(e)) return 1;
  const lo = s <= e ? s : e; const hi = s <= e ? e : s;
  let days = 0;
  for (let d = new Date(lo); d <= hi; d.setDate(d.getDate() + 1)) {
    const w = d.getDay(); if (w !== 0 && w !== 6) days++;
  }
  return Math.max(1, days);
};

// Cache the current staff row so we don't refetch on every call.
let _selfStaff = null;
async function loadSelfStaff() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { _selfStaff = null; return null; }
  const { data, error } = await sb.from('staff').select('*').eq('auth_user_id', user.id).maybeSingle();
  if (error) throw error;
  _selfStaff = data;
  return data;
}
function clearSelf() { _selfStaff = null; }
function publicAgent(s) {
  if (!s) return null;
  return {
    id: s.id, name: s.name,
    role: s.role || '', team: s.team || '',
    admin: !!s.is_admin,
    super: !!s.is_super,
    designation: s.designation || '',
    division: s.division || '',
  };
}

// Compute "last status" client-side. Pulls the most recent event for an agent.
async function lastStatusFor(staffId) {
  const { data, error } = await sb.from('events')
    .select('ts, dir, note')
    .eq('staff_id', staffId)
    .order('ts', { ascending: false })
    .limit(2);
  if (error) throw error;
  let lastIn = '', lastOut = '', lastNote = '';
  (data || []).forEach((e) => {
    if (e.dir === 'in'  && !lastIn)  { lastIn = e.ts;  lastNote = e.note || ''; }
    if (e.dir === 'out' && !lastOut) lastOut = e.ts;
  });
  const status = (lastIn && (!lastOut || new Date(lastIn) > new Date(lastOut))) ? 'in' : 'out';
  return { status, lastIn, lastOut, lastNote };
}

async function sumHoursForAgent(staffId, fromIso, toIso) {
  const { data, error } = await sb.from('events')
    .select('dir, duration_hrs')
    .eq('staff_id', staffId)
    .eq('dir', 'out')
    .gte('ts', fromIso).lte('ts', toIso);
  if (error) throw error;
  return (data || []).reduce((s, e) => s + (Number(e.duration_hrs) || 0), 0);
}

// ─── action handlers (mirror Apps Script semantics) ─────────────────
const handlers = {
  // username + pin login (PWA + admin both use this).
  async login(payload) {
    const username = String(payload.username || payload.id || '').toLowerCase().trim();
    const pin      = String(payload.pin || '').trim();
    if (!username) return { ok: false, error: 'Username required' };
    if (!pin)      return { ok: false, error: 'PIN required' };
    const { data, error } = await sb.auth.signInWithPassword({
      email: emailFor(username), password: pin,
    });
    if (error) return { ok: false, error: 'Username or PIN not recognised' };
    if (!data.user) return { ok: false, error: 'Login failed' };
    const staff = await loadSelfStaff();
    if (!staff || staff.active === false) {
      await sb.auth.signOut(); clearSelf();
      return { ok: false, error: 'Account is disabled' };
    }
    return { ok: true, agent: publicAgent(staff) };
  },

  async logout() {
    await sb.auth.signOut(); clearSelf();
    return { ok: true };
  },

  async me(payload) {
    const id = String(payload.agent_id || '').toLowerCase();
    if (!id) return { ok: false, error: 'Missing agent_id' };
    const { data: staff, error: sErr } = await sb.from('staff').select('*').eq('id', id).maybeSingle();
    if (sErr) return { ok: false, error: sErr.message };
    if (!staff) return { ok: false, error: 'Unknown agent' };
    const st = await lastStatusFor(id);
    const wRange = { from: startOfWeek(new Date()).toISOString(), to: endOfWeek(new Date()).toISOString() };
    const tRange = todayRange();
    const [weekHrs, todayHrs] = await Promise.all([
      sumHoursForAgent(id, wRange.from, wRange.to),
      sumHoursForAgent(id, tRange.from, tRange.to),
    ]);
    return {
      ok: true,
      agent: publicAgent(staff),
      status: st.status, lastIn: st.lastIn, lastOut: st.lastOut,
      lastNote: st.lastNote,
      todayHrs, weekHrs, weekTarget: 40,
    };
  },

  async clock(payload) {
    const id = String(payload.agent_id || '').toLowerCase();
    const dir = String(payload.dir || payload.action || '').toLowerCase();
    const note = String(payload.note || '').trim();
    if (!id || (dir !== 'in' && dir !== 'out'))
      return { ok: false, error: 'Missing agent_id or direction(in|out)' };
    const st = await lastStatusFor(id);
    if (dir === 'in'  && st.status === 'in')  return { ok: false, error: 'Already clocked in at ' + fmtClockTime(st.lastIn) };
    if (dir === 'out' && st.status === 'out') return { ok: false, error: 'You are not clocked in.' };
    if (dir === 'in'  && !note)               return { ok: false, error: 'A shift note is required to clock in.' };

    const now = new Date().toISOString();
    let duration_hrs = null;
    if (dir === 'out' && st.lastIn) {
      duration_hrs = (new Date(now) - new Date(st.lastIn)) / 3.6e6;
      duration_hrs = +duration_hrs.toFixed(3);
    }
    const { error } = await sb.from('events').insert({
      staff_id: id, ts: now, dir, note, duration_hrs,
    });
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      event: { ts: now, action: dir, note, duration: duration_hrs ? humanDuration(duration_hrs) : '' },
    };
  },

  async events(payload) {
    const w = payload.from || startOfWeek(new Date()).toISOString();
    const e = payload.to   || endOfWeek(new Date()).toISOString();
    let q = sb.from('events')
      .select('id, ts, staff_id, dir, note, duration_hrs, staff:staff_id(name)')
      .gte('ts', w).lte('ts', e).order('ts', { ascending: true });
    if (payload.agent_id) q = q.eq('staff_id', String(payload.agent_id).toLowerCase());
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const events = (data || []).map((r) => ({
      ts: r.ts,
      id: r.staff_id,
      name: r.staff?.name || '',
      action: r.dir,
      note: r.note || '',
      duration_hrs: r.duration_hrs,
      _event_id: r.id,
    }));
    return { ok: true, events };
  },

  async summary(payload) {
    const { ok, events, error } = await this.events(payload);
    if (!ok) return { ok, error };
    const by = new Map();
    events.forEach((e) => {
      if (e.action !== 'out' || e.duration_hrs == null) return;
      const cur = by.get(e.id) || { id: e.id, name: e.name, hours: 0, sessions: 0 };
      cur.hours += Number(e.duration_hrs) || 0;
      cur.sessions += 1;
      by.set(e.id, cur);
    });
    const summary = [...by.values()].map((r) => ({ ...r, hours: +r.hours.toFixed(3) }));
    return { ok: true, summary };
  },

  async roster() {
    const { data, error } = await sb.from('staff')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true });
    if (error) return { ok: false, error: error.message };
    // Decorate each row with its current status (one query per agent — fine
    // for a small office; the table itself returned fast).
    const roster = await Promise.all((data || []).map(async (s) => {
      const st = await lastStatusFor(s.id);
      return {
        id: s.id, name: s.name, role: s.role || '', team: s.team || '',
        admin: !!s.is_admin,
        super: !!s.is_super,
        designation: s.designation || '',
        division: s.division || '',
        hourly_rate:  s.hourly_rate  != null ? Number(s.hourly_rate)  : null,
        weekly_hours: s.weekly_hours != null ? Number(s.weekly_hours) : null,
        status: st.status, lastIn: st.lastIn, lastOut: st.lastOut,
        lastNote: st.lastNote,
      };
    }));
    roster.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'in' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, roster };
  },

  async team_today() {
    const r = await this.roster();
    if (!r.ok) return r;
    const tRange = todayRange();
    const { data: todayEvents, error } = await sb.from('events')
      .select('staff_id, dir, duration_hrs, ts')
      .gte('ts', tRange.from).lte('ts', tRange.to);
    if (error) return { ok: false, error: error.message };
    const hrsBy = {};
    (todayEvents || []).forEach((e) => {
      if (e.dir === 'out' && e.duration_hrs != null) {
        hrsBy[e.staff_id] = (hrsBy[e.staff_id] || 0) + Number(e.duration_hrs);
      }
    });
    const now = Date.now();
    const team = r.roster.map((a) => {
      const liveBonus = (a.status === 'in' && a.lastIn)
        ? Math.max(0, (now - new Date(a.lastIn).getTime()) / 3.6e6) : 0;
      return {
        id: a.id, name: a.name, role: a.role, team: a.team,
        status: a.status,
        cin: a.status === 'in' ? fmtClockTime(a.lastIn) : '',
        note: a.status === 'in' ? a.lastNote : '',
        todayHrs: +((hrsBy[a.id] || 0) + liveBonus).toFixed(3),
      };
    });
    return { ok: true, team };
  },

  async leave_list(payload) {
    let q = sb.from('requests').select('*').order('created_at', { ascending: false });
    if (payload.agent_id) q = q.eq('staff_id', String(payload.agent_id).toLowerCase());
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    // Decorate with agent_name (cheap join via roster cache).
    const { data: roster } = await sb.from('staff').select('id, name');
    const nameById = new Map((roster || []).map((s) => [s.id, s.name]));
    const leave = (data || []).map((r) => ({
      id: r.id,
      ts: r.created_at,
      agent_id: r.staff_id,
      agent_name: nameById.get(r.staff_id) || '',
      type: r.type,
      start_date: r.start_date,
      end_date: r.end_date,
      days: Number(r.days || 1),
      reason: r.reason || '',
      proposed_start: r.proposed_start || '',
      proposed_end:   r.proposed_end || '',
      status: r.status,
      decided_by: r.decided_by || '',
      decided_ts: r.decided_at || '',
    }));
    return { ok: true, leave };
  },

  async leave_create(payload) {
    const id = String(payload.agent_id || '').toLowerCase();
    if (!id || !payload.type || !payload.start)
      return { ok: false, error: 'Missing agent_id/type/start' };
    const days = dayDiffBusiness(payload.start, payload.end || payload.start);
    const row = {
      staff_id: id,
      type: payload.type,
      start_date: payload.start,
      end_date: payload.end || payload.start,
      days,
      reason: payload.reason || '',
      status: 'Pending',
    };
    if (payload.proposed_start) row.proposed_start = payload.proposed_start;
    if (payload.proposed_end)   row.proposed_end   = payload.proposed_end;
    const { data, error } = await sb.from('requests').insert(row).select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data.id };
  },

  async leave_decide(payload) {
    const id = String(payload.id || '');
    const status = String(payload.status || '');
    if (!id || (status !== 'Approved' && status !== 'Declined'))
      return { ok: false, error: 'Need id + status(Approved|Declined)' };
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    const { error } = await sb.from('requests').update({
      status,
      decided_by: me.name,
      decided_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  // Admin PIN check translates to the same login flow (server verifies
  // is_admin via the staff row after sign-in).
  async admin_check(payload) {
    const r = await this.login({ username: payload.username || payload.id, pin: payload.pin });
    if (!r.ok) return r;
    if (!r.agent || !r.agent.admin) {
      await sb.auth.signOut(); clearSelf();
      return { ok: false, error: 'Not an admin' };
    }
    return { ok: true, admin: r.agent };
  },

  async locations() {
    return { ok: true, locations: [] }; // view was removed; keep stub for any legacy callers.
  },

  async roster_add(payload) {
    // Goes through the admin-create-staff Edge Function (needs service role
    // to create an auth.users row). Caller's JWT proves admin-ness.
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Not signed in' };
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin-create-staff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': CFG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        id: payload.id, name: payload.name, pin: payload.pin,
        role: payload.role || '', team: payload.team || '',
        admin: !!payload.admin, active: payload.active !== false,
        hourly_rate:  payload.hourly_rate ?? null,
        weekly_hours: payload.weekly_hours ?? null,
        is_super: !!payload.super,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.error || 'Could not create staff' };
    return { ok: true, agent: body.staff };
  },

  async staff_update(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    const id = String(payload.id || '').toLowerCase();
    if (!id) return { ok: false, error: 'Missing id' };
    const patch = {};
    if (payload.name != null)         patch.name = String(payload.name);
    if (payload.role != null)         patch.role = String(payload.role);
    if (payload.team != null)         patch.team = String(payload.team);
    if (payload.admin != null)        patch.is_admin = !!payload.admin;
    if (payload.super != null)        patch.is_super = !!payload.super;
    if (payload.active != null)       patch.active = String(payload.active).toLowerCase() !== 'false';
    if (payload.hourly_rate !== undefined)
      patch.hourly_rate = (payload.hourly_rate === '' || payload.hourly_rate == null) ? null : Number(payload.hourly_rate);
    if (payload.weekly_hours !== undefined)
      patch.weekly_hours = (payload.weekly_hours === '' || payload.weekly_hours == null) ? null : Number(payload.weekly_hours);
    if (payload.designation !== undefined) patch.designation = payload.designation || null;
    if (payload.division !== undefined)    patch.division    = payload.division || null;
    const { error } = await sb.from('staff').update(patch).eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  async roster_set_active(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    const id = String(payload.id || '').toLowerCase();
    const active = String(payload.active).toLowerCase() !== 'false';
    const { error } = await sb.from('staff').update({ active }).eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  async event_add(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    const dir = String(payload.dir || payload.action || '').toLowerCase();
    if (dir !== 'in' && dir !== 'out') return { ok: false, error: 'direction must be in|out' };
    const { error } = await sb.from('events').insert({
      staff_id: String(payload.agent_id).toLowerCase(),
      ts: payload.ts,
      dir,
      note: payload.note || '',
      duration_hrs: payload.duration_hrs == null || payload.duration_hrs === '' ? null : Number(payload.duration_hrs),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  async event_update(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    const patch = {};
    if (payload.new_ts) patch.ts = payload.new_ts;
    const newDir = payload.dir != null ? payload.dir : payload.action;
    if (newDir != null) {
      const d = String(newDir).toLowerCase();
      if (d !== 'in' && d !== 'out') return { ok: false, error: 'direction must be in|out' };
      patch.dir = d;
    }
    if (payload.note != null) patch.note = String(payload.note);
    if (payload.duration_hrs != null && payload.duration_hrs !== '')
      patch.duration_hrs = Number(payload.duration_hrs);

    // Identify the row by its UUID id (preferred), else by (staff_id, ts).
    let q = sb.from('events').update(patch);
    if (payload._event_id || payload.id) q = q.eq('id', payload._event_id || payload.id);
    else q = q.eq('staff_id', String(payload.agent_id).toLowerCase()).eq('ts', payload.ts);
    const { error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  async event_delete(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    let q = sb.from('events').delete();
    if (payload._event_id || payload.id) q = q.eq('id', payload._event_id || payload.id);
    else q = q.eq('staff_id', String(payload.agent_id).toLowerCase()).eq('ts', payload.ts);
    const { error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  // Clock-out report (LN / Assistant). Insert is gated by RLS — only the
  // signed-in staff member can insert their own row (or an admin).
  async clock_out_report_submit(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me) return { ok: false, error: 'Not signed in' };
    const row = {
      staff_id: payload.staff_id || me.id,
      designation: payload.designation || me.designation || '',
      division: payload.division || me.division || '',
      hs_tasks_completed:    +payload.hs_tasks_completed    || 0,
      hs_calls_made:         +payload.hs_calls_made         || 0,
      hs_emails_sent:        +payload.hs_emails_sent        || 0,
      hs_whatsapps_sent:     +payload.hs_whatsapps_sent     || 0,
      hs_answered_contacts:  +payload.hs_answered_contacts  || 0,
      hs_leads_vals:         +payload.hs_leads_vals         || 0,
      hs_reconverted_leads:  +payload.hs_reconverted_leads  || 0,
      df_calls:              +payload.df_calls              || 0,
      df_email_successes:    +payload.df_email_successes    || 0,
      df_leads_vals:         +payload.df_leads_vals         || 0,
      df_hours:              +payload.df_hours              || 0,
      wa_sent:               +payload.wa_sent               || 0,
      wa_responses:          +payload.wa_responses          || 0,
      wa_leads_vals:         +payload.wa_leads_vals         || 0,
      notes:                 String(payload.notes || ''),
    };
    const { data, error } = await sb.from('clock_out_reports')
      .insert(row).select('*').single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, report: data };
  },

  // Fetch all reports (admins / managers). Pages of 200 newest-first.
  async clock_out_reports_list(payload = {}) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    let q = sb.from('clock_out_reports').select('*')
      .order('clocked_out_at', { ascending: false })
      .limit(Math.min(500, Math.max(1, +payload.limit || 200)));
    if (payload.from) q = q.gte('clocked_out_at', payload.from);
    if (payload.to)   q = q.lte('clocked_out_at', payload.to);
    if (payload.staff_id) q = q.eq('staff_id', payload.staff_id);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, reports: data || [] };
  },
};

// ─── public API ─────────────────────────────────────────────────────
async function call(action, payload = {}) {
  const fn = handlers[action];
  if (!fn) return { ok: false, error: 'Unknown action: ' + action };
  try { return await fn.call(handlers, payload); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

window.QD = {
  call,
  getSelfStaff: () => _selfStaff,
  loadSelfStaff,
  clearSelf,
  emailFor,
  client: sb,
};

})();
