/**
 * Shared quote types.
 *
 * `QUOTE_SOURCES` is paired to the `source` CHECK constraint on `quotes` in
 * supabase/migrations/20260819140000_quotes_and_alerts.sql. The pairing is
 * enforced in CI by scripts/check_constraint_unions.mjs — add a provider to both
 * or neither.
 */

export const QUOTE_SOURCES = ["finnhub", "stub", "manual"] as const;
export type QuoteSource = (typeof QUOTE_SOURCES)[number];

/** One provider reading for one symbol. */
export interface Quote {
  /** Uppercased ticker, as asked for. */
  symbol: string;
  price: number;
  /** Previous session's close, when the provider reports one. */
  previousClose: number | null;
  /** ISO 8601. The provider's own timestamp when it gives one. */
  asOf: string;
  source: QuoteSource;
}

/** A symbol the provider could not price, and why. Never silently dropped. */
export interface QuoteFailure {
  symbol: string;
  reason: string;
}

export interface QuoteFetchResult {
  quotes: Quote[];
  failures: QuoteFailure[];
}

/**
 * The provider seam.
 *
 * A partial answer is a normal answer: one delisted ticker must not cost the
 * whole refresh, so failures are reported alongside the quotes rather than
 * thrown. Providers throw only when the request could not be made at all.
 */
export interface QuoteProvider {
  readonly source: QuoteSource;
  fetchQuotes(symbols: string[]): Promise<QuoteFetchResult>;
}

/** Thrown when the configured provider cannot be built from the environment. */
export class QuoteProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteProviderConfigError";
  }
}
