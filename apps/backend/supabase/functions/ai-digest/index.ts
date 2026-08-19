/**
 * POST /ai-digest
 *
 * Body: { "kind": "weekly-review" | "thesis-check" | "note-patterns" }
 * Auth: the caller's Supabase JWT in `Authorization: Bearer <token>`.
 *
 * Thin transport wrapper only — every decision lives in _shared/ai/handler.ts,
 * which is unit-tested against a fake store and a fake provider stream. This file
 * reads env, identifies the caller, and shapes the response.
 *
 * The assistant behind this endpoint is a research assistant and journal, not a
 * stock picker: it summarises against theses the user wrote, flags exit
 * conditions the user wrote, drafts a digest, and notices repetition. See
 * _shared/ai/system_prompt.ts.
 */

import { handleDigest, EmptyDigestError, EmptyGroundingError } from "../_shared/ai/handler.ts";
import { DisclosureNotAcceptedError } from "../_shared/ai/disclosure.ts";
import {
  ModelNotInstalledError,
  type Provider,
  ProviderConfigError,
  ProviderError,
  providerFromEnv,
} from "../_shared/ai/providers.ts";
import { PostgrestDigestStore } from "../_shared/ai/store.ts";
import { DIGEST_KINDS, type DigestKind } from "../_shared/ai/types.ts";

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
 * request body — the store runs with the service role, so a client that could
 * name its own user id could have anyone's journal summarised back to it.
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

  let payload: { kind?: string };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const kind = payload.kind ?? "";
  if (!(DIGEST_KINDS as readonly string[]).includes(kind)) {
    return json({ error: `unknown kind "${kind}"`, kinds: DIGEST_KINDS }, 400);
  }

  const userId = await resolveCaller(supabaseUrl, anonKey, authHeader);
  if (userId === null) return json({ error: "invalid token" }, 401);

  // Provider selection is env-only and defaults to the local Ollama, so a dev
  // clone with no configuration works and never needs a paid key.
  let provider: Provider;
  try {
    provider = providerFromEnv({
      AI_PROVIDER: Deno.env.get("AI_PROVIDER"),
      AI_MODEL: Deno.env.get("AI_MODEL"),
      OLLAMA_BASE_URL: Deno.env.get("OLLAMA_BASE_URL"),
      ANTHROPIC_API_KEY: Deno.env.get("ANTHROPIC_API_KEY"),
      ANTHROPIC_BASE_URL: Deno.env.get("ANTHROPIC_BASE_URL"),
    });
  } catch (error) {
    // The message names the missing variable, never its value.
    console.error("ai provider is misconfigured", error);
    return json({ error: "ai provider is not configured" }, 500);
  }

  const store = new PostgrestDigestStore(supabaseUrl, serviceRoleKey);

  try {
    const result = await handleDigest(userId, { kind: kind as DigestKind, store, provider });
    return json(result);
  } catch (error) {
    if (error instanceof DisclosureNotAcceptedError) {
      return json({
        error: error.message,
        code: "disclosure_required",
        requiredVersion: error.requiredVersion,
        acceptedVersion: error.acceptedVersion,
      }, 403);
    }
    if (error instanceof EmptyGroundingError) {
      return json({ error: error.message, code: "empty_journal" }, 422);
    }
    if (error instanceof ModelNotInstalledError) {
      // Actionable and operator-facing: it names a model, not a credential.
      return json({ error: error.message, code: "model_not_installed" }, 503);
    }
    if (error instanceof EmptyDigestError) {
      return json({ error: error.message, code: "empty_response" }, 502);
    }
    if (error instanceof ProviderError || error instanceof ProviderConfigError) {
      console.error("digest provider failed", error);
      return json({ error: "the model provider failed", code: "provider_failed" }, 502);
    }
    console.error("digest failed", error);
    return json({ error: "digest failed" }, 500);
  }
});
