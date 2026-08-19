/**
 * The database seam for alert delivery.
 *
 * Same pattern as _shared/ingest/store.ts and _shared/quotes/store.ts: the
 * delivery logic in handler.ts is written against this interface so the
 * interesting decisions — what gets stamped, what gets retried, what gets given
 * up on — are unit-testable against a fake.
 *
 * Every method maps to one of the SECURITY DEFINER functions the migrations
 * expose to `service_role`. The worker never touches `jobs` or `alert_events`
 * directly, so their column shapes stay free to change.
 */

import type { AlertChannel, AlertDelivery, JobKind } from "./types.ts";

export interface ClaimedJob {
  id: number;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface AlertJobStore {
  /** claim_job(): one ready job, or null when the queue is dry. */
  claim(workerId: string, kind: JobKind): Promise<ClaimedJob | null>;
  /** alert_delivery(): the event, the recipient, and the per-channel stamps. */
  loadDelivery(alertEventId: string, channel: AlertChannel): Promise<AlertDelivery | null>;
  /** stamp_alert_delivery(): called only after a send succeeded. */
  stampDelivered(alertEventId: string, channel: AlertChannel): Promise<void>;
  finish(jobId: number, status: "done" | "failed", error?: string): Promise<void>;
  defer(jobId: number, delaySeconds: number, error?: string): Promise<void>;
}

interface DeliveryRow {
  alert_event_id: string;
  user_id: string;
  fired_at: string;
  context: Record<string, unknown> | null;
  push_sent_at: string | null;
  email_sent_at: string | null;
  email: string | null;
  push_tokens: string[] | null;
}

/** PostgREST/RPC-backed implementation. Service role only. */
export class PostgrestAlertJobStore implements AlertJobStore {
  readonly #rest: string;
  readonly #serviceRoleKey: string;
  readonly #fetch: typeof fetch;

  constructor(supabaseUrl: string, serviceRoleKey: string, fetchImpl: typeof fetch = fetch) {
    this.#rest = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
    this.#serviceRoleKey = serviceRoleKey;
    this.#fetch = fetchImpl;
  }

  async #rpc(name: string, args: Record<string, unknown>, context: string): Promise<unknown> {
    const response = await this.#fetch(`${this.#rest}/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: this.#serviceRoleKey,
        Authorization: `Bearer ${this.#serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message ?? parsed.hint ?? text;
      } catch {
        // non-JSON body — use it as-is
      }
      throw new Error(`${context}: ${response.status} ${detail}`);
    }

    if (text.trim() === "") return null;
    return JSON.parse(text);
  }

  async claim(workerId: string, kind: JobKind): Promise<ClaimedJob | null> {
    const rows = await this.#rpc(
      "claim_job",
      { p_worker_id: workerId, p_kind: kind },
      "claiming a delivery job",
    ) as Array<{ id: number; kind: JobKind; payload: Record<string, unknown>; attempts: number }>;

    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0];
  }

  async loadDelivery(alertEventId: string, channel: AlertChannel): Promise<AlertDelivery | null> {
    const rows = await this.#rpc(
      "alert_delivery",
      { p_alert_event_id: alertEventId },
      "loading an alert delivery",
    ) as DeliveryRow[];

    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];

    return {
      alertEventId: row.alert_event_id,
      userId: row.user_id,
      channel,
      firedAt: row.fired_at,
      context: row.context ?? {},
      alreadySent: (channel === "push" ? row.push_sent_at : row.email_sent_at) !== null,
      email: row.email,
      pushTokens: row.push_tokens ?? [],
    };
  }

  async stampDelivered(alertEventId: string, channel: AlertChannel): Promise<void> {
    await this.#rpc(
      "stamp_alert_delivery",
      { p_alert_event_id: alertEventId, p_channel: channel },
      "stamping an alert delivery",
    );
  }

  async finish(jobId: number, status: "done" | "failed", error?: string): Promise<void> {
    await this.#rpc(
      "finish_job",
      { p_job_id: jobId, p_status: status, p_error: error ?? null },
      "finishing a delivery job",
    );
  }

  async defer(jobId: number, delaySeconds: number, error?: string): Promise<void> {
    await this.#rpc(
      "defer_job",
      { p_job_id: jobId, p_delay_seconds: delaySeconds, p_error: error ?? null },
      "deferring a delivery job",
    );
  }
}
