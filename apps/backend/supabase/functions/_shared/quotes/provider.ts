/**
 * Provider selection.
 *
 * `QUOTE_PROVIDER` picks the implementation and defaults to the local stub, so
 * the dev server never needs a real SaaS credential (CLAUDE.md § "Local-first").
 * Production sets `QUOTE_PROVIDER=finnhub` and supplies `FINNHUB_API_KEY`.
 *
 * A named provider with no credential is a configuration error, not a reason to
 * fall back: silently serving invented prices to a live portfolio — and firing
 * real alerts off them — is worse than a refresh that refuses to run.
 */

import { FinnhubQuoteProvider } from "./finnhub.ts";
import { StubQuoteProvider } from "./stub.ts";
import { QuoteProviderConfigError, type QuoteProvider } from "./types.ts";

/** `Deno.env.get`-shaped, so tests pass a plain object lookup. */
export type EnvReader = (key: string) => string | undefined;

export const DEFAULT_QUOTE_PROVIDER = "stub";

export function createQuoteProvider(env: EnvReader): QuoteProvider {
  const name = (env("QUOTE_PROVIDER") ?? DEFAULT_QUOTE_PROVIDER).trim().toLowerCase();

  switch (name) {
    case "stub":
      return new StubQuoteProvider();

    case "finnhub": {
      const apiKey = env("FINNHUB_API_KEY");
      if (!apiKey) {
        throw new QuoteProviderConfigError(
          'QUOTE_PROVIDER="finnhub" requires FINNHUB_API_KEY to be set',
        );
      }
      return new FinnhubQuoteProvider({ apiKey });
    }

    default:
      throw new QuoteProviderConfigError(
        `unknown QUOTE_PROVIDER "${name}" (expected "stub" or "finnhub")`,
      );
  }
}
