/**
 * The durable assertion here is *what was sent*, not what came back.
 *
 * A test that pins the model's prose pins nothing — the same prompt against the
 * same weights on a different day writes different words, and a local llama and a
 * hosted Opus write nothing alike. What must not drift is the request: the system
 * prompt, the fenced grounding, the task turn, and the fact that none of it is
 * assembled at all until consent has been checked. So the provider here is a fake
 * that records its request and replays fixed chunks.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_MAX_TOKENS,
  type DigestConfig,
  EmptyDigestError,
  EmptyGroundingError,
  handleDigest,
} from "./handler.ts";
import { CONTEXT_CLOSE, CONTEXT_OPEN } from "./context.ts";
import { DisclosureNotAcceptedError, REQUIRED_DISCLOSURE_VERSION } from "./disclosure.ts";
import { SYSTEM_PROMPT, TASK_PROMPTS } from "./system_prompt.ts";
import type { Provider, ProviderId, ProviderRequest, ProviderStream, Usage } from "./providers.ts";
import type { DigestRecord, DigestStore } from "./store.ts";
import type { NoteRow, PositionRow, ThesisRow } from "./types.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";

const POSITIONS: PositionRow[] = [{
  symbol: "AAPL",
  quantity: "9",
  costBasis: "1665.00",
  avgCost: "185.00",
  realizedPl: "240.00",
  firstAcquiredOn: "2026-01-12",
  lastTransactionOn: "2026-05-15",
}];

const LIVE_THESES: ThesisRow[] = [{
  symbol: "AAPL",
  rationale: "Services margin expansion is underappreciated.",
  entryConditions: "Add below $180.",
  exitConditions: "Trim if services growth drops under 10% for two quarters.",
  conviction: 3,
  writtenAt: "2026-05-04T09:00:00+00:00",
  supersededAt: null,
}];

const HISTORY: ThesisRow[] = [{
  symbol: "AAPL",
  rationale: "Hardware is a floor, not the story.",
  entryConditions: null,
  exitConditions: null,
  conviction: 4,
  writtenAt: "2026-01-12T09:00:00+00:00",
  supersededAt: "2026-05-04T09:00:00+00:00",
}];

const NOTES: NoteRow[] = [{
  symbol: "AAPL",
  body: "Q2 call: services growth 8.4%, second miss in a row.",
  createdAt: "2026-05-02T16:30:00+00:00",
}];

/** Records what the handler asked of the database, and in what order. */
class FakeStore implements DigestStore {
  readonly calls: string[] = [];
  acceptedVersion: number | null = REQUIRED_DISCLOSURE_VERSION;
  saved?: DigestRecord;

  positionRows = POSITIONS;
  liveThesisRows = LIVE_THESES;
  historyRows = HISTORY;
  noteRows = NOTES;

  acceptedDisclosureVersion(_userId: string): Promise<number | null> {
    this.calls.push("acceptedDisclosureVersion");
    return Promise.resolve(this.acceptedVersion);
  }

  positions(_userId: string): Promise<PositionRow[]> {
    this.calls.push("positions");
    return Promise.resolve(this.positionRows);
  }

  liveTheses(_userId: string): Promise<ThesisRow[]> {
    this.calls.push("liveTheses");
    return Promise.resolve(this.liveThesisRows);
  }

  thesisHistory(_userId: string, _limit: number): Promise<ThesisRow[]> {
    this.calls.push("thesisHistory");
    return Promise.resolve(this.historyRows);
  }

  recentNotes(_userId: string, _limit: number): Promise<NoteRow[]> {
    this.calls.push("recentNotes");
    return Promise.resolve(this.noteRows);
  }

  saveDigest(record: DigestRecord): Promise<string> {
    this.calls.push("saveDigest");
    this.saved = record;
    return Promise.resolve("digest-1");
  }
}

/** Replays fixed chunks and records the request it was handed. */
class FakeProvider implements Provider {
  readonly id: ProviderId = "ollama";
  readonly model = "fake-model";
  readonly qualifiedModel = "ollama/fake-model";

  request?: ProviderRequest;
  chunks = ["Your AAPL exit condition ", "looks met."];
  usage: Usage = { model: "ollama/fake-model", inputTokens: 1200, outputTokens: 90 };

  stream(request: ProviderRequest): Promise<ProviderStream> {
    this.request = request;
    const chunks = this.chunks;
    const usage = this.usage;

    async function* tokens(): AsyncGenerator<string> {
      for (const chunk of chunks) yield chunk;
    }

    return Promise.resolve({ tokens: tokens(), finalUsage: () => Promise.resolve(usage) });
  }
}

function config(
  store: FakeStore,
  provider: FakeProvider,
  overrides: Partial<DigestConfig> = {},
): DigestConfig {
  return {
    kind: "weekly-review",
    store,
    provider,
    now: () => new Date("2026-08-19T12:00:00.000Z"),
    ...overrides,
  };
}

Deno.test("the grounding is sent as its own fenced first user turn", async () => {
  const store = new FakeStore();
  const provider = new FakeProvider();

  await handleDigest(USER, config(store, provider));

  const request = provider.request!;
  assertEquals(request.system, SYSTEM_PROMPT);
  assertEquals(request.messages.length, 2);
  assertEquals(request.messages[0].role, "user");
  assertEquals(request.messages[0].content.startsWith(CONTEXT_OPEN), true);
  assertEquals(request.messages[0].content.trimEnd().endsWith(CONTEXT_CLOSE), true);
  assertEquals(request.maxTokens, DEFAULT_MAX_TOKENS);
});

Deno.test("the context turn carries positions, live thesis, history and notes", async () => {
  const store = new FakeStore();
  const provider = new FakeProvider();

  await handleDigest(USER, config(store, provider));

  const context = provider.request!.messages[0].content;
  assertStringIncludes(context, "AAPL");
  assertStringIncludes(context, "cost basis 1665.00");
  assertStringIncludes(context, "Services margin expansion is underappreciated.");
  assertStringIncludes(context, "Trim if services growth drops under 10% for two quarters.");
  assertStringIncludes(context, "Hardware is a floor, not the story.");
  assertStringIncludes(context, "services growth 8.4%");
});

Deno.test("the task turn is the prompt for the requested kind, not a rewrite", async () => {
  const store = new FakeStore();
  const provider = new FakeProvider();

  await handleDigest(USER, config(store, provider, { kind: "note-patterns" }));

  assertEquals(provider.request!.messages[1].content, TASK_PROMPTS["note-patterns"]);
  // The fenced block must not change between kinds — only the task after it.
  assertEquals(provider.request!.messages[0].content.startsWith(CONTEXT_OPEN), true);
});

Deno.test("the digest is stored with the grounding it was written from", async () => {
  const store = new FakeStore();
  const provider = new FakeProvider();

  const result = await handleDigest(USER, config(store, provider));

  assertEquals(result.digestId, "digest-1");
  assertEquals(result.body, "Your AAPL exit condition looks met.");
  assertEquals(result.model, "ollama/fake-model");
  assertEquals(result.provider, "ollama");
  assertEquals(result.usage.outputTokens, 90);
  assertEquals(result.grounding, {
    generatedAt: "2026-08-19T12:00:00.000Z",
    positions: 1,
    liveTheses: 1,
    supersededTheses: 1,
    notes: 1,
  });

  assertEquals(store.saved?.userId, USER);
  assertEquals(store.saved?.kind, "weekly-review");
  assertEquals(store.saved?.model, "ollama/fake-model");
  assertEquals(store.saved?.context.positions, POSITIONS);
  assertEquals(store.saved?.context.notes, NOTES);
});

// --- the consent gate -------------------------------------------------------

Deno.test("an unaccepted disclosure refuses before any journal row is read", async () => {
  const store = new FakeStore();
  store.acceptedVersion = null;
  const provider = new FakeProvider();

  await assertRejects(
    () => handleDigest(USER, config(store, provider)),
    DisclosureNotAcceptedError,
  );

  // Fail-closed means nothing was read, not merely nothing was sent.
  assertEquals(store.calls, ["acceptedDisclosureVersion"]);
  assertEquals(provider.request, undefined);
});

Deno.test("a stale accepted version refuses — old consent is not new consent", async () => {
  const store = new FakeStore();
  store.acceptedVersion = 1;
  const provider = new FakeProvider();

  const error = await assertRejects(
    () => handleDigest(USER, config(store, provider, { requiredDisclosureVersion: 2 })),
    DisclosureNotAcceptedError,
  );

  assertEquals(error.requiredVersion, 2);
  assertEquals(error.acceptedVersion, 1);
  assertEquals(provider.request, undefined);
});

Deno.test("an acceptance newer than this deployment requires is honoured", async () => {
  const store = new FakeStore();
  store.acceptedVersion = REQUIRED_DISCLOSURE_VERSION + 1;
  const provider = new FakeProvider();

  const result = await handleDigest(USER, config(store, provider));
  assertEquals(result.digestId, "digest-1");
});

Deno.test("a store that cannot answer the gate fails closed, not open", async () => {
  const store = new FakeStore();
  store.acceptedDisclosureVersion = () => Promise.reject(new Error("boom"));
  const provider = new FakeProvider();

  await assertRejects(() => handleDigest(USER, config(store, provider)), Error, "boom");
  assertEquals(provider.request, undefined);
});

// --- refusals that protect the output ---------------------------------------

Deno.test("an empty journal is refused rather than handed to the model to invent", async () => {
  const store = new FakeStore();
  store.positionRows = [];
  store.liveThesisRows = [];
  store.historyRows = [];
  store.noteRows = [];
  const provider = new FakeProvider();

  await assertRejects(() => handleDigest(USER, config(store, provider)), EmptyGroundingError);
  assertEquals(provider.request, undefined);
  assertEquals(store.saved, undefined);
});

Deno.test("an empty completion is an error, not a stored blank digest", async () => {
  const store = new FakeStore();
  const provider = new FakeProvider();
  provider.chunks = ["", "   "];

  await assertRejects(() => handleDigest(USER, config(store, provider)), EmptyDigestError);
  assertEquals(store.saved, undefined);
});

// --- framing ----------------------------------------------------------------

Deno.test("the system prompt still states the framing this feature is built on", () => {
  // Not a style check: "research assistant, never a stock picker" is the product
  // decision, and it lives in exactly one place. If someone softens it, this is
  // the only thing standing between that and a shipped price forecast.
  assertStringIncludes(SYSTEM_PROMPT, "not a stock picker");
  assertStringIncludes(SYSTEM_PROMPT, "Do not predict, forecast, or estimate a future price");
  assertStringIncludes(SYSTEM_PROMPT, "Do not recommend buying, selling, holding");
  assertStringIncludes(SYSTEM_PROMPT, "USER-CONTROLLED DATA");
  assertStringIncludes(SYSTEM_PROMPT, CONTEXT_OPEN);
  assertStringIncludes(SYSTEM_PROMPT, CONTEXT_CLOSE);
});
