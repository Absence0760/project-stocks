/**
 * POST /deliver-alerts
 *
 * Body: none. Auth: the service role key in `Authorization: Bearer <key>`.
 *
 * Drains one pass of the delivery queue: claims alert_push / alert_email jobs,
 * sends them, stamps what was delivered. Thin transport wrapper only — every
 * decision lives in _shared/alerts/handler.ts, unit-tested against fakes.
 *
 * Deliberately *not* scheduled from pg_cron. Invoking an edge function from the
 * database means storing a service-role key inside the database for pg_net to
 * present, and a standing credential in a table is a real secret in a place this
 * project does not put secrets. The scheduler is the deployment's job (a
 * platform cron hitting this endpoint with the key from the secret store);
 * locally, `pnpm dev:alerts:deliver` runs a pass by hand.
 */

import { runDeliveryPass } from "../_shared/alerts/handler.ts";
import { PostgrestAlertJobStore } from "../_shared/alerts/store.ts";
import { createSenders, SenderConfigError } from "../_shared/alerts/senders.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function secretsMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < presented.length; i++) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "function is not configured" }, 500);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const presented = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!secretsMatch(presented, serviceRoleKey)) {
    return json({ error: "service role key required" }, 401);
  }

  let senders;
  try {
    senders = createSenders((key) => Deno.env.get(key));
  } catch (error) {
    if (error instanceof SenderConfigError) return json({ error: error.message }, 500);
    throw error;
  }

  const store = new PostgrestAlertJobStore(supabaseUrl, serviceRoleKey);
  // Identifies the lock holder in jobs.locked_by, so a stuck job names its worker.
  const workerId = `deliver-alerts:${crypto.randomUUID().slice(0, 8)}`;

  try {
    return json(await runDeliveryPass(store, senders, { workerId }));
  } catch (error) {
    console.error("alert delivery failed", error);
    return json({ error: "alert delivery failed" }, 500);
  }
});
