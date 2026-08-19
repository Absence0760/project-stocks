/**
 * POST /refresh-quotes
 *
 * Body: none. Auth: the service role key in `Authorization: Bearer <key>`.
 *
 * Prices every instrument anyone holds and upserts the results into `quotes`.
 * Thin transport wrapper only — every decision lives in
 * _shared/quotes/refresh.ts, which is unit-tested against a fake store and a
 * fake provider. This file reads env, checks the caller, and shapes the response.
 *
 * Service role rather than a user JWT on purpose: the refresh is global (two
 * users holding AAPL are one price to fetch) and it spends a rate-limited API
 * quota, so it is not something any signed-in client gets to trigger.
 */

import { createQuoteProvider } from "../_shared/quotes/provider.ts";
import { PostgrestQuoteStore } from "../_shared/quotes/store.ts";
import { refreshQuotes } from "../_shared/quotes/refresh.ts";
import { QuoteProviderConfigError } from "../_shared/quotes/types.ts";

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
 * Length-independent comparison, so a wrong key cannot be recovered a byte at a
 * time from response timing.
 */
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
  const presented = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!secretsMatch(presented, serviceRoleKey)) {
    return json({ error: "service role key required" }, 401);
  }

  let provider;
  try {
    provider = createQuoteProvider((key) => Deno.env.get(key));
  } catch (error) {
    if (error instanceof QuoteProviderConfigError) return json({ error: error.message }, 500);
    throw error;
  }

  const store = new PostgrestQuoteStore(supabaseUrl, serviceRoleKey);

  try {
    return json(await refreshQuotes(store, provider));
  } catch (error) {
    console.error("quote refresh failed", error);
    return json({ error: "quote refresh failed" }, 500);
  }
});
