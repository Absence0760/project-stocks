/**
 * Refresh orchestration, written against QuoteStore + QuoteProvider so it stays
 * testable without a database or a live API key.
 *
 * The whole job is: price what is held, write what came back, and report what
 * did not. Nothing is silently dropped — a symbol the provider could not price
 * and a symbol that came back for an instrument nobody holds are both reported,
 * because both mean the ticker universe and the provider disagree, and that is
 * exactly the thing you want to hear about early.
 */

import type { QuoteFailure, QuoteProvider, QuoteSource } from "./types.ts";
import type { QuoteRow, QuoteStore } from "./store.ts";

export interface RefreshResult {
  provider: QuoteSource;
  /** Distinct instruments with an open position. */
  instruments: number;
  quotesWritten: number;
  failures: QuoteFailure[];
}

export async function refreshQuotes(
  store: QuoteStore,
  provider: QuoteProvider,
): Promise<RefreshResult> {
  const held = await store.heldInstruments();

  // No holdings, no call. A free-tier quota is not spent on an empty portfolio.
  if (held.length === 0) {
    return { provider: provider.source, instruments: 0, quotesWritten: 0, failures: [] };
  }

  const bySymbol = new Map(held.map((instrument) => [instrument.symbol.toUpperCase(), instrument]));
  const { quotes, failures } = await provider.fetchQuotes([...bySymbol.keys()]);

  const rows: QuoteRow[] = [];
  const unmatched: QuoteFailure[] = [];

  for (const quote of quotes) {
    const instrument = bySymbol.get(quote.symbol.toUpperCase());
    if (instrument === undefined) {
      // The provider answered something nobody asked for — a symbol alias, or a
      // ticker that changed under us. Report it rather than writing a quote that
      // no position can ever be valued against.
      unmatched.push({ symbol: quote.symbol, reason: "no held instrument for this symbol" });
      continue;
    }
    rows.push({
      instrumentId: instrument.instrumentId,
      asOf: quote.asOf,
      price: quote.price,
      previousClose: quote.previousClose,
      source: quote.source,
    });
  }

  const quotesWritten = await store.upsertQuotes(rows);

  return {
    provider: provider.source,
    instruments: held.length,
    quotesWritten,
    failures: [...failures, ...unmatched],
  };
}
