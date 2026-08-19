/**
 * The local quote provider.
 *
 * CLAUDE.md § "Local-first": every external dependency ships a local equivalent
 * *and* a code default pointing at it, in the same change that introduces the
 * dependency. This is that equivalent for market data — a fresh clone can refresh
 * quotes, fire alerts and render a portfolio with no Finnhub account.
 *
 * Prices are a pure function of (symbol, UTC day), so they are stable within a
 * day, different between symbols, and move a little overnight. Nothing random:
 * a test that asserts a price stays green, and a screenshot taken twice in one
 * afternoon shows the same number.
 */

import type { Quote, QuoteFetchResult, QuoteProvider } from "./types.ts";

const MS_PER_DAY = 86_400_000;

export interface StubQuoteProviderOptions {
  /** Injected for tests; defaults to the wall clock. */
  now?: () => Date;
}

/** FNV-1a. Small, deterministic, and stable across runtimes. */
function hashSymbol(symbol: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < symbol.length; i++) {
    hash ^= symbol.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** ±5% around the symbol's base price, keyed on the day. */
function priceOn(base: number, seed: number, day: number): number {
  const wobble = Math.sin(seed * 0.7 + day * 1.3) * 0.05;
  return Math.round(base * (1 + wobble) * 100) / 100;
}

export class StubQuoteProvider implements QuoteProvider {
  readonly source = "stub" as const;

  readonly #now: () => Date;

  constructor(options: StubQuoteProviderOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  fetchQuotes(symbols: string[]): Promise<QuoteFetchResult> {
    const at = this.#now();
    const day = Math.floor(at.getTime() / MS_PER_DAY);
    const asOf = at.toISOString();

    const quotes: Quote[] = [];
    for (const raw of new Set(symbols.map((s) => s.toUpperCase()))) {
      const seed = hashSymbol(raw);
      // 20.00 – 500.00, so every symbol looks like a plausible equity.
      const base = 20 + (seed % 48_000) / 100;
      quotes.push({
        symbol: raw,
        price: priceOn(base, seed, day),
        previousClose: priceOn(base, seed, day - 1),
        asOf,
        source: this.source,
      });
    }

    // The stub cannot fail: every symbol is priceable, because the price is
    // derived from the symbol itself rather than looked up anywhere.
    return Promise.resolve({ quotes, failures: [] });
  }
}
