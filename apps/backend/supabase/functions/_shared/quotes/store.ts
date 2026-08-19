/**
 * The database seam for a quote refresh.
 *
 * Same shape and the same reasoning as _shared/ingest/store.ts: the interesting
 * decisions live in refresh.ts, written against this interface, so they are
 * unit-testable against a fake rather than a hand-built mock of a query builder.
 * Plain `fetch` over PostgREST rather than supabase-js, for the reason
 * docs/STACK.md gives — letting Deno resolve npm packages here rewrites the root
 * package.json.
 */

import type { QuoteSource } from "./types.ts";

/** An instrument someone actually holds. Nothing else is worth a quota call. */
export interface HeldInstrument {
  instrumentId: string;
  symbol: string;
}

export interface QuoteRow {
  instrumentId: string;
  asOf: string;
  price: number;
  previousClose: number | null;
  source: QuoteSource;
}

export interface QuoteStore {
  /**
   * Distinct instruments with an open position, across every user. Quotes are
   * global reference data: two users holding AAPL are one price to fetch.
   */
  heldInstruments(): Promise<HeldInstrument[]>;
  /** Upsert on (instrument_id, as_of). Returns the number of rows written. */
  upsertQuotes(rows: QuoteRow[]): Promise<number>;
}

/**
 * PostgREST-backed implementation.
 *
 * Runs with the service role: `quotes` is written for every user's holdings at
 * once, so there is no caller whose own privileges would do. Nothing here takes
 * a user id from a request — the read is "everything held by anyone", which is
 * the same answer regardless of who asked.
 */
export class PostgrestQuoteStore implements QuoteStore {
  readonly #rest: string;
  readonly #serviceRoleKey: string;
  readonly #fetch: typeof fetch;

  constructor(supabaseUrl: string, serviceRoleKey: string, fetchImpl: typeof fetch = fetch) {
    this.#rest = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
    this.#serviceRoleKey = serviceRoleKey;
    this.#fetch = fetchImpl;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.#serviceRoleKey,
      Authorization: `Bearer ${this.#serviceRoleKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async #request(url: string, init: RequestInit, context: string): Promise<unknown> {
    const response = await this.#fetch(url, init);
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

    if (text.trim() === "") return [];
    return JSON.parse(text);
  }

  async heldInstruments(): Promise<HeldInstrument[]> {
    const rows = await this.#request(
      `${this.#rest}/positions?select=instrument_id,instruments(symbol)&quantity=gt.0`,
      { headers: this.#headers() },
      "reading held instruments",
    ) as Array<{ instrument_id: string; instruments: { symbol: string } | null }>;

    // One row per (user, instrument); collapse to the instrument.
    const held = new Map<string, HeldInstrument>();
    for (const row of rows) {
      const symbol = row.instruments?.symbol;
      if (!symbol) continue;
      held.set(row.instrument_id, { instrumentId: row.instrument_id, symbol: symbol.toUpperCase() });
    }
    return [...held.values()];
  }

  async upsertQuotes(rows: QuoteRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const written = await this.#request(
      `${this.#rest}/quotes?on_conflict=instrument_id,as_of&select=instrument_id`,
      {
        method: "POST",
        headers: this.#headers({
          // merge-duplicates, not ignore-duplicates: re-running a refresh inside
          // the same provider timestamp should correct the row, not skip it.
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify(rows.map((row) => ({
          instrument_id: row.instrumentId,
          as_of: row.asOf,
          price: row.price,
          previous_close: row.previousClose,
          source: row.source,
        }))),
      },
      "writing quotes",
    ) as unknown[];

    return written.length;
  }
}
