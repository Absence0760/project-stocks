/**
 * The database seam for an import.
 *
 * The import logic in handler.ts is written against this interface rather than
 * against supabase-js directly, so the interesting decisions (which rows survive,
 * what gets reported, whether recompute runs) are unit-testable without a live
 * database or a hand-built fake of a fluent query builder.
 */

import type { IngestSource, NormalizedTransaction } from "./types.ts";

export interface RunCounts {
  rowsSeen: number;
  rowsImported: number;
  rowsSkipped: number;
}

export interface LedgerStore {
  /** Resolve tickers to instrument ids, creating rows for any that are new. */
  resolveInstruments(symbols: string[]): Promise<Map<string, string>>;
  startRun(userId: string, source: IngestSource): Promise<string>;
  /**
   * Insert ledger rows, ignoring any whose (user, source, external_id) already
   * exists. Returns the number actually written — re-importing an overlapping
   * export should report 0.
   */
  insertTransactions(
    userId: string,
    runId: string,
    source: IngestSource,
    rows: Array<NormalizedTransaction & { instrumentId: string }>,
  ): Promise<number>;
  finishRun(runId: string, status: "succeeded" | "failed", counts: RunCounts, error?: string): Promise<void>;
  recompute(userId: string): Promise<void>;
}

/**
 * PostgREST-backed implementation.
 *
 * Deliberately plain `fetch` rather than supabase-js: this store needs five
 * operations, and pulling the SDK into a Deno edge function drags in npm
 * resolution, a node_modules directory under apps/backend, and — because Deno
 * "migrates" any pnpm-workspace.yaml it finds nearby — an unwanted `workspaces`
 * field written into the root package.json on every run. That is the same
 * dual-workspace drift docs/STACK.md forbids, so the dependency is not worth it.
 *
 * Runs with the service role: ingest creates `instruments` rows, which clients
 * have no privilege to write. The user id is always supplied by the caller from
 * a verified token, so this never widens beyond that user.
 */
export class PostgrestLedgerStore implements LedgerStore {
  private readonly rest: string;

  constructor(supabaseUrl: string, private readonly serviceRoleKey: string) {
    this.rest = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request(url: string, init: RequestInit, context: string): Promise<unknown> {
    const response = await fetch(url, init);
    const text = await response.text();

    if (!response.ok) {
      // PostgREST returns a JSON error body; surface its message, not the whole blob.
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message ?? parsed.hint ?? text;
      } catch {
        // non-JSON body — use it as-is
      }
      throw new Error(`${context}: ${response.status} ${detail}`);
    }

    if (text.trim() === "") return [];
    return JSON.parse(text);
  }

  async resolveInstruments(symbols: string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
    const resolved = new Map<string, string>();
    if (wanted.length === 0) return resolved;

    // PostgREST `in.(...)` needs each value quoted so commas or spaces can't split it.
    const list = wanted.map((s) => `"${s}"`).join(",");
    const existing = await this.request(
      `${this.rest}/instruments?select=id,symbol&symbol=in.(${encodeURIComponent(list)})`,
      { headers: this.headers() },
      "resolving instruments",
    ) as Array<{ id: string; symbol: string }>;

    for (const row of existing) resolved.set(row.symbol.toUpperCase(), row.id);

    const missing = wanted.filter((s) => !resolved.has(s));
    if (missing.length === 0) return resolved;

    const created = await this.request(
      `${this.rest}/instruments?select=id,symbol`,
      {
        method: "POST",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify(missing.map((symbol) => ({ symbol }))),
      },
      "creating instruments",
    ) as Array<{ id: string; symbol: string }>;

    for (const row of created) resolved.set(row.symbol.toUpperCase(), row.id);
    return resolved;
  }

  async startRun(userId: string, source: IngestSource): Promise<string> {
    const rows = await this.request(
      `${this.rest}/ingest_runs?select=id`,
      {
        method: "POST",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({ user_id: userId, source, status: "running" }),
      },
      "starting ingest run",
    ) as Array<{ id: string }>;

    if (rows.length === 0) throw new Error("starting ingest run returned no id");
    return rows[0].id;
  }

  async insertTransactions(
    userId: string,
    runId: string,
    source: IngestSource,
    rows: Array<NormalizedTransaction & { instrumentId: string }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const written = await this.request(
      `${this.rest}/transactions?on_conflict=user_id,source,external_id&select=id`,
      {
        method: "POST",
        headers: this.headers({
          // Re-importing an overlapping export is a no-op, not a conflict. With
          // ignore-duplicates the representation contains only rows actually
          // written, which is exactly the "how many are new" count we report.
          Prefer: "resolution=ignore-duplicates,return=representation",
        }),
        body: JSON.stringify(rows.map((row) => ({
          user_id: userId,
          instrument_id: row.instrumentId,
          type: row.type,
          trade_date: row.tradeDate,
          quantity: row.quantity,
          price: row.price,
          amount: row.amount,
          fees: row.fees,
          source,
          external_id: row.externalId,
          raw: row.raw,
          ingest_run_id: runId,
        }))),
      },
      "inserting transactions",
    ) as unknown[];

    return written.length;
  }

  async finishRun(
    runId: string,
    status: "succeeded" | "failed",
    counts: RunCounts,
    error?: string,
  ): Promise<void> {
    await this.request(
      `${this.rest}/ingest_runs?id=eq.${encodeURIComponent(runId)}`,
      {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({
          status,
          finished_at: new Date().toISOString(),
          rows_seen: counts.rowsSeen,
          rows_imported: counts.rowsImported,
          rows_skipped: counts.rowsSkipped,
          error: error ?? null,
        }),
      },
      "finishing ingest run",
    );
  }

  async recompute(userId: string): Promise<void> {
    await this.request(
      `${this.rest}/rpc/recompute_positions`,
      {
        method: "POST",
        headers: this.headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({ p_user_id: userId }),
      },
      "recomputing positions",
    );
  }
}
