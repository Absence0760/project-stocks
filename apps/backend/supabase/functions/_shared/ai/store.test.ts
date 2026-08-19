/**
 * The store runs with the service role, so RLS is not underneath it. That makes
 * "every query filters on user_id" a property of *this file* and nothing else —
 * which is why it is asserted here against the URLs actually built, rather than
 * assumed because a policy exists.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { PostgrestDigestStore } from "./store.ts";
import type { GroundingPayload } from "./types.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";
const BASE = "http://127.0.0.1:54421";

function stub(respond: (url: string) => unknown) {
  const urls: string[] = [];
  const bodies: string[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    urls.push(url);
    if (init?.body !== undefined && init.body !== null) bodies.push(String(init.body));
    return Promise.resolve(
      new Response(JSON.stringify(respond(url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { impl, urls, bodies };
}

function store(impl: typeof fetch): PostgrestDigestStore {
  return new PostgrestDigestStore(BASE, "service-role-key-not-real", impl);
}

Deno.test("every read is scoped to the user, not left to a policy", async () => {
  const { impl, urls } = stub(() => []);
  const subject = store(impl);

  await subject.positions(USER);
  await subject.liveTheses(USER);
  await subject.thesisHistory(USER, 20);
  await subject.recentNotes(USER, 40);
  await subject.acceptedDisclosureVersion(USER);

  assertEquals(urls.length, 5);
  for (const url of urls) {
    assertStringIncludes(url, `user_id=eq.${USER}`);
  }
});

Deno.test("live theses and history are separated in the query, not in memory", async () => {
  const { impl, urls } = stub(() => []);
  const subject = store(impl);

  await subject.liveTheses(USER);
  await subject.thesisHistory(USER, 5);

  assertStringIncludes(urls[0], "superseded_at=is.null");
  assertStringIncludes(urls[1], "superseded_at=not.is.null");
  assertStringIncludes(urls[1], "limit=5");
});

Deno.test("positions carry their symbol and keep numeric precision as text", async () => {
  const { impl } = stub(() => [{
    // PostgREST hands `numeric` back unquoted, so JSON.parse yields a float here
    // and a string there depending on the column and the client. Both normalise.
    quantity: 9,
    cost_basis: "1665.00",
    avg_cost: 185,
    realized_pl: "240.00",
    first_acquired_on: "2026-01-12",
    last_transaction_on: "2026-05-15",
    instrument: { symbol: "AAPL" },
  }]);

  const rows = await store(impl).positions(USER);

  assertEquals(rows, [{
    symbol: "AAPL",
    quantity: "9",
    costBasis: "1665.00",
    avgCost: "185",
    realizedPl: "240.00",
    firstAcquiredOn: "2026-01-12",
    lastTransactionOn: "2026-05-15",
  }]);
});

Deno.test("a note with no instrument is a portfolio note, not an unknown symbol", async () => {
  const { impl } = stub(() => [
    { body: "Azure 31% again.", created_at: "2026-06-20T11:00:00+00:00", instrument: { symbol: "MSFT" } },
    { body: "Drifting concentrated.", created_at: "2026-07-01T08:00:00+00:00", instrument: null },
  ]);

  const rows = await store(impl).recentNotes(USER, 40);

  assertEquals(rows[0].symbol, "MSFT");
  assertEquals(rows[1].symbol, null);
});

Deno.test("no acceptance row means no consent, not a default", async () => {
  const { impl } = stub(() => []);
  assertEquals(await store(impl).acceptedDisclosureVersion(USER), null);
});

Deno.test("the highest accepted version is what the gate reads", async () => {
  const { impl, urls } = stub(() => [{ version: 2 }]);

  assertEquals(await store(impl).acceptedDisclosureVersion(USER), 2);
  assertStringIncludes(urls[0], "order=version.desc");
  assertStringIncludes(urls[0], "limit=1");
});

Deno.test("a saved digest carries its grounding and its qualified model", async () => {
  const { impl, urls, bodies } = stub(() => [{ id: "digest-1" }]);
  const context: GroundingPayload = {
    generatedAt: "2026-08-19T12:00:00.000Z",
    positions: [],
    liveTheses: [],
    supersededTheses: [],
    notes: [],
  };

  const id = await store(impl).saveDigest({
    userId: USER,
    kind: "weekly-review",
    body: "Nothing changed this week.",
    context,
    model: "ollama/llama3.2",
  });

  assertEquals(id, "digest-1");
  assertStringIncludes(urls[0], "/rest/v1/ai_digests");
  assertEquals(JSON.parse(bodies[0]), {
    user_id: USER,
    kind: "weekly-review",
    body: "Nothing changed this week.",
    context,
    model: "ollama/llama3.2",
  });
});

Deno.test("a PostgREST error surfaces its message rather than a bare status", async () => {
  const impl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "permission denied for table ai_digests" }), {
        status: 403,
      }),
    );

  await assertRejects(
    () => store(impl).positions(USER),
    Error,
    "permission denied for table ai_digests",
  );
});
