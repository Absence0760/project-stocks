import { assert, assertEquals } from "@std/assert";
import { FinnhubQuoteProvider } from "./finnhub.ts";

const KEY = "test-key-not-a-real-credential";

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Records requests and replies from a scripted table of responses. */
function fakeFetch(
  replies: Record<string, { status?: number; body?: unknown }>,
  calls: Call[],
): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const symbol = new URL(url).searchParams.get("symbol") ?? "";
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });

    const reply = replies[symbol] ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 }),
    );
  };
}

function provider(
  replies: Record<string, { status?: number; body?: unknown }>,
  calls: Call[],
  delays: number[] = [],
) {
  return new FinnhubQuoteProvider({
    apiKey: KEY,
    fetchImpl: fakeFetch(replies, calls),
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    baseUrl: "https://finnhub.test/api/v1",
  });
}

Deno.test("maps a quote response onto the shared Quote shape", async () => {
  const calls: Call[] = [];
  const { quotes, failures } = await provider(
    { AAPL: { body: { c: 231.5, pc: 228.25, t: 1_755_000_000 } } },
    calls,
  ).fetchQuotes(["aapl"]);

  assertEquals(failures, []);
  assertEquals(quotes, [{
    symbol: "AAPL",
    price: 231.5,
    previousClose: 228.25,
    asOf: new Date(1_755_000_000 * 1000).toISOString(),
    source: "finnhub",
  }]);
});

Deno.test("the API key travels in a header, never in the URL", async () => {
  const calls: Call[] = [];
  await provider({ AAPL: { body: { c: 1, pc: 1, t: 1 } } }, calls).fetchQuotes(["AAPL"]);

  assertEquals(calls[0].headers["X-Finnhub-Token"], KEY);
  assert(!calls[0].url.includes(KEY), `key leaked into the URL: ${calls[0].url}`);
});

Deno.test("calls are spaced to stay inside the 60-per-minute free tier", async () => {
  const calls: Call[] = [];
  const delays: number[] = [];
  await provider(
    {
      AAPL: { body: { c: 1, pc: 1, t: 1 } },
      MSFT: { body: { c: 2, pc: 2, t: 1 } },
      VTI: { body: { c: 3, pc: 3, t: 1 } },
    },
    calls,
    delays,
  ).fetchQuotes(["AAPL", "MSFT", "VTI"]);

  assertEquals(calls.length, 3);
  // One wait between each pair, and none before the first call.
  assertEquals(delays.length, 2);
  for (const delay of delays) assert(delay >= 1000, `${delay}ms is faster than 60/min`);
});

Deno.test("an unknown symbol answers 200 with a zero price and is reported, not priced", async () => {
  const calls: Call[] = [];
  const { quotes, failures } = await provider(
    { NOPE: { body: { c: 0, pc: 0, t: 0 } } },
    calls,
  ).fetchQuotes(["NOPE"]);

  assertEquals(quotes, []);
  assertEquals(failures.length, 1);
  assert(failures[0].reason.includes("no price returned"));
});

Deno.test("one failing symbol does not cost the rest of the portfolio its refresh", async () => {
  const calls: Call[] = [];
  const { quotes, failures } = await provider(
    {
      AAPL: { body: { c: 231.5, pc: 228.25, t: 1 } },
      BOOM: { status: 500, body: { error: "upstream" } },
      MSFT: { body: { c: 512.25, pc: 500, t: 1 } },
    },
    calls,
  ).fetchQuotes(["AAPL", "BOOM", "MSFT"]);

  assertEquals(quotes.map((q) => q.symbol), ["AAPL", "MSFT"]);
  assertEquals(failures.map((f) => f.symbol), ["BOOM"]);
  assert(failures[0].reason.includes("500"));
});

Deno.test("a rate-limit response is reported as such", async () => {
  const calls: Call[] = [];
  const { failures } = await provider({ AAPL: { status: 429, body: {} } }, calls)
    .fetchQuotes(["AAPL"]);

  assert(failures[0].reason.includes("429"));
});

Deno.test("a missing previous close becomes null rather than zero", async () => {
  const calls: Call[] = [];
  const { quotes } = await provider({ AAPL: { body: { c: 10, pc: 0, t: 0 } } }, calls)
    .fetchQuotes(["AAPL"]);

  assertEquals(quotes[0].previousClose, null);
});
