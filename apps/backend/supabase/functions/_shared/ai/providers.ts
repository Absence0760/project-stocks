/**
 * Model providers, behind one streaming interface.
 *
 * Two implementations, one shape:
 *
 *   - `AnthropicProvider`      — the Messages API, SSE.
 *   - `OpenAiCompatibleProvider` — an OpenAI-shaped `/chat/completions`, pointed
 *     by default at a local Ollama on http://127.0.0.1:11434/v1.
 *
 * **The default is the local one.** CLAUDE.md's local-first rule is not a
 * preference: the dev path must run on a laptop with no cloud account, so a
 * missing `AI_PROVIDER` resolves to Ollama and a missing `ANTHROPIC_API_KEY` is
 * only an error when someone explicitly asked for Anthropic.
 *
 * Plain `fetch`, no SDK — docs/STACK.md forbids letting Deno resolve npm here
 * (it writes a `workspaces` field into the root package.json), and both wire
 * formats are a POST and an SSE parse.
 *
 * Credentials are read from the environment by the caller and held in memory for
 * the life of one request. Nothing here logs, echoes, or serialises a key: error
 * messages name the *variable*, never the value.
 */

export const PROVIDER_IDS = ["ollama", "anthropic"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Local-first: this is the default with no configuration at all. */
export const DEFAULT_PROVIDER_ID: ProviderId = "ollama";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface Usage {
  /** Provider-qualified model id, e.g. `ollama/llama3.2`. */
  model: string;
  /** null when the provider did not report a count. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
}

/**
 * One in-flight completion.
 *
 * `finalUsage()` resolves once the token stream has been drained — the counts
 * only exist in the last few SSE frames. Awaiting it *before* consuming `tokens`
 * waits forever, because nothing is pulling the response body.
 */
export interface ProviderStream {
  tokens: AsyncIterable<string>;
  finalUsage(): Promise<Usage>;
}

export interface Provider {
  readonly id: ProviderId;
  /** Bare model id as the provider knows it. */
  readonly model: string;
  /** `<provider>/<model>` — what gets stored on the digest row. */
  readonly qualifiedModel: string;
  stream(request: ProviderRequest): Promise<ProviderStream>;
}

/** An upstream call failed. `status` is absent for transport-level failures. */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The provider is reachable but does not have the requested model. */
export class ModelNotInstalledError extends ProviderError {
  constructor(message: string, readonly model: string) {
    super(message, 404);
    this.name = "ModelNotInstalledError";
  }
}

/** The environment does not describe a usable provider. */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * The actionable form of Ollama's 404.
 *
 * Ollama answers a request for a model it has not pulled with a 404 and a terse
 * body, which surfaces to the operator as "the AI is broken". The fix is a single
 * command, so the error should be that command.
 */
export function modelNotInstalledMessage(model: string): string {
  return `the local model "${model}" is not installed on the Ollama host — run: ollama pull ${model}`;
}

async function upstreamFailure(
  providerId: ProviderId,
  model: string,
  response: Response,
): Promise<ProviderError> {
  const text = await response.text().catch(() => "");

  if (providerId === "ollama" && response.status === 404) {
    return new ModelNotInstalledError(modelNotInstalledMessage(model), model);
  }

  // Both providers return a JSON error envelope; surface its message rather than
  // the whole blob, which can carry the echoed request.
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
    else if (parsed.message) detail = parsed.message;
  } catch {
    // non-JSON body — use it as-is
  }

  return new ProviderError(
    `${providerId} request failed: ${response.status}${detail === "" ? "" : ` ${detail}`}`,
    response.status,
  );
}

/**
 * Yield the payload of each `data:` line of an SSE response.
 *
 * Shared by both providers because it is byte plumbing, not policy — the two
 * differ in how they interpret a frame, and each owns that loop below.
 */
async function* sseData(response: Response): AsyncGenerator<string> {
  if (response.body === null) throw new ProviderError("upstream returned no response body");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
        newline = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    // A consumer that breaks early (an aborted request) must not leave the
    // connection open.
    await reader.cancel().catch(() => {});
  }
}

interface MutableUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Bridge a token generator to the ProviderStream shape.
 *
 * The usage counts arrive in the *last* frames of the stream, so `finalUsage()`
 * hands out a promise settled by the generator finishing. Written once and used
 * by both providers: it is deferred-resolution plumbing, and two hand-rolled
 * copies of it is how you get one that silently never settles.
 */
function streamFrom(
  qualifiedModel: string,
  produce: (usage: MutableUsage) => AsyncGenerator<string>,
): ProviderStream {
  const usage: MutableUsage = { inputTokens: null, outputTokens: null };

  let resolve!: (value: Usage) => void;
  let reject!: (reason: unknown) => void;
  const settled = new Promise<Usage>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A caller may legitimately never await finalUsage(); keep a failed stream from
  // surfacing as an unhandled rejection on top of the error it already threw.
  settled.catch(() => {});

  async function* tokens(): AsyncGenerator<string> {
    try {
      yield* produce(usage);
      resolve({ model: qualifiedModel, ...usage });
    } catch (error) {
      reject(error);
      throw error;
    }
  }

  return { tokens: tokens(), finalUsage: () => settled };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

interface AnthropicEvent {
  type?: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { type?: string; text?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

async function* anthropicEvents(
  response: Response,
  usage: MutableUsage,
): AsyncGenerator<string> {
  for await (const data of sseData(response)) {
    if (data === "") continue;

    let event: AnthropicEvent;
    try {
      event = JSON.parse(data) as AnthropicEvent;
    } catch {
      continue; // keep-alive or a frame we don't model
    }

    switch (event.type) {
      case "message_start":
        usage.inputTokens = event.message?.usage?.input_tokens ?? null;
        break;
      case "content_block_delta":
        // Ignore thinking_delta and input_json_delta: a digest is prose.
        if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          yield event.delta.text;
        }
        break;
      case "message_delta":
        if (typeof event.usage?.output_tokens === "number") {
          usage.outputTokens = event.usage.output_tokens;
        }
        break;
      case "error":
        throw new ProviderError(
          `anthropic stream error: ${event.error?.message ?? "unspecified"}`,
        );
    }
  }
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injected so the wire shape is testable without a network. */
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  readonly id: ProviderId = "anthropic";
  readonly model: string;
  readonly qualifiedModel: string;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.qualifiedModel = `${this.id}/${this.model}`;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async stream(request: ProviderRequest): Promise<ProviderStream> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        stream: true,
      }),
    });

    if (!response.ok) throw await upstreamFailure(this.id, this.model, response);

    return streamFrom(this.qualifiedModel, (usage) => anthropicEvents(response, usage));
  }
}

// ---------------------------------------------------------------------------
// OpenAI-shaped (local Ollama)
// ---------------------------------------------------------------------------

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

async function* openAiEvents(
  response: Response,
  usage: MutableUsage,
): AsyncGenerator<string> {
  for await (const data of sseData(response)) {
    if (data === "" || data === "[DONE]") continue;

    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(data) as OpenAiChunk;
    } catch {
      continue;
    }

    if (chunk.error !== undefined) {
      const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
      throw new ProviderError(`ollama stream error: ${message ?? "unspecified"}`);
    }

    // The usage frame carries no choices, and arrives last.
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === "number") {
        usage.inputTokens = chunk.usage.prompt_tokens;
      }
      if (typeof chunk.usage.completion_tokens === "number") {
        usage.outputTokens = chunk.usage.completion_tokens;
      }
    }

    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text !== "") yield text;
  }
}

export interface OpenAiCompatibleOptions {
  model?: string;
  baseUrl?: string;
  /**
   * Only for an OpenAI-shaped endpoint that wants one. A local Ollama needs no
   * credential, which is the entire point of it being the default.
   */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: ProviderId = "ollama";
  readonly model: string;
  readonly qualifiedModel: string;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleOptions = {}) {
    this.model = options.model ?? DEFAULT_OLLAMA_MODEL;
    this.qualifiedModel = `${this.id}/${this.model}`;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = options.apiKey === "" ? undefined : options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async stream(request: ProviderRequest): Promise<ProviderStream> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey !== undefined) headers.authorization = `Bearer ${this.#apiKey}`;

    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        stream: true,
        // Ollama omits usage entirely unless asked; without this every digest
        // records null token counts.
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: request.system },
          ...request.messages,
        ],
      }),
    });

    if (!response.ok) throw await upstreamFailure(this.id, this.model, response);

    return streamFrom(this.qualifiedModel, (usage) => openAiEvents(response, usage));
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The environment slice this module reads. Passed in rather than pulled from
 * `Deno.env` so provider selection is testable without env permissions, and so
 * the edge function stays the only place that touches the process environment.
 */
export interface AiEnv {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  OLLAMA_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}

/**
 * One env var picks the provider, and its absence picks the local one.
 *
 * A fresh clone with no configuration gets Ollama; only an explicit
 * `AI_PROVIDER=anthropic` requires a paid key, and then the error names the
 * variable that is missing — never its value.
 */
export function providerFromEnv(env: AiEnv, fetchImpl: typeof fetch = fetch): Provider {
  const requested = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const id = requested === "" ? DEFAULT_PROVIDER_ID : requested;

  if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
    throw new ProviderConfigError(
      `unknown AI_PROVIDER "${requested}" (expected one of: ${PROVIDER_IDS.join(", ")})`,
    );
  }

  const model = (env.AI_MODEL ?? "").trim();

  if (id === "anthropic") {
    const apiKey = (env.ANTHROPIC_API_KEY ?? "").trim();
    if (apiKey === "") {
      throw new ProviderConfigError(
        "AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set",
      );
    }
    return new AnthropicProvider({
      apiKey,
      model: model === "" ? undefined : model,
      baseUrl: env.ANTHROPIC_BASE_URL,
      fetchImpl,
    });
  }

  return new OpenAiCompatibleProvider({
    model: model === "" ? undefined : model,
    baseUrl: env.OLLAMA_BASE_URL,
    fetchImpl,
  });
}
