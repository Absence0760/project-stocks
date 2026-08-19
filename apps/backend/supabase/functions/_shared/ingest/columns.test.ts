import { assertEquals } from "@std/assert";
import { cell, makeColumnResolver, normalizeHeader } from "./columns.ts";

Deno.test("normalizeHeader folds case, spaces and punctuation", () => {
  assertEquals(normalizeHeader("Trans Code"), "trans_code");
  assertEquals(normalizeHeader("TRANS-CODE"), "trans_code");
  assertEquals(normalizeHeader("  trans_code  "), "trans_code");
  assertEquals(normalizeHeader("Activity Date"), "activity_date");
});

Deno.test("resolver finds a column by any of its aliases", () => {
  const col = makeColumnResolver(["Activity Date", "Instrument", "Trans Code"]);
  assertEquals(col(["date", "activity date"]), 0);
  assertEquals(col(["symbol", "instrument"]), 1);
  assertEquals(col(["trans code"]), 2);
});

Deno.test("resolver prefers the earliest alias that matches", () => {
  const col = makeColumnResolver(["Price", "Amount"]);
  assertEquals(col(["amount", "price"]), 1);
  assertEquals(col(["price", "amount"]), 0);
});

Deno.test("resolver returns null when nothing matches", () => {
  const col = makeColumnResolver(["Activity Date"]);
  assertEquals(col(["quantity", "shares"]), null);
});

Deno.test("resolver is order-independent — reordered exports still resolve", () => {
  const a = makeColumnResolver(["Instrument", "Quantity", "Price"]);
  const b = makeColumnResolver(["Price", "Instrument", "Quantity"]);
  assertEquals(cell(["AAPL", "10", "150"], a(["instrument"])), "AAPL");
  assertEquals(cell(["150", "AAPL", "10"], b(["instrument"])), "AAPL");
});

Deno.test("duplicate headers keep the leftmost column", () => {
  const col = makeColumnResolver(["Amount", "Amount"]);
  assertEquals(col(["amount"]), 0);
});

Deno.test("cell reads trimmed values and tolerates missing indexes", () => {
  assertEquals(cell(["  AAPL  "], 0), "AAPL");
  assertEquals(cell(["AAPL"], null), "");
  assertEquals(cell(["AAPL"], 5), "");
});
