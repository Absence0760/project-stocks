/**
 * The database seam for a digest run.
 *
 * Same shape as `_shared/ingest/store.ts`, for the same reason: the interesting
 * decisions (is consent current, what grounding gets sent, what gets persisted)
 * belong in handler.ts written against an interface, so they are unit-testable
 * against a fake rather than against a live Postgres or a hand-built mock of a
 * fluent query builder.
 *
 * Plain `fetch` against PostgREST, no supabase-js — docs/STACK.md forbids letting
 * Deno resolve npm here.
 *
 * Runs with the service role, which **bypasses RLS**. That makes the explicit
 * `user_id=eq.` filter on every single query load-bearing rather than
 * belt-and-braces: there is no policy underneath to catch a missing one.
 */

import type { ContextSource } from "./context.ts";
import type { DigestKind, GroundingPayload, NoteRow, PositionRow, ThesisRow } from "./types.ts";

export interface DigestRecord {
  userId: string;
  kind: DigestKind;
  body: string;
  /** Stored verbatim so the response can be reviewed against its grounding. */
  context: GroundingPayload;
  /** Provider-qualified, e.g. `ollama/llama3.2`. */
  model: string;
}

export interface DigestStore extends ContextSource {
  /**
   * The highest AI-disclosure version this user has accepted, or null for none.
   * Highest rather than latest-by-date: the ladder is ordered by version.
   */
  acceptedDisclosureVersion(userId: string): Promise<number | null>;
  /** Persist a generated digest. Returns its id. */
  saveDigest(record: DigestRecord): Promise<string>;
}

/** Embedded `instruments` row from a PostgREST resource embedding. */
interface EmbeddedInstrument {
  symbol?: string | null;
}

/**
 * Postgres `numeric` reaches JSON as an unquoted literal, which `JSON.parse`
 * turns into a float — and some clients hand it back as a string instead. Both
 * are normalised to text here so the stored grounding payload is stable and
 * nothing rounds a cost basis on its way into a prompt.
 */
function numericText(value: unknown, fallback = "0"): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? value : String(value);
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function symbolOf(instrument: EmbeddedInstrument | null | undefined): string {
  const symbol = instrument?.symbol;
  return typeof symbol === "string" && symbol !== "" ? symbol : "(unknown)";
}

export class PostgrestDigestStore implements DigestStore {
  private readonly rest: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    /**
     * Injected so the URLs this store builds — specifically the `user_id=eq.`
     * scoping — are assertable in a unit test without a database.
     */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
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
    const response = await this.fetchImpl(url, init);
    const text = await response.text();

    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; hint?: string };
        detail = parsed.message ?? parsed.hint ?? text;
      } catch {
        // non-JSON body — use it as-is
      }
      throw new Error(`${context}: ${response.status} ${detail}`);
    }

    if (text.trim() === "") return [];
    return JSON.parse(text);
  }

  private scope(userId: string): string {
    return `user_id=eq.${encodeURIComponent(userId)}`;
  }

  async positions(userId: string): Promise<PositionRow[]> {
    const rows = await this.request(
      `${this.rest}/positions` +
        `?select=quantity,cost_basis,avg_cost,realized_pl,first_acquired_on,last_transaction_on,instrument:instruments(symbol)` +
        `&${this.scope(userId)}&order=cost_basis.desc`,
      { headers: this.headers() },
      "reading positions",
    ) as Array<Record<string, unknown> & { instrument?: EmbeddedInstrument | null }>;

    return rows.map((row) => ({
      symbol: symbolOf(row.instrument),
      quantity: numericText(row.quantity),
      costBasis: numericText(row.cost_basis),
      avgCost: optionalText(row.avg_cost),
      realizedPl: numericText(row.realized_pl),
      firstAcquiredOn: optionalText(row.first_acquired_on),
      lastTransactionOn: optionalText(row.last_transaction_on),
    }));
  }

  liveTheses(userId: string): Promise<ThesisRow[]> {
    return this.theses(
      `${this.rest}/theses?${this.thesisSelect()}&${this.scope(userId)}` +
        `&superseded_at=is.null&order=written_at.desc`,
      "reading live theses",
    );
  }

  thesisHistory(userId: string, limit: number): Promise<ThesisRow[]> {
    return this.theses(
      `${this.rest}/theses?${this.thesisSelect()}&${this.scope(userId)}` +
        `&superseded_at=not.is.null&order=written_at.desc&limit=${encodeURIComponent(String(limit))}`,
      "reading thesis history",
    );
  }

  private thesisSelect(): string {
    return "select=rationale,entry_conditions,exit_conditions,conviction,written_at,superseded_at,instrument:instruments(symbol)";
  }

  private async theses(url: string, context: string): Promise<ThesisRow[]> {
    const rows = await this.request(url, { headers: this.headers() }, context) as Array<
      Record<string, unknown> & { instrument?: EmbeddedInstrument | null }
    >;

    return rows.map((row) => ({
      symbol: symbolOf(row.instrument),
      rationale: String(row.rationale ?? ""),
      entryConditions: optionalText(row.entry_conditions),
      exitConditions: optionalText(row.exit_conditions),
      conviction: typeof row.conviction === "number" ? row.conviction : null,
      writtenAt: String(row.written_at ?? ""),
      supersededAt: optionalText(row.superseded_at),
    }));
  }

  async recentNotes(userId: string, limit: number): Promise<NoteRow[]> {
    const rows = await this.request(
      `${this.rest}/notes?select=body,created_at,instrument:instruments(symbol)` +
        `&${this.scope(userId)}&order=created_at.desc&limit=${encodeURIComponent(String(limit))}`,
      { headers: this.headers() },
      "reading notes",
    ) as Array<Record<string, unknown> & { instrument?: EmbeddedInstrument | null }>;

    return rows.map((row) => ({
      symbol: row.instrument ? symbolOf(row.instrument) : null,
      body: String(row.body ?? ""),
      createdAt: String(row.created_at ?? ""),
    }));
  }

  async acceptedDisclosureVersion(userId: string): Promise<number | null> {
    const rows = await this.request(
      `${this.rest}/ai_disclosure_acceptances?select=version&${this.scope(userId)}` +
        `&order=version.desc&limit=1`,
      { headers: this.headers() },
      "reading disclosure acceptance",
    ) as Array<{ version?: unknown }>;

    const version = rows[0]?.version;
    return typeof version === "number" ? version : null;
  }

  async saveDigest(record: DigestRecord): Promise<string> {
    const rows = await this.request(
      `${this.rest}/ai_digests?select=id`,
      {
        method: "POST",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({
          user_id: record.userId,
          kind: record.kind,
          body: record.body,
          context: record.context,
          model: record.model,
        }),
      },
      "saving digest",
    ) as Array<{ id: string }>;

    if (rows.length === 0) throw new Error("saving digest returned no id");
    return rows[0].id;
  }
}
