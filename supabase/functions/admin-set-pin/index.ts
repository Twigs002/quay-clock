// Quay 1 — admin-set-pin Edge Function
// ============================================================
// Resets a staff member's login PIN.
//   1. Verifies the caller is a SUPERUSER (via JWT + staff table).
//   2. Looks up the target staff row to get its auth_user_id.
//   3. Calls auth.admin.updateUserById() with the new PIN as the password.
//
// Deploy: Supabase dashboard → Edge Functions → Create function →
// name it "admin-set-pin" → paste this file's contents → deploy.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface Body {
  id: string;   // target staff id (username)
  pin: string;  // new 4+ digit PIN
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerJwt      = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!callerJwt) return json({ ok: false, error: "Missing auth header" }, 401);

  // 1. Verify caller is a SUPERUSER.
  const callerClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
    auth: { persistSession: false },
  });
  const callerUserId = (await callerClient.auth.getUser()).data.user?.id ?? "";
  const { data: callerStaff, error: callerErr } = await callerClient
    .from("staff")
    .select("id, is_admin, is_super")
    .eq("auth_user_id", callerUserId)
    .single();
  if (callerErr || !callerStaff?.is_super) {
    return json({ ok: false, error: "Superuser access required to reset PINs" }, 403);
  }

  // 2. Read + validate body.
  let body: Body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const id  = String(body.id || "").toLowerCase().trim();
  const pin = String(body.pin || "").trim();
  if (!id)            return json({ ok: false, error: "Target id is required" }, 400);
  if (!/^\d+$/.test(pin) || pin.length < 4) {
    return json({ ok: false, error: "PIN must be 4+ digits" }, 400);
  }

  // 3. Look up the target staff row to get auth_user_id.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: target, error: targetErr } = await admin
    .from("staff")
    .select("id, name, auth_user_id")
    .eq("id", id)
    .maybeSingle();
  if (targetErr) return json({ ok: false, error: targetErr.message }, 500);
  if (!target)   return json({ ok: false, error: `No staff member with id "${id}"` }, 404);
  if (!target.auth_user_id) {
    return json({ ok: false, error: `"${id}" has no linked auth user` }, 500);
  }

  // 4. Reset the password (= PIN).
  const { error: updErr } = await admin.auth.admin.updateUserById(target.auth_user_id, {
    password: pin,
  });
  if (updErr) return json({ ok: false, error: updErr.message }, 500);

  return json({ ok: true, id: target.id, name: target.name });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...CORS },
  });
}
