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
    // PostgREST caps unbounded selects at 1000 rows. A full pay cycle can
    // exceed that (~50 events/day × 31 days ≈ 1500), so paginate until done.
    const PAGE = 1000;
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      let q = sb.from('events')
        .select('id, ts, staff_id, dir, note, duration_hrs, staff:staff_id(name)')
        .gte('ts', w).lte('ts', e)
        .order('ts', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (payload.agent_id) q = q.eq('staff_id', String(payload.agent_id).toLowerCase());
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      if (!data || !data.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    const events = rows.map((r) => ({
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

  async roster(payload = {}) {
    // include_inactive=true returns archived (active=false) staff as well,
    // used by the admin Team page so admins can unarchive someone. Defaults
    // to false so PWA / dashboard surfaces never see disabled accounts.
    let q = sb.from('staff').select('*').order('name', { ascending: true });
    if (!payload.include_inactive) q = q.eq('active', true);
    const { data, error } = await q;
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
        active: s.active !== false,
        status: st.status, lastIn: st.lastIn, lastOut: st.lastOut,
        lastNote: st.lastNote,
      };
    }));
    roster.sort((a, b) => {
      // Archived rows always sink to the bottom regardless of clock status.
      if (a.active !== b.active) return a.active ? -1 : 1;
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
    // Enrich each request with the staff's ACTUAL clock events on the
    // shift date so the admin reviewer sees "original 08:15 → proposed
    // 08:00" instead of just the proposed time. Batched into ONE events
    // query keyed by staff_id (per-day filter happens client-side).
    const reqs = data || [];
    const staffIds = [...new Set(reqs.map(r => r.staff_id))];
    let eventsByStaff = new Map();
    if (staffIds.length) {
      // Pull a wide-enough window covering every requested date.
      const dates = reqs.map(r => r.start_date).filter(Boolean).sort();
      const fromIso = dates.length ? new Date(dates[0] + 'T00:00:00').toISOString() : null;
      const toIso   = dates.length
        ? new Date(new Date(dates[dates.length - 1] + 'T00:00:00').getTime() + 24 * 3600 * 1000).toISOString()
        : null;
      if (fromIso && toIso) {
        const { data: evs } = await sb.from('events')
          .select('staff_id, ts, dir')
          .in('staff_id', staffIds)
          .gte('ts', fromIso).lt('ts', toIso)
          .order('ts', { ascending: true });
        (evs || []).forEach(e => {
          const key = `${e.staff_id}|${String(e.ts).slice(0, 10)}`;
          if (!eventsByStaff.has(key)) eventsByStaff.set(key, []);
          eventsByStaff.get(key).push(e);
        });
      }
    }
    const findOriginal = (staffId, date, dir) => {
      const arr = eventsByStaff.get(`${staffId}|${date}`) || [];
      const ev = dir === 'in'
        ? arr.find(e => e.dir === 'in')
        : [...arr].reverse().find(e => e.dir === 'out');
      return ev ? ev.ts : '';
    };
    const leave = reqs.map((r) => ({
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
      // ISO timestamps of the agent's actual first IN / last OUT events
      // on the request's shift date — used by the admin review UI.
      original_in:  findOriginal(r.staff_id, r.start_date, 'in'),
      original_out: findOriginal(r.staff_id, r.start_date, 'out'),
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
        designation: payload.designation ?? null,
        division:    payload.division    ?? null,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.error || 'Could not create staff' };
    return { ok: true, agent: body.staff };
  },

  async staff_set_pin(payload) {
    // Goes through the admin-set-pin Edge Function (service-role required to
    // update an auth.users password). Caller's JWT proves super-ness server-side.
    const id  = String(payload.id || '').toLowerCase().trim();
    const pin = String(payload.pin || '').trim();
    if (!id)  return { ok: false, error: 'Missing id' };
    if (!/^\d+$/.test(pin) || pin.length < 6) {
      return { ok: false, error: 'PIN must be 6 digits' };
    }
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { ok: false, error: 'Not signed in' };
    const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin-set-pin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': CFG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ id, pin }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.error || 'Could not reset PIN' };
    return { ok: true };
  },

  async staff_update(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me || !me.is_admin) return { ok: false, error: 'Admin access required' };
    const id = String(payload.id || '').toLowerCase();
    if (!id) return { ok: false, error: 'Missing id' };

    // Rate changes land in staff_rate_history (dated audit row) AND in
    // staff.hourly_rate (denormalised current-rate cache). Both writes
    // happen as the calling user — RLS on staff_rate_history + staff
    // gates both to admins. No SECURITY DEFINER, no RPC. If either write
    // fails, we surface the error and stop.
    //
    // Caller can pass `rate_effective_from` (YYYY-MM-DD) to backfill an
    // older date; default is the local 'today'. We only update the
    // denormalised cache if the new effective_from is the latest known
    // for this staff, so a backfilled historical edit can't clobber the
    // current rate.
    if (payload.hourly_rate !== undefined) {
      const newRate = (payload.hourly_rate === '' || payload.hourly_rate == null)
        ? null
        : Number(payload.hourly_rate);
      if (newRate != null) {
        // Local YYYY-MM-DD so 'today' matches the admin form, not UTC.
        const _d = new Date();
        const _todayYmd = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
        const effective = payload.rate_effective_from || _todayYmd;

        // 1. Upsert the audit row. Idempotent on (staff_id, effective_from)
        //    so re-saving the same date overwrites the rate in place
        //    instead of duplicating.
        const { error: histErr } = await sb
          .from('staff_rate_history')
          .upsert(
            {
              staff_id: id,
              hourly_rate: newRate,
              effective_from: effective,
              reason: payload.rate_reason || '',
              changed_by: me.id,
            },
            { onConflict: 'staff_id,effective_from' }
          );
        if (histErr) return { ok: false, error: histErr.message };

        // 2. Check whether this is the latest effective_from for the
        //    staffer. If yes, sync the cache on staff.hourly_rate so
        //    surfaces that read it directly stay correct.
        const { data: latest, error: latestErr } = await sb
          .from('staff_rate_history')
          .select('effective_from')
          .eq('staff_id', id)
          .order('effective_from', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestErr) return { ok: false, error: latestErr.message };
        if (latest && latest.effective_from === effective) {
          const { error: cacheErr } = await sb
            .from('staff').update({ hourly_rate: newRate }).eq('id', id);
          if (cacheErr) return { ok: false, error: cacheErr.message };
        }
      } else {
        // Clearing the rate just blanks the cache; no history row.
        const { error } = await sb.from('staff').update({ hourly_rate: null }).eq('id', id);
        if (error) return { ok: false, error: error.message };
      }
    }

    const patch = {};
    if (payload.name != null)         patch.name = String(payload.name);
    if (payload.role != null)         patch.role = String(payload.role);
    if (payload.team != null)         patch.team = String(payload.team);
    if (payload.admin != null)        patch.is_admin = !!payload.admin;
    if (payload.super != null)        patch.is_super = !!payload.super;
    if (payload.active != null)       patch.active = String(payload.active).toLowerCase() !== 'false';
    if (payload.weekly_hours !== undefined)
      patch.weekly_hours = (payload.weekly_hours === '' || payload.weekly_hours == null) ? null : Number(payload.weekly_hours);
    if (payload.designation !== undefined) patch.designation = payload.designation || null;
    if (payload.division !== undefined)    patch.division    = payload.division || null;
    if (Object.keys(patch).length) {
      const { error } = await sb.from('staff').update(patch).eq('id', id);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  },

  // Read the full rate history for one staff member — used by the admin
  // Team card to surface the audit trail next to the current rate.
  async staff_rate_history(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me) return { ok: false, error: 'Not signed in' };
    const id = String(payload.id || '').toLowerCase();
    if (!id) return { ok: false, error: 'Missing id' };
    const { data, error } = await sb
      .from('staff_rate_history')
      .select('hourly_rate, effective_from, reason, changed_by, created_at')
      .eq('staff_id', id)
      .order('effective_from', { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, history: data || [] };
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
    const staffId = String(payload.agent_id).toLowerCase();
    // Auto-compute duration_hrs when adding an OUT that pairs with the
    // most recent IN before ts. Without this, grid + summary surfaces
    // that key off duration_hrs read the manual shift as 0 hours and
    // show "No show".
    let durationHrs = payload.duration_hrs == null || payload.duration_hrs === ''
      ? null : Number(payload.duration_hrs);
    if (durationHrs == null && dir === 'out') {
      const { data: prev } = await sb.from('events')
        .select('ts, dir')
        .eq('staff_id', staffId)
        .lt('ts', payload.ts)
        .order('ts', { ascending: false })
        .limit(1);
      const lastIn = (prev && prev[0] && prev[0].dir === 'in') ? prev[0].ts : null;
      if (lastIn) {
        const hrs = (new Date(payload.ts) - new Date(lastIn)) / 3.6e6;
        if (hrs > 0 && hrs < 24) durationHrs = +hrs.toFixed(3);
      }
    }
    const { error } = await sb.from('events').insert({
      staff_id: staffId,
      ts: payload.ts,
      dir,
      note: payload.note || '',
      duration_hrs: durationHrs,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, duration_hrs: durationHrs };
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

  // Self-service "I forgot to clock out" corrective event. Inserts a
  // dir=out event with a custom past timestamp. RLS allows this
  // because events_insert_self matches the caller's own staff_id.
  async clock_correction(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me) return { ok: false, error: 'Not signed in' };
    const ts = payload.ts || new Date().toISOString();
    const { error } = await sb.from('events').insert({
      staff_id: me.id,
      ts,
      dir: 'out',
      note: payload.note || 'Forgot to clock out — corrected',
    });
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

  // Mark a staff member absent across a date range. Inserts one
  // absences row per calendar day; idempotent on (staff_id, date) so
  // re-running over an overlapping range just bumps the reason in place
  // instead of duplicating. RLS gates writes to admin/super/manager.
  async absences_mark(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me) return { ok: false, error: 'Not signed in' };
    const isPriv = me.is_admin || me.is_super
      || (me.designation || '').toLowerCase() === 'manager'
      || (me.designation || '').toLowerCase() === 'super_admin';
    if (!isPriv) return { ok: false, error: 'Admin / manager access required' };

    const staffId = String(payload.staff_id || '').toLowerCase();
    const fromYmd = String(payload.from_date || '');
    const toYmd   = String(payload.to_date   || payload.from_date || '');
    const reason  = String(payload.reason || '').trim();
    const note    = payload.reason_note != null ? String(payload.reason_note) : '';
    if (!staffId) return { ok: false, error: 'Missing staff_id' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(toYmd))
      return { ok: false, error: 'Dates must be YYYY-MM-DD' };
    if (!reason) return { ok: false, error: 'Reason required' };
    if (toYmd < fromYmd) return { ok: false, error: 'End date must be on or after start date' };

    // Expand to one row per day, capped at 60 to stop accidental
    // century-spanning ranges from creating thousands of rows.
    const rows = [];
    const start = new Date(fromYmd + 'T12:00:00Z');
    const end   = new Date(toYmd   + 'T12:00:00Z');
    const MAX_DAYS = 60;
    for (let d = new Date(start), i = 0; d <= end && i < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      rows.push({
        staff_id: staffId,
        date: `${y}-${m}-${day}`,
        reason,
        reason_note: note || null,
        marked_by: me.id,
      });
    }
    if (!rows.length) return { ok: false, error: 'No dates in range' };

    // Idempotent upsert keyed on (staff_id, date) — the unique constraint
    // means re-marking the same day overwrites the reason instead of
    // failing the whole batch.
    const { data, error } = await sb
      .from('absences')
      .upsert(rows, { onConflict: 'staff_id,date' })
      .select('staff_id, date, reason, reason_note, marked_by');
    if (error) return { ok: false, error: error.message };
    return { ok: true, absences: data || [], count: (data || []).length };
  },

  // Clear an absence row by (staff_id, date). Used by the admin
  // 'unmark' affordance when a manager flagged someone in error.
  async absence_clear(payload) {
    const me = _selfStaff || await loadSelfStaff();
    if (!me) return { ok: false, error: 'Not signed in' };
    const isPriv = me.is_admin || me.is_super
      || (me.designation || '').toLowerCase() === 'manager'
      || (me.designation || '').toLowerCase() === 'super_admin';
    if (!isPriv) return { ok: false, error: 'Admin / manager access required' };
    const staffId = String(payload.staff_id || '').toLowerCase();
    const date    = String(payload.date || '');
    if (!staffId || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return { ok: false, error: 'Missing staff_id / date' };
    const { error } = await sb.from('absences')
      .delete().eq('staff_id', staffId).eq('date', date);
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
