// Quay 1 — admin-create-staff Edge Function
// ============================================================
// Atomically:
//   1. Creates a new auth.users row (synthetic email + the PIN as password)
//   2. Inserts the matching public.staff row
// Caller must be an admin (verified via the caller's JWT + the staff table).
//
// Deploy: Supabase dashboard → Edge Functions → Create function →
// name it "admin-create-staff" → paste this file's contents → deploy.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface Body {
  id: string;
  name: string;
  pin: string;
  role?: string;
  team?: string;
  admin?: boolean;
  active?: boolean;
  hourly_rate?: number | string | null;
  weekly_hours?: number | string | null;
  is_super?: boolean;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerJwt       = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!callerJwt) return json({ ok: false, error: "Missing auth header" }, 401);

  // 1. Verify caller is a SUPERUSER (only supers can create staff).
  const callerClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
    auth: { persistSession: false },
  });
  const { data: callerStaff, error: callerErr } = await callerClient
    .from("staff")
    .select("id, is_admin, is_super")
    .eq("auth_user_id", (await callerClient.auth.getUser()).data.user?.id ?? "")
    .single();
  if (callerErr || !callerStaff?.is_super) {
    return json({ ok: false, error: "Superuser access required to add staff" }, 403);
  }

  // 2. Read + validate body.
  let body: Body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const id   = slugify(body.id || body.name);
  const name = (body.name || "").trim();
  const pin  = String(body.pin || "").trim();
  if (!id)            return json({ ok: false, error: "username (id) is required" }, 400);
  if (!name)          return json({ ok: false, error: "name is required" }, 400);
  if (pin.length < 4) return json({ ok: false, error: "PIN must be 4+ digits" }, 400);

  const email = `${id}@quay1.local`;

  // 3. Admin client for the write.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Uniqueness checks (server-side; RLS would also catch the staff dup).
  const { data: existing } = await admin.from("staff").select("id").eq("id", id).maybeSingle();
  if (existing) return json({ ok: false, error: `Username "${id}" is already taken.` }, 409);

  // 4. Create the auth user.
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
    user_metadata: { username: id, name },
  });
  if (authErr || !authData.user) {
    return json({ ok: false, error: authErr?.message || "Auth user creation failed" }, 500);
  }

  // 5. Insert the staff row.
  const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
  const { error: staffErr } = await admin.from("staff").insert({
    id,
    auth_user_id: authData.user.id,
    name,
    role: body.role ?? "",
    team: body.team ?? "",
    is_admin: !!body.admin,
    is_super: !!body.is_super,
    active: body.active === false ? false : true,
    hourly_rate:  num(body.hourly_rate),
    weekly_hours: num(body.weekly_hours),
  });
  if (staffErr) {
    // Best-effort rollback of the auth user so we don't leak orphans.
    await admin.auth.admin.deleteUser(authData.user.id);
    return json({ ok: false, error: staffErr.message }, 500);
  }

  return json({ ok: true, staff: { id, name, role: body.role ?? "", team: body.team ?? "", is_admin: !!body.admin } });
});

function slugify(raw: string): string {
  return String(raw || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...CORS },
  });
}
