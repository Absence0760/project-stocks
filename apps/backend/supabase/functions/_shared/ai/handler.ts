/**
 * Digest orchestration, written against `DigestStore` and `Provider` so it stays
 * testable — same seam as `_shared/ingest/handler.ts`.
 *
 * Returns a result, not a `Response`: the transport wrapper in
 * `functions/ai-digest/index.ts` decides status codes and CORS. Everything that
 * can be got wrong — the consent gate, what grounding is assembled, what is
 * persisted — lives here, where a unit test can reach it.
 *
 * Order is part of the contract. The consent check runs **first**, before any
 * position, thesis or note is read: a refusal must not be a refusal that already
 * loaded the journal it was refusing to send.
 */

import { assembleContext, contextTurn } from "./context.ts";
import {
  DisclosureNotAcceptedError,
  isDisclosureAccepted,
  REQUIRED_DISCLOSURE_VERSION,
} from "./disclosure.ts";
import { SYSTEM_PROMPT, TASK_PROMPTS } from "./system_prompt.ts";
import type { Provider, ProviderId, Usage } from "./providers.ts";
import type { DigestStore } from "./store.ts";
import type { DigestKind } from "./types.ts";

/** A digest is prose read on a phone, not an essay. */
export const DEFAULT_MAX_TOKENS = 2048;

export interface DigestConfig {
  kind: DigestKind;
  store: DigestStore;
  provider: Provider;
  maxTokens?: number;
  noteLimit?: number;
  historyLimit?: number;
  /** Injected so a run is reproducible in tests. */
  now?: () => Date;
  /** Overridable only so a test can exercise a bumped ladder. */
  requiredDisclosureVersion?: number;
}

export interface DigestResult {
  digestId: string;
  kind: DigestKind;
  body: string;
  /** Provider-qualified model id, as stored. */
  model: string;
  provider: ProviderId;
  usage: Usage;
  /** What the answer was grounded on — counts, not the data itself. */
  grounding: {
    generatedAt: string;
    positions: number;
    liveTheses: number;
    supersededTheses: number;
    notes: number;
  };
}

/** The provider returned a stream that produced no text. */
export class EmptyDigestError extends Error {
  constructor() {
    super("the model returned an empty response");
    this.name = "EmptyDigestError";
  }
}

/**
 * There is nothing in the journal to summarise.
 *
 * Refused rather than sent: a model handed an empty context and asked to review a
 * portfolio will write something, and everything it writes will be invented. An
 * empty journal is a UI state ("import a statement, write a thesis"), not a
 * digest.
 */
export class EmptyGroundingError extends Error {
  constructor() {
    super("no positions, theses or notes to ground a digest on");
    this.name = "EmptyGroundingError";
  }
}

export async function handleDigest(
  userId: string,
  config: DigestConfig,
): Promise<DigestResult> {
  const { kind, store, provider } = config;
  const required = config.requiredDisclosureVersion ?? REQUIRED_DISCLOSURE_VERSION;

  // --- consent, before anything is read -------------------------------------
  //
  // Fail-closed: no acceptance refuses, a stale acceptance refuses, and a store
  // that throws propagates rather than being caught into a permissive default.
  const accepted = await store.acceptedDisclosureVersion(userId);
  if (!isDisclosureAccepted(accepted, required)) {
    throw new DisclosureNotAcceptedError(required, accepted);
  }

  // --- grounding ------------------------------------------------------------
  const grounding = await assembleContext(userId, store, {
    noteLimit: config.noteLimit,
    historyLimit: config.historyLimit,
    now: config.now,
  });

  const rowCount = grounding.positions.length + grounding.liveTheses.length +
    grounding.supersededTheses.length + grounding.notes.length;
  if (rowCount === 0) throw new EmptyGroundingError();

  // --- generation -----------------------------------------------------------
  //
  // The grounding is its own first user turn, fenced by <CONTEXT> markers the
  // system prompt names as a data boundary; the task follows as a second turn so
  // the fenced block stays byte-identical between kinds.
  const stream = await provider.stream({
    system: SYSTEM_PROMPT,
    messages: [
      contextTurn(grounding),
      { role: "user", content: TASK_PROMPTS[kind] },
    ],
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  });

  const chunks: string[] = [];
  for await (const token of stream.tokens) chunks.push(token);
  const body = chunks.join("").trim();

  // Only meaningful once the stream is drained — see ProviderStream.
  const usage = await stream.finalUsage();

  if (body === "") throw new EmptyDigestError();

  // --- persistence ----------------------------------------------------------
  const digestId = await store.saveDigest({
    userId,
    kind,
    body,
    context: grounding,
    model: provider.qualifiedModel,
  });

  return {
    digestId,
    kind,
    body,
    model: provider.qualifiedModel,
    provider: provider.id,
    usage,
    grounding: {
      generatedAt: grounding.generatedAt,
      positions: grounding.positions.length,
      liveTheses: grounding.liveTheses.length,
      supersededTheses: grounding.supersededTheses.length,
      notes: grounding.notes.length,
    },
  };
}
