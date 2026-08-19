/**
 * POST /import-transactions
 *
 * Body: { "source": "robinhood-csv", "content": "<the CSV text>" }
 * Auth: the caller's Supabase JWT in `Authorization: Bearer <token>`.
 *
 * Thin transport wrapper only — every decision lives in _shared/ingest/handler.ts,
 * which is unit-tested against a fake store. This file reads env, identifies the
 * caller, and shapes the response.
 */

import { handleImport, UnsupportedSourceError } from "../_shared/ingest/handler.ts";
import { PostgrestLedgerStore } from "../_shared/ingest/store.ts";
import { INGEST_SOURCES, type IngestSource } from "../_shared/ingest/types.ts";

/** A year of Robinhood activity is well under this; the cap is anti-abuse. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

/**
 * Resolve the caller from their own token. The user id is never taken from the
 * request body — a client that could name its own user id could write anyone's
 * ledger, since ingest itself runs with the service role.
 */
async function resolveCaller(
  supabaseUrl: string,
  anonKey: string,
  authHeader: string,
): Promise<string | null> {
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authHeader },
  });
  if (!response.ok) return null;

  const user = await response.json() as { id?: string };
  return typeof user.id === "string" && user.id !== "" ? user.id : null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ error: "missing bearer token" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: "function is not configured" }, 500);
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json({ error: "file too large" }, 413);

  let payload: { source?: string; content?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const source = payload.source ?? "";
  if (!(INGEST_SOURCES as readonly string[]).includes(source)) {
    return json({ error: `unknown source "${source}"` }, 400);
  }
  if (typeof payload.content !== "string" || payload.content.trim() === "") {
    return json({ error: "content is required" }, 400);
  }

  const userId = await resolveCaller(supabaseUrl, anonKey, authHeader);
  if (userId === null) return json({ error: "invalid token" }, 401);

  const store = new PostgrestLedgerStore(supabaseUrl, serviceRoleKey);

  try {
    const result = await handleImport(userId, source as IngestSource, payload.content, store);
    return json(result);
  } catch (error) {
    if (error instanceof UnsupportedSourceError) return json({ error: error.message }, 400);
    console.error("import failed", error);
    return json({ error: "import failed" }, 500);
  }
});
