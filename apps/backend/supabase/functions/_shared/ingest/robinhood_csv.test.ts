import { assertEquals, assertNotEquals } from "@std/assert";
import { RobinhoodCsvAdapter } from "./robinhood_csv.ts";

const HEADER =
  '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"';

const SAMPLE = [
  HEADER,
  '"3/14/2026","3/14/2026","3/16/2026","AAPL","Apple Inc. Common Stock","Buy","10","$150.25","($1,502.50)"',
  '"3/20/2026","3/20/2026","3/22/2026","AAPL","Apple Inc. Common Stock","Sell","4","$160.00","$640.00"',
  '"4/1/2026","4/1/2026","4/1/2026","AAPL","Apple Inc. Cash Div","CDIV","","","$12.40"',
  '"4/5/2026","4/5/2026","4/5/2026","","ACH Deposit","ACH","","","$500.00"',
  '"5/1/2026","5/1/2026","5/1/2026","TSLA","Tesla 4 for 1 stock split","SPL","30","",""',
  '"5/10/2026","5/10/2026","5/10/2026","SPY","Call Option 500","BTO","1","$2.00","($200.00)"',
  "",
].join("\n");

const adapter = new RobinhoodCsvAdapter();

Deno.test("imports the share- and cash-affecting rows", () => {
  const { transactions } = adapter.parse(SAMPLE);
  assertEquals(transactions.map((t) => [t.symbol, t.type]), [
    ["AAPL", "buy"],
    ["AAPL", "sell"],
    ["AAPL", "dividend"],
    ["TSLA", "split"],
  ]);
});

Deno.test("normalises amounts to positive magnitudes", () => {
  const { transactions } = adapter.parse(SAMPLE);
  const buy = transactions[0];
  // The export writes a buy as ($1,502.50); direction lives in `type`.
  assertEquals(buy.amount, 1502.5);
  assertEquals(buy.price, 150.25);
  assertEquals(buy.quantity, 10);
  assertEquals(buy.tradeDate, "2026-03-14");
});

Deno.test("converts a split row's prose ratio into the quantity field", () => {
  const { transactions } = adapter.parse(SAMPLE);
  const split = transactions.find((t) => t.type === "split");
  assertEquals(split?.quantity, 4);
});

Deno.test("skips cash movements and options with a stated reason", () => {
  const { skipped } = adapter.parse(SAMPLE);
  assertEquals(skipped.length, 2);
  assertEquals(skipped.map((s) => s.reason), [
    "cash movement (ach), no instrument",
    "options activity (bto) is not supported",
  ]);
});

Deno.test("external ids are stable across repeated parses", () => {
  const first = adapter.parse(SAMPLE).transactions.map((t) => t.externalId);
  const second = adapter.parse(SAMPLE).transactions.map((t) => t.externalId);
  assertEquals(first, second);
});

Deno.test("two identical same-day fills stay distinct", () => {
  const fill =
    '"3/14/2026","3/14/2026","3/16/2026","AAPL","Apple Inc. Common Stock","Buy","10","$150.25","($1,502.50)"';
  const { transactions } = adapter.parse([HEADER, fill, fill].join("\n"));
  assertEquals(transactions.length, 2);
  assertNotEquals(transactions[0].externalId, transactions[1].externalId);
});

Deno.test("a re-export that gains a row leaves existing ids untouched", () => {
  const fill =
    '"3/14/2026","3/14/2026","3/16/2026","AAPL","Apple Inc. Common Stock","Buy","10","$150.25","($1,502.50)"';
  const before = adapter.parse([HEADER, fill].join("\n")).transactions.map((t) => t.externalId);
  const after = adapter.parse([HEADER, fill, fill].join("\n")).transactions.map((t) => t.externalId);

  // The pre-existing key must still be present, so re-import is a no-op for it.
  assertEquals(after.includes(before[0]), true);
  assertEquals(after.length, 2);
});

Deno.test("column order does not matter", () => {
  const reordered = [
    '"Trans Code","Instrument","Quantity","Price","Amount","Activity Date","Description"',
    '"Buy","AAPL","10","$150.25","($1,502.50)","3/14/2026","Apple Inc."',
  ].join("\n");

  const { transactions } = adapter.parse(reordered);
  assertEquals(transactions.length, 1);
  assertEquals(transactions[0].symbol, "AAPL");
  assertEquals(transactions[0].amount, 1502.5);
  assertEquals(transactions[0].tradeDate, "2026-03-14");
});

Deno.test("an unrecognised file is reported once, not once per row", () => {
  const { transactions, skipped } = adapter.parse("foo,bar\n1,2\n3,4\n");
  assertEquals(transactions.length, 0);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].row, 0);
});

Deno.test("a split without a readable ratio is skipped rather than guessed", () => {
  const rows = [
    HEADER,
    '"5/1/2026","5/1/2026","5/1/2026","TSLA","Stock split","SPL","30","",""',
  ].join("\n");

  const { transactions, skipped } = adapter.parse(rows);
  assertEquals(transactions.length, 0);
  assertEquals(skipped[0].reason, "split row without a readable ratio — add it manually");
});

Deno.test("an empty file yields nothing rather than throwing", () => {
  assertEquals(adapter.parse(""), { transactions: [], skipped: [] });
});
