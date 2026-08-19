import { assertEquals, assertRejects } from "@std/assert";
import { handleImport, UnsupportedSourceError } from "./handler.ts";
import type { LedgerStore, RunCounts } from "./store.ts";
import type { IngestSource, NormalizedTransaction } from "./types.ts";

const HEADER =
  '"Activity Date","Instrument","Description","Trans Code","Quantity","Price","Amount"';

const CSV = [
  HEADER,
  '"3/14/2026","AAPL","Apple Inc.","Buy","10","$150.25","($1,502.50)"',
  '"3/20/2026","AAPL","Apple Inc.","Sell","4","$160.00","$640.00"',
  '"4/5/2026","","ACH Deposit","ACH","","","$500.00"',
].join("\n");

const USER = "00000000-0000-0000-0000-0000000000a1";

/** Records what the handler asked of the database. */
class FakeStore implements LedgerStore {
  readonly calls: string[] = [];
  finished?: { status: string; counts: RunCounts; error?: string };
  /** How many of the offered rows the upsert should claim to have written. */
  insertReturns: number | null = null;
  failOn: string | null = null;

  constructor(private readonly knownSymbols: string[] = ["AAPL"]) {}

  resolveInstruments(symbols: string[]): Promise<Map<string, string>> {
    this.calls.push("resolveInstruments");
    if (this.failOn === "resolveInstruments") throw new Error("boom");
    const out = new Map<string, string>();
    for (const symbol of new Set(symbols.map((s) => s.toUpperCase()))) {
      if (this.knownSymbols.includes(symbol)) out.set(symbol, `id-${symbol}`);
    }
    return Promise.resolve(out);
  }

  startRun(_userId: string, _source: IngestSource): Promise<string> {
    this.calls.push("startRun");
    return Promise.resolve("run-1");
  }

  insertTransactions(
    _userId: string,
    _runId: string,
    _source: IngestSource,
    rows: Array<NormalizedTransaction & { instrumentId: string }>,
  ): Promise<number> {
    this.calls.push("insertTransactions");
    return Promise.resolve(this.insertReturns ?? rows.length);
  }

  finishRun(
    _runId: string,
    status: "succeeded" | "failed",
    counts: RunCounts,
    error?: string,
  ): Promise<void> {
    this.calls.push("finishRun");
    this.finished = { status, counts, error };
    return Promise.resolve();
  }

  recompute(_userId: string): Promise<void> {
    this.calls.push("recompute");
    return Promise.resolve();
  }
}

Deno.test("imports parsed rows and rebuilds the projection", async () => {
  const store = new FakeStore();
  const result = await handleImport(USER, "robinhood-csv", CSV, store);

  assertEquals(result.rowsImported, 2);
  assertEquals(result.rowsSeen, 3); // 2 importable + 1 skipped cash row
  assertEquals(store.calls.includes("recompute"), true);
  assertEquals(store.finished?.status, "succeeded");
});

Deno.test("reports adapter skips alongside the import counts", async () => {
  const store = new FakeStore();
  const result = await handleImport(USER, "robinhood-csv", CSV, store);

  assertEquals(result.skipped.length, 1);
  assertEquals(result.skipped[0].reason, "cash movement (ach), no instrument");
  assertEquals(store.finished?.counts.rowsSkipped, 1);
});

Deno.test("a re-import of an overlapping export writes nothing and skips recompute", async () => {
  const store = new FakeStore();
  store.insertReturns = 0; // every row already present

  const result = await handleImport(USER, "robinhood-csv", CSV, store);

  assertEquals(result.rowsImported, 0);
  assertEquals(result.rowsDuplicate, 2);
  assertEquals(store.calls.includes("recompute"), false);
  assertEquals(store.finished?.status, "succeeded");
});

Deno.test("a partially-overlapping re-import recomputes once", async () => {
  const store = new FakeStore();
  store.insertReturns = 1;

  const result = await handleImport(USER, "robinhood-csv", CSV, store);

  assertEquals(result.rowsImported, 1);
  assertEquals(result.rowsDuplicate, 1);
  assertEquals(store.calls.filter((c) => c === "recompute").length, 1);
});

Deno.test("an unresolvable instrument is reported, not silently dropped", async () => {
  const store = new FakeStore([]); // nothing resolves
  const result = await handleImport(USER, "robinhood-csv", CSV, store);

  assertEquals(result.rowsImported, 0);
  assertEquals(result.skipped.length, 3); // 1 adapter skip + 2 unresolved
  assertEquals(
    result.skipped.some((s) => s.reason.includes('could not resolve instrument "AAPL"')),
    true,
  );
});

Deno.test("a failure is recorded against the run before it propagates", async () => {
  const store = new FakeStore();
  store.failOn = "resolveInstruments";

  await assertRejects(() => handleImport(USER, "robinhood-csv", CSV, store), Error, "boom");

  assertEquals(store.finished?.status, "failed");
  assertEquals(store.finished?.error, "boom");
});

Deno.test("an unknown source is rejected before any run is started", async () => {
  const store = new FakeStore();

  await assertRejects(
    () => handleImport(USER, "snaptrade", CSV, store),
    UnsupportedSourceError,
  );

  assertEquals(store.calls.length, 0);
});
