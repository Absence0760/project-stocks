import { assertEquals } from "@std/assert";
import { dropBlankRows, parseCsv } from "./csv.ts";

Deno.test("parseCsv reads a simple table", () => {
  assertEquals(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

Deno.test("parseCsv handles quoted fields containing commas", () => {
  assertEquals(
    parseCsv('sym,name\nAAPL,"Apple Inc., Common Stock"\n'),
    [["sym", "name"], ["AAPL", "Apple Inc., Common Stock"]],
  );
});

Deno.test("parseCsv unescapes doubled quotes", () => {
  assertEquals(parseCsv('a\n"say ""hi"""\n'), [["a"], ['say "hi"']]);
});

Deno.test("parseCsv preserves newlines inside quoted fields", () => {
  assertEquals(parseCsv('a\n"line1\nline2"\n'), [["a"], ["line1\nline2"]]);
});

Deno.test("parseCsv handles CRLF line endings", () => {
  assertEquals(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

Deno.test("parseCsv strips a UTF-8 BOM", () => {
  assertEquals(parseCsv("﻿a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

Deno.test("parseCsv does not emit a trailing empty row", () => {
  assertEquals(parseCsv("a\n1\n").length, 2);
  assertEquals(parseCsv("a\n1").length, 2);
});

Deno.test("parseCsv keeps empty fields", () => {
  assertEquals(parseCsv("a,b,c\n1,,3\n"), [["a", "b", "c"], ["1", "", "3"]]);
});

Deno.test("dropBlankRows removes whitespace-only rows", () => {
  const rows = [["a", "b"], ["", ""], ["1", "2"], ["  ", ""]];
  assertEquals(dropBlankRows(rows), [["a", "b"], ["1", "2"]]);
});
