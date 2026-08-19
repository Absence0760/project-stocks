/**
 * Finnhub quote provider (https://finnhub.io/docs/api/quote).
 *
 * Chosen for the free tier: real-time US equity quotes at 60 calls/minute, with
 * no card and no per-symbol licensing. A personal portfolio is tens of symbols,
 * so one call per symbol per refresh sits inside the limit with room to spare —
 * but only if the calls are *spaced*. Finnhub's limiter is per-minute and a burst
 * of 60 in one second gets 429s, so this walks the symbol list serially with a
 * minimum interval instead of firing them all at once.
 *
 * The API key travels in the `X-Finnhub-Token` header, never in the query
 * string: a URL ends up in every access log and error report it passes through.
 */

import type { Quote, QuoteFailure, QuoteFetchResult, QuoteProvider } from "./types.ts";

const DEFAULT_BASE_URL = "https://finnhub.io/api/v1";

/** 60 calls/min is one per second; the extra 100ms absorbs clock skew. */
const DEFAULT_MIN_INTERVAL_MS = 1_100;

export interface FinnhubQuoteProviderOptions {
  apiKey: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  baseUrl?: string;
}

/** The shape of a `/quote` response. Every field is a number; 0 means "no data". */
interface FinnhubQuote {
  c?: number;
  pc?: number;
  t?: number;
}

export class FinnhubQuoteProvider implements QuoteProvider {
  readonly source = "finnhub" as const;

  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #minIntervalMs: number;
  readonly #baseUrl: string;

  constructor(options: FinnhubQuoteProviderOptions) {
    if (!options.apiKey) throw new Error("FinnhubQuoteProvider needs an API key");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async fetchQuotes(symbols: string[]): Promise<QuoteFetchResult> {
    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
    const quotes: Quote[] = [];
    const failures: QuoteFailure[] = [];

    for (let i = 0; i < wanted.length; i++) {
      // Space the calls, but never pay the interval before the first one.
      if (i > 0 && this.#minIntervalMs > 0) await this.#sleep(this.#minIntervalMs);

      const symbol = wanted[i];
      try {
        const quote = await this.#fetchOne(symbol);
        if (quote === null) {
          failures.push({ symbol, reason: "no price returned (unknown or delisted symbol)" });
        } else {
          quotes.push(quote);
        }
      } catch (error) {
        // One bad symbol must not cost the rest of the portfolio its refresh.
        failures.push({ symbol, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return { quotes, failures };
  }

  async #fetchOne(symbol: string): Promise<Quote | null> {
    const url = `${this.#baseUrl}/quote?symbol=${encodeURIComponent(symbol)}`;
    const response = await this.#fetch(url, {
      headers: { "X-Finnhub-Token": this.#apiKey, Accept: "application/json" },
    });

    if (response.status === 429) {
      throw new Error("rate limited by Finnhub (429)");
    }
    if (!response.ok) {
      throw new Error(`Finnhub returned ${response.status}`);
    }

    const body = await response.json() as FinnhubQuote;

    // Finnhub answers an unknown symbol with 200 and an all-zero body rather
    // than a 404, so a zero current price is the "no such symbol" signal.
    const price = typeof body.c === "number" ? body.c : 0;
    if (!Number.isFinite(price) || price <= 0) return null;

    const previousClose = typeof body.pc === "number" && body.pc > 0 ? body.pc : null;
    const asOf = typeof body.t === "number" && body.t > 0
      ? new Date(body.t * 1000).toISOString()
      : new Date().toISOString();

    return { symbol, price, previousClose, asOf, source: this.source };
  }
}
