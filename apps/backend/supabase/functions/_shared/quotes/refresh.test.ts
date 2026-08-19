import { assert, assertEquals } from "@std/assert";
import { refreshQuotes } from "./refresh.ts";
import type { HeldInstrument, QuoteRow, QuoteStore } from "./store.ts";
import type { QuoteFetchResult, QuoteProvider, QuoteSource } from "./types.ts";

class FakeStore implements QuoteStore {
  readonly written: QuoteRow[][] = [];

  constructor(private readonly held: HeldInstrument[]) {}

  heldInstruments(): Promise<HeldInstrument[]> {
    return Promise.resolve(this.held);
  }

  upsertQuotes(rows: QuoteRow[]): Promise<number> {
    this.written.push(rows);
    return Promise.resolve(rows.length);
  }
}

class FakeProvider implements QuoteProvider {
  readonly source: QuoteSource = "stub";
  readonly asked: string[][] = [];

  constructor(private readonly result: QuoteFetchResult) {}

  fetchQuotes(symbols: string[]): Promise<QuoteFetchResult> {
    this.asked.push(symbols);
    return Promise.resolve(this.result);
  }
}

const AAPL: HeldInstrument = { instrumentId: "i-aapl", symbol: "AAPL" };
const MSFT: HeldInstrument = { instrumentId: "i-msft", symbol: "MSFT" };

function quote(symbol: string, price: number) {
  return {
    symbol,
    price,
    previousClose: price - 1,
    asOf: "2026-08-19T15:30:00.000Z",
    source: "stub" as const,
  };
}

Deno.test("prices every held instrument and writes the result", async () => {
  const store = new FakeStore([AAPL, MSFT]);
  const provider = new FakeProvider({
    quotes: [quote("AAPL", 231.5), quote("MSFT", 512.25)],
    failures: [],
  });

  const result = await refreshQuotes(store, provider);

  assertEquals(result.instruments, 2);
  assertEquals(result.quotesWritten, 2);
  assertEquals(result.failures, []);
  assertEquals(store.written[0].map((row) => row.instrumentId), ["i-aapl", "i-msft"]);
  assertEquals(store.written[0][0].price, 231.5);
  assertEquals(store.written[0][0].previousClose, 230.5);
});

Deno.test("an empty portfolio never calls the provider", async () => {
  const store = new FakeStore([]);
  const provider = new FakeProvider({ quotes: [], failures: [] });

  const result = await refreshQuotes(store, provider);

  // A free-tier quota is not spent proving there is nothing to price.
  assertEquals(provider.asked.length, 0);
  assertEquals(store.written.length, 0);
  assertEquals(result, { provider: "stub", instruments: 0, quotesWritten: 0, failures: [] });
});

Deno.test("provider failures survive into the result", async () => {
  const store = new FakeStore([AAPL, MSFT]);
  const provider = new FakeProvider({
    quotes: [quote("AAPL", 231.5)],
    failures: [{ symbol: "MSFT", reason: "rate limited by Finnhub (429)" }],
  });

  const result = await refreshQuotes(store, provider);

  assertEquals(result.quotesWritten, 1);
  assertEquals(result.failures, [{ symbol: "MSFT", reason: "rate limited by Finnhub (429)" }]);
});

Deno.test("a quote for a symbol nobody holds is reported, not written", async () => {
  const store = new FakeStore([AAPL]);
  const provider = new FakeProvider({
    quotes: [quote("AAPL", 231.5), quote("FB", 1)],
    failures: [],
  });

  const result = await refreshQuotes(store, provider);

  assertEquals(store.written[0].length, 1);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0].symbol, "FB");
  assert(result.failures[0].reason.includes("no held instrument"));
});

Deno.test("symbol matching is case-insensitive in both directions", async () => {
  const store = new FakeStore([{ instrumentId: "i-aapl", symbol: "aapl" }]);
  const provider = new FakeProvider({ quotes: [quote("Aapl", 231.5)], failures: [] });

  const result = await refreshQuotes(store, provider);

  assertEquals(provider.asked[0], ["AAPL"]);
  assertEquals(result.quotesWritten, 1);
  assertEquals(store.written[0][0].instrumentId, "i-aapl");
});
