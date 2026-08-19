import { assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  ModelNotInstalledError,
  modelNotInstalledMessage,
  OpenAiCompatibleProvider,
  type Provider,
  ProviderConfigError,
  ProviderError,
  providerFromEnv,
  type ProviderRequest,
} from "./providers.ts";

/**
 * A stand-in `fetch` that records what was sent and replays a canned response.
 * Every test here runs with no network and no environment access.
 */
function recordingFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url, init ?? {}));
  };
  return { impl, calls };
}

function sse(frames: string[]): Response {
  return new Response(
    frames.map((frame) => `data: ${frame}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const REQUEST: ProviderRequest = {
  system: "you are a journal",
  messages: [
    { role: "user", content: "<CONTEXT>positions</CONTEXT>" },
    { role: "user", content: "draft the digest" },
  ],
  maxTokens: 512,
};

async function drain(provider: Provider): Promise<{ text: string; input: number | null; output: number | null }> {
  const stream = await provider.stream(REQUEST);
  let text = "";
  for await (const token of stream.tokens) text += token;
  const usage = await stream.finalUsage();
  return { text, input: usage.inputTokens, output: usage.outputTokens };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// --- the Ollama 404 ---------------------------------------------------------

Deno.test("the pull hint names the exact command that fixes it", () => {
  assertStringIncludes(modelNotInstalledMessage("llama3.2"), "ollama pull llama3.2");
});

Deno.test("an upstream 404 from Ollama becomes an actionable pull instruction", async () => {
  // What Ollama actually answers for a model that has not been pulled.
  const { impl } = recordingFetch(() =>
    new Response(
      JSON.stringify({ error: { message: 'model "llama3.2" not found', type: "api_error" } }),
      { status: 404 },
    )
  );
  const provider = new OpenAiCompatibleProvider({ fetchImpl: impl });

  const error = await assertRejects(() => provider.stream(REQUEST), ModelNotInstalledError);

  assertStringIncludes(error.message, "ollama pull llama3.2");
  assertEquals(error.model, "llama3.2");
  assertEquals(error.status, 404);
});

Deno.test("the pull hint follows the configured model, not the default", async () => {
  const { impl } = recordingFetch(() => new Response("not found", { status: 404 }));
  const provider = new OpenAiCompatibleProvider({ model: "qwen3:8b", fetchImpl: impl });

  const error = await assertRejects(() => provider.stream(REQUEST), ModelNotInstalledError);
  assertStringIncludes(error.message, "ollama pull qwen3:8b");
});

Deno.test("a 404 from Anthropic is not a pull instruction", async () => {
  const { impl } = recordingFetch(() =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: nope" } }),
      { status: 404 },
    )
  );
  const provider = new AnthropicProvider({ apiKey: "test-key-not-real", model: "nope", fetchImpl: impl });

  const error = await assertRejects(() => provider.stream(REQUEST), ProviderError);

  assertEquals(error instanceof ModelNotInstalledError, false);
  assertStringIncludes(error.message, "model: nope");
  assertEquals(error.status, 404);
});

Deno.test("a non-404 upstream failure surfaces the provider's message, not the blob", async () => {
  const { impl } = recordingFetch(() =>
    new Response(JSON.stringify({ error: { message: "context length exceeded" } }), { status: 400 })
  );
  const provider = new OpenAiCompatibleProvider({ fetchImpl: impl });

  const error = await assertRejects(() => provider.stream(REQUEST), ProviderError);
  assertStringIncludes(error.message, "context length exceeded");
  assertEquals(error.status, 400);
});

// --- the OpenAI-shaped wire format -----------------------------------------

Deno.test("the local provider streams content and reports usage", async () => {
  const { impl, calls } = recordingFetch(() =>
    sse([
      JSON.stringify({ choices: [{ delta: { content: "Your AAPL " } }] }),
      JSON.stringify({ choices: [{ delta: { content: "exit condition looks met." } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 90 } }),
      "[DONE]",
    ])
  );

  const result = await drain(new OpenAiCompatibleProvider({ fetchImpl: impl }));

  assertEquals(result.text, "Your AAPL exit condition looks met.");
  assertEquals(result.input, 1200);
  assertEquals(result.output, 90);

  assertEquals(calls[0].url, `${DEFAULT_OLLAMA_BASE_URL}/chat/completions`);
  const body = bodyOf(calls[0].init);
  assertEquals(body.model, DEFAULT_OLLAMA_MODEL);
  assertEquals(body.stream, true);
  assertEquals(body.stream_options, { include_usage: true });
  assertEquals(body.max_tokens, 512);
  // The system prompt is folded in as the first message; the fenced context turn
  // stays a separate user turn ahead of the task.
  assertEquals(body.messages, [
    { role: "system", content: "you are a journal" },
    { role: "user", content: "<CONTEXT>positions</CONTEXT>" },
    { role: "user", content: "draft the digest" },
  ]);
});

Deno.test("a local provider needs no credential", async () => {
  const { impl, calls } = recordingFetch(() => sse([JSON.stringify({ choices: [{ delta: { content: "hi" } }] })]));

  await drain(new OpenAiCompatibleProvider({ fetchImpl: impl }));

  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals("authorization" in headers, false);
});

Deno.test("a mid-stream error frame is raised, not silently truncated", async () => {
  const { impl } = recordingFetch(() =>
    sse([
      JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
      JSON.stringify({ error: { message: "the model crashed" } }),
    ])
  );
  const provider = new OpenAiCompatibleProvider({ fetchImpl: impl });

  const stream = await provider.stream(REQUEST);
  await assertRejects(async () => {
    for await (const _ of stream.tokens) { /* drain until it throws */ }
  }, ProviderError, "the model crashed");
});

// --- the Anthropic wire format ----------------------------------------------

Deno.test("the Anthropic provider streams text deltas and reports usage", async () => {
  const { impl, calls } = recordingFetch(() =>
    sse([
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1200 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Your AAPL " } }),
      // Thinking is not prose the user asked for; it must not land in the digest.
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "exit condition looks met." } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 90 } }),
      JSON.stringify({ type: "message_stop" }),
    ])
  );

  const result = await drain(new AnthropicProvider({ apiKey: "test-key-not-real", fetchImpl: impl }));

  assertEquals(result.text, "Your AAPL exit condition looks met.");
  assertEquals(result.input, 1200);
  assertEquals(result.output, 90);

  assertStringIncludes(calls[0].url, "/v1/messages");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["anthropic-version"], "2023-06-01");
  assertEquals(headers["x-api-key"], "test-key-not-real");

  const body = bodyOf(calls[0].init);
  assertEquals(body.model, DEFAULT_ANTHROPIC_MODEL);
  assertEquals(body.stream, true);
  assertEquals(body.system, "you are a journal");
  assertEquals(body.max_tokens, 512);
  assertEquals(body.messages, REQUEST.messages);
});

Deno.test("keep-alives and unparseable frames are ignored, not fatal", async () => {
  const { impl } = recordingFetch(() =>
    new Response(
      [
        "event: ping\n",
        "data: \n\n",
        "data: not json\n\n",
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })}\n\n`,
      ].join(""),
      { status: 200 },
    )
  );

  const result = await drain(new AnthropicProvider({ apiKey: "test-key-not-real", fetchImpl: impl }));
  assertEquals(result.text, "ok");
  // Nothing reported a count, and null says so rather than pretending it was 0.
  assertEquals(result.input, null);
  assertEquals(result.output, null);
});

Deno.test("an Anthropic error event aborts the stream", async () => {
  const { impl } = recordingFetch(() =>
    sse([
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }),
      JSON.stringify({ type: "error", error: { message: "overloaded_error" } }),
    ])
  );
  const provider = new AnthropicProvider({ apiKey: "test-key-not-real", fetchImpl: impl });

  const stream = await provider.stream(REQUEST);
  await assertRejects(async () => {
    for await (const _ of stream.tokens) { /* drain until it throws */ }
  }, ProviderError, "overloaded_error");
});

// --- selection --------------------------------------------------------------

Deno.test("no configuration at all resolves to the local provider", () => {
  const provider = providerFromEnv({});

  assertInstanceOf(provider, OpenAiCompatibleProvider);
  assertEquals(provider.id, "ollama");
  assertEquals(provider.model, DEFAULT_OLLAMA_MODEL);
  assertEquals(provider.qualifiedModel, `ollama/${DEFAULT_OLLAMA_MODEL}`);
});

Deno.test("the local provider is selected without any API key present", () => {
  // The dev path must never require a paid credential — CLAUDE.md, local-first.
  const provider = providerFromEnv({ AI_MODEL: "qwen3:8b", OLLAMA_BASE_URL: "http://ollama.local/v1" });
  assertEquals(provider.model, "qwen3:8b");
  assertEquals(provider.id, "ollama");
});

Deno.test("asking for Anthropic without a key names the variable, not a value", () => {
  const error = assertThrowsConfig(() => providerFromEnv({ AI_PROVIDER: "anthropic" }));
  assertStringIncludes(error.message, "ANTHROPIC_API_KEY");
});

Deno.test("an unknown provider is rejected rather than silently defaulted", () => {
  const error = assertThrowsConfig(() => providerFromEnv({ AI_PROVIDER: "openai" }));
  assertStringIncludes(error.message, "openai");
});

Deno.test("AI_PROVIDER=anthropic with a key resolves to the Anthropic provider", () => {
  const provider = providerFromEnv({
    AI_PROVIDER: "Anthropic",
    ANTHROPIC_API_KEY: "test-key-not-real",
  });

  assertInstanceOf(provider, AnthropicProvider);
  assertEquals(provider.qualifiedModel, `anthropic/${DEFAULT_ANTHROPIC_MODEL}`);
});

function assertThrowsConfig(fn: () => unknown): ProviderConfigError {
  try {
    fn();
  } catch (error) {
    assertInstanceOf(error, ProviderConfigError);
    return error;
  }
  throw new Error("expected a ProviderConfigError");
}
