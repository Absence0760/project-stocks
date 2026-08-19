import { assertEquals } from "@std/assert";
import { parseDate, parseMoney, parseQuantity, parseSplitRatio } from "./values.ts";

Deno.test("parseMoney reads plain and formatted currency", () => {
  assertEquals(parseMoney("1234.56"), 1234.56);
  assertEquals(parseMoney("$1,234.56"), 1234.56);
  assertEquals(parseMoney("  $12.40 "), 12.4);
});

Deno.test("parseMoney treats parentheses as accounting negatives", () => {
  assertEquals(parseMoney("($1,502.50)"), -1502.5);
  assertEquals(parseMoney("(12.00)"), -12);
});

Deno.test("parseMoney keeps explicit minus signs", () => {
  assertEquals(parseMoney("-$5.00"), -5);
});

Deno.test("parseMoney returns null for blank and non-numeric cells", () => {
  assertEquals(parseMoney(""), null);
  assertEquals(parseMoney("  "), null);
  assertEquals(parseMoney("--"), null);
  assertEquals(parseMoney("n/a"), null);
});

Deno.test("parseQuantity handles fractional shares", () => {
  assertEquals(parseQuantity("0.12345678"), 0.12345678);
  assertEquals(parseQuantity("1,000"), 1000);
  assertEquals(parseQuantity(""), null);
  assertEquals(parseQuantity("ten"), null);
});

Deno.test("parseDate normalises US and ISO dates", () => {
  assertEquals(parseDate("3/14/2026"), "2026-03-14");
  assertEquals(parseDate("03/14/2026"), "2026-03-14");
  assertEquals(parseDate("2026-03-14"), "2026-03-14");
});

Deno.test("parseDate rejects impossible calendar dates rather than rolling over", () => {
  // new Date(2026, 1, 30) would silently become March 2nd.
  assertEquals(parseDate("2/30/2026"), null);
  assertEquals(parseDate("13/01/2026"), null);
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
});

Deno.test("parseDate does not shift dates across timezones", () => {
  // A naive `new Date("1/1/2026")` in a UTC-negative zone yields 2025-12-31.
  assertEquals(parseDate("1/1/2026"), "2026-01-01");
  assertEquals(parseDate("12/31/2026"), "2026-12-31");
});

Deno.test("parseSplitRatio reads the ratio out of prose", () => {
  assertEquals(parseSplitRatio("Tesla 4 for 1 stock split"), 4);
  assertEquals(parseSplitRatio("AAPL 4:1 split"), 4);
  assertEquals(parseSplitRatio("NVDA 10-for-1 stock split"), 10);
});

Deno.test("parseSplitRatio handles reverse splits", () => {
  assertEquals(parseSplitRatio("1 for 8 reverse split"), 0.125);
});

Deno.test("parseSplitRatio returns null when no ratio is present", () => {
  assertEquals(parseSplitRatio("Stock split"), null);
  assertEquals(parseSplitRatio(""), null);
});
