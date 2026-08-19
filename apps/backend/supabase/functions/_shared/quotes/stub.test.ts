import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { StubQuoteProvider } from "./stub.ts";

const MONDAY = () => new Date("2026-08-17T15:30:00Z");
const TUESDAY = () => new Date("2026-08-18T15:30:00Z");

Deno.test("the same symbol on the same day is the same price", async () => {
  const a = await new StubQuoteProvider({ now: MONDAY }).fetchQuotes(["AAPL"]);
  const b = await new StubQuoteProvider({ now: () => new Date("2026-08-17T21:00:00Z") })
    .fetchQuotes(["AAPL"]);

  assertEquals(a.quotes[0].price, b.quotes[0].price);
});

Deno.test("the price moves overnight", async () => {
  const monday = await new StubQuoteProvider({ now: MONDAY }).fetchQuotes(["AAPL"]);
  const tuesday = await new StubQuoteProvider({ now: TUESDAY }).fetchQuotes(["AAPL"]);

  assertNotEquals(monday.quotes[0].price, tuesday.quotes[0].price);
  // Yesterday's price is today's previous close.
  assertEquals(tuesday.quotes[0].previousClose, monday.quotes[0].price);
});

Deno.test("different symbols get different prices", async () => {
  const { quotes } = await new StubQuoteProvider({ now: MONDAY }).fetchQuotes([
    "AAPL",
    "MSFT",
    "VTI",
  ]);
  const prices = new Set(quotes.map((q) => q.price));

  assertEquals(quotes.length, 3);
  assertEquals(prices.size, 3);
});

Deno.test("every price satisfies the quotes CHECK constraint", async () => {
  const symbols = ["A", "AAPL", "BRK.B", "VTI", "ZZZZ", "SPY", "NVDA", "TSLA"];
  const { quotes } = await new StubQuoteProvider({ now: MONDAY }).fetchQuotes(symbols);

  for (const quote of quotes) {
    assert(quote.price > 0, `${quote.symbol} priced at ${quote.price}`);
    assert(quote.previousClose !== null && quote.previousClose > 0);
  }
});

Deno.test("symbols are uppercased and de-duplicated", async () => {
  const { quotes, failures } = await new StubQuoteProvider({ now: MONDAY })
    .fetchQuotes(["aapl", "AAPL", "AaPl"]);

  assertEquals(quotes.length, 1);
  assertEquals(quotes[0].symbol, "AAPL");
  assertEquals(failures, []);
});

Deno.test("the stub reports itself as the stub source", async () => {
  const provider = new StubQuoteProvider({ now: MONDAY });
  const { quotes } = await provider.fetchQuotes(["AAPL"]);

  assertEquals(provider.source, "stub");
  assertEquals(quotes[0].source, "stub");
  assertEquals(quotes[0].asOf, "2026-08-17T15:30:00.000Z");
});
