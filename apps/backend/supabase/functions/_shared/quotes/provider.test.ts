import { assertEquals, assertThrows } from "@std/assert";
import { createQuoteProvider } from "./provider.ts";
import { QuoteProviderConfigError } from "./types.ts";

const env = (values: Record<string, string>) => (key: string) => values[key];

Deno.test("an unset QUOTE_PROVIDER gives the local stub", () => {
  assertEquals(createQuoteProvider(env({})).source, "stub");
});

Deno.test("finnhub is selected by name", () => {
  const provider = createQuoteProvider(
    env({ QUOTE_PROVIDER: "finnhub", FINNHUB_API_KEY: "test-key" }),
  );
  assertEquals(provider.source, "finnhub");
});

Deno.test("the provider name is case- and whitespace-insensitive", () => {
  const provider = createQuoteProvider(
    env({ QUOTE_PROVIDER: "  FinnHub ", FINNHUB_API_KEY: "test-key" }),
  );
  assertEquals(provider.source, "finnhub");
});

Deno.test("finnhub without a key is a configuration error, not a silent fallback", () => {
  // Falling back to the stub here would write invented prices into a live
  // portfolio and fire real alerts off them.
  assertThrows(
    () => createQuoteProvider(env({ QUOTE_PROVIDER: "finnhub" })),
    QuoteProviderConfigError,
    "FINNHUB_API_KEY",
  );
});

Deno.test("an unrecognised provider name is refused", () => {
  assertThrows(
    () => createQuoteProvider(env({ QUOTE_PROVIDER: "yahoo" })),
    QuoteProviderConfigError,
    'unknown QUOTE_PROVIDER "yahoo"',
  );
});
