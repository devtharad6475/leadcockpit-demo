/**
 * Golden test — LLM provider adapter contracts (Stage A.3).
 *
 * Skill build-right Phase 3: pins the SHAPE of each adapter's HTTP request +
 * the parsing of its response, using a stubbed global `fetch`. The 3 adapters
 * built in Stage A.3 (Anthropic, Gemini, MiniMax) replaced throw-on-every-call
 * stubs. This test asserts:
 *
 *   1. Each adapter sends the RIGHT request shape to the RIGHT URL with the
 *      RIGHT auth (no key leakage to wrong headers; key in URL only for
 *      Gemini where that's the API contract).
 *   2. Each adapter parses its provider's response shape correctly into the
 *      shared {output, rawText, usage} contract.
 *   3. The JSON-extraction fallback handles a model that wraps JSON in prose.
 *   4. Empty/null responses throw a typed error (no silent undefined).
 *
 * Why stubbed fetch (not real API calls): the same hand-computed expected
 * values can be asserted WITHOUT depending on a real API key being present.
 * Real-key round-trip is proven by the per-slot "Test slot" button in the AI
 * Settings UI (POST /api/ai/model-slots/:slotId/test) — that's the operator's
 * proof at runtime. This test is the MATH/CONTRACT layer.
 *
 * Anti-cheat: the stubbed fetch captures the actual request body + headers +
 * URL the adapter generated, then returns a canned response. The assertions
 * check the captured values. If anyone "hardcodes" a parse result, the
 * captured-request assertions still fail (because the request shape would
 * differ).
 *
 * Run: npx tsx scripts/golden/golden-llm-adapters.ts
 */
export {};

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Install a stubbed global fetch that records every call + returns the canned
 * response. Returns the captured calls so assertions can inspect them.
 *
 * 2026-07-26 Session 4 (P2-LLM-1 + P2-LLM-2): the responder now also supports
 * `text` (for HTML/proxy error pages) and a custom `contentType`. Without this,
 * we couldn't test the "provider returned HTML not JSON" edge case.
 */
type StubResponse = { status: number; json?: unknown; text?: string; contentType?: string };
function installStubFetch(responder: (call: FetchCall) => StubResponse): FetchCall[] {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Normalize headers to lowercase keys for case-insensitive lookup (HTTP
    // headers are case-insensitive; providers send "Authorization" and
    // "x-api-key" with different casing).
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      Object.keys(h).forEach((k) => { headers[k.toLowerCase()] = h[k]; });
    }
    const call: FetchCall = { url, method: init?.method || "GET", headers, body: init?.body ? String(init.body) : "" };
    calls.push(call);
    const { status, json, text, contentType } = responder(call);
    const bodyText = text !== undefined ? text : JSON.stringify(json);
    return new Response(bodyText, {
      status,
      headers: { "content-type": contentType || "application/json" },
    });
  }) as typeof globalThis.fetch;
  return calls;
}

function restoreFetch(originalFetch: typeof globalThis.fetch) {
  globalThis.fetch = originalFetch;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ORIGINAL_FETCH = globalThis.fetch;

async function testAnthropicAdapter() {
  console.log("  [1] Anthropic adapter — request shape + response parsing...");
  const { AnthropicCompatibleProvider } = await import("../../src/llm/providers/AnthropicCompatibleProvider");
  const calls = installStubFetch(() => ({
    status: 200,
    json: {
      // Anthropic Messages API response shape
      content: [{ type: "text", text: '{"reply":"Hello from Claude","confidence":0.9}' }],
      usage: { input_tokens: 50, output_tokens: 12 },
    },
  }));
  try {
    const provider = new AnthropicCompatibleProvider({
      provider: "anthropic", apiKey: "sk-ant-test-key", baseUrl: "https://api.anthropic.com",
    });
    // N-TEST-10 (2026-08-26, S29). This call carried `as never`, which turned
    // OFF checking of the WHOLE argument — modelName and prompt included —
    // to hide two REQUIRED fields it was not passing: `taskName` and
    // `modelTier`. Every adapter under test destructures only
    // { modelName, prompt, input } (AnthropicCompatibleProvider.ts:68), so
    // supplying the two real fields changes no behaviour and no captured
    // request; it only restores the compiler's check on the rest of the
    // object. Values chosen to match what each case is actually about.
    const result = await provider.runJsonTask({
      taskName: "whatsapp_reply",
      modelTier: "balanced",
      modelName: "claude-haiku-4-5",
      prompt: "You are a helpful agent.",
      input: { customerMessage: "Hi" },
    });

    // --- Request shape assertions ---
    assert(calls.length === 1, `Expected exactly 1 HTTP call, got ${calls.length}.`);
    const call = calls[0];
    assert(call.url === "https://api.anthropic.com/v1/messages",
      `URL should be the Messages endpoint; got ${call.url}.`);
    assert(call.method === "POST", `Method should be POST; got ${call.method}.`);
    assert(call.headers["x-api-key"] === "sk-ant-test-key",
      `x-api-key header should carry the API key; got ${call.headers["x-api-key"]}.`);
    assert(call.headers["anthropic-version"] === "2023-06-01",
      `anthropic-version header should be set; got ${call.headers["anthropic-version"]}.`);
    // NO Authorization header (Anthropic doesn't use Bearer)
    assert(call.headers["authorization"] === undefined,
      `Anthropic must NOT send an Authorization Bearer header (would leak key); got ${call.headers["authorization"]}.`);

    // Request body shape
    const body = JSON.parse(call.body);
    assert(body.model === "claude-haiku-4-5", `Body model should match; got ${body.model}.`);
    assert(body.max_tokens === 4096, `Body max_tokens should be 4096; got ${body.max_tokens}.`);
    assert(typeof body.system === "string" && body.system.includes("Return valid JSON only"),
      `Body system should include the JSON-only instruction; got ${body.system}.`);
    assert(Array.isArray(body.messages) && body.messages[0]?.role === "user",
      `Body messages should be an array starting with a user message.`);

    // --- Response parsing assertions ---
    const out = result.output as { reply?: string; confidence?: number };
    assert(out.reply === "Hello from Claude",
      `Parsed output should contain the reply; got ${JSON.stringify(result.output)}.`);
    assert(result.usage?.promptTokens === 50,
      `Usage promptTokens should be 50 (Anthropic input_tokens); got ${result.usage?.promptTokens}.`);
    assert(result.usage?.completionTokens === 12,
      `Usage completionTokens should be 12 (Anthropic output_tokens); got ${result.usage?.completionTokens}.`);
    assert(result.usage?.totalTokens === 62,
      `Usage totalTokens should be 62 (input+output); got ${result.usage?.totalTokens}.`);
    console.log("    OK Anthropic: right URL, x-api-key auth, JSON-only system prompt, usage parsed");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

async function testGeminiAdapter() {
  console.log("  [2] Gemini adapter — request shape + response parsing...");
  const { GeminiCompatibleProvider } = await import("../../src/llm/providers/GeminiCompatibleProvider");
  const calls = installStubFetch(() => ({
    status: 200,
    json: {
      // Gemini generateContent response shape
      candidates: [{ content: { parts: [{ text: '{"summary":"Gemini reply","score":7}' }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, totalTokenCount: 38 },
    },
  }));
  try {
    const provider = new GeminiCompatibleProvider({
      provider: "gemini", apiKey: "AIza-test-key", baseUrl: "https://generativelanguage.googleapis.com",
    });
    const result = await provider.runJsonTask({
      taskName: "knowledge_answer",
      modelTier: "fast",
      modelName: "gemini-2.0-flash",
      prompt: "Summarize this.",
      input: { text: "Some content" },
    });

    assert(calls.length === 1, `Expected exactly 1 HTTP call, got ${calls.length}.`);
    const call = calls[0];
    // URL must include the model path + key as query param (Gemini contract)
    assert(call.url.includes("/v1beta/models/gemini-2.0-flash:generateContent"),
      `URL should include the model + generateContent; got ${call.url}.`);
    assert(call.url.includes("key=AIza-test-key"),
      `URL should include the API key as a query param (Gemini contract); got ${call.url}.`);
    assert(call.method === "POST", `Method should be POST; got ${call.method}.`);
    // NO Authorization header (Gemini uses query param, not Bearer)
    assert(call.headers["authorization"] === undefined,
      `Gemini must NOT send an Authorization Bearer header; got ${call.headers["authorization"]}.`);

    // Body shape: systemInstruction + contents + generationConfig
    const body = JSON.parse(call.body);
    assert(body.systemInstruction?.parts?.[0]?.text?.includes("Return valid JSON only"),
      `systemInstruction should include JSON-only instruction.`);
    assert(Array.isArray(body.contents) && body.contents[0]?.role === "user",
      `contents should be an array starting with a user message.`);
    assert(body.generationConfig?.temperature === 0,
      `generationConfig.temperature should be 0; got ${body.generationConfig?.temperature}.`);

    // Response parsing
    assert((result.output as { summary: string }).summary === "Gemini reply",
      `Parsed output should contain the summary.`);
    assert(result.usage?.promptTokens === 30,
      `Usage promptTokens should be 30; got ${result.usage?.promptTokens}.`);
    assert(result.usage?.totalTokens === 38,
      `Usage totalTokens should be 38; got ${result.usage?.totalTokens}.`);
    console.log("    OK Gemini: model-in-URL, key as query param, systemInstruction body, usage parsed");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

async function testMiniMaxAdapter() {
  console.log("  [3] MiniMax adapter — reuses OpenAI shape (was throw-stub)...");
  const { MiniMaxProvider } = await import("../../src/llm/providers/OpenAICompatibleProvider");
  const calls = installStubFetch(() => ({
    status: 200,
    // OpenAI-compatible response shape (MiniMax uses this)
    json: {
      choices: [{ message: { content: '{"decision":"approved"}' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  }));
  try {
    const provider = new MiniMaxProvider({ apiKey: "mm-test-key" });
    const result = await provider.runJsonTask({
      taskName: "lead_review_decision",
      modelTier: "balanced",
      modelName: "MiniMax-Text-01",
      prompt: "Decide.",
      input: { x: 1 },
    });

    assert(calls.length === 1, `Expected 1 call, got ${calls.length}.`);
    const call = calls[0];
    // MiniMax extends OpenAICompatibleProvider → POST {baseUrl}/chat/completions
    assert(call.url === "https://api.minimax.io/v1/chat/completions",
      `URL should be the MiniMax chat completions endpoint; got ${call.url}.`);
    assert(call.headers["authorization"] === "Bearer mm-test-key",
      `Authorization header should be Bearer + key (OpenAI shape); got ${call.headers["authorization"]}.`);
    assert((result.output as { decision: string }).decision === "approved",
      `Parsed output should contain the decision.`);
    assert(result.usage?.totalTokens === 25,
      `Usage totalTokens should be 25; got ${result.usage?.totalTokens}.`);
    console.log("    OK MiniMax: OpenAI-compatible shape, Bearer auth, usage parsed (was throw-stub)");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

async function testJsonExtractionFallback() {
  console.log("  [4] JSON-extraction handles prose-wrapped responses...");
  const { AnthropicCompatibleProvider } = await import("../../src/llm/providers/AnthropicCompatibleProvider");
  // A model that wraps JSON in explanation prose (common in real usage).
  installStubFetch(() => ({
    status: 200,
    json: {
      content: [{ type: "text", text: "Here is the JSON you asked for:\n```json\n{\"value\":42}\n```\nHope this helps!" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  }));
  try {
    const provider = new AnthropicCompatibleProvider({
      provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "https://api.anthropic.com",
    });
    const result = await provider.runJsonTask({
      taskName: "document_extraction_mapping", modelTier: "fast",
      modelName: "claude-haiku-4-5", prompt: "x", input: {},
    });
    assert((result.output as { value: number }).value === 42,
      `Brace-extractor should pull the JSON object out of the prose; got ${JSON.stringify(result.output)}.`);
    console.log("    OK prose-wrapped JSON extracted via brace-matcher");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

async function testEmptyResponseThrows() {
  console.log("  [5] Empty/null response throws typed error (no silent undefined)...");
  const { GeminiCompatibleProvider } = await import("../../src/llm/providers/GeminiCompatibleProvider");
  // Empty content (model returned nothing)
  installStubFetch(() => ({
    status: 200,
    json: { candidates: [{ content: { parts: [{ text: "{}" }] } }] },
  }));
  try {
    const provider = new GeminiCompatibleProvider({
      provider: "gemini", apiKey: "AIza-test", baseUrl: "https://generativelanguage.googleapis.com",
    });
    let threw = false;
    try {
      await provider.runJsonTask({ taskName: "knowledge_answer", modelTier: "fast", modelName: "gemini-2.0-flash", prompt: "x", input: {} });
    } catch (error) {
      threw = true;
      assert(/empty or null/i.test(error instanceof Error ? error.message : ""),
        `Error should mention empty/null; got: ${error instanceof Error ? error.message : error}`);
    }
    assert(threw, "An empty response MUST throw (no silent undefined returned).");
    console.log("    OK empty response throws (No Silent Failures rule)");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

async function testMissingKeyThrows() {
  console.log("  [6] Missing API key throws clear error before any HTTP call...");
  const { AnthropicCompatibleProvider } = await import("../../src/llm/providers/AnthropicCompatibleProvider");
  let callCount = 0;
  installStubFetch(() => { callCount++; return { status: 200, json: {} }; });
  try {
    const provider = new AnthropicCompatibleProvider({
      provider: "anthropic", apiKey: undefined, baseUrl: "https://api.anthropic.com",
    });
    let threw = false;
    try {
      await provider.runJsonTask({ taskName: "whatsapp_reply", modelTier: "balanced", modelName: "claude-haiku-4-5", prompt: "x", input: {} });
    } catch (error) {
      threw = true;
      assert(/Missing API key/i.test(error instanceof Error ? error.message : ""),
        `Error should mention missing key; got: ${error instanceof Error ? error.message : error}`);
    }
    assert(threw, "Missing key MUST throw before any HTTP call.");
    assert(callCount === 0, `No HTTP call should happen when the key is missing; got ${callCount}.`);
    console.log("    OK missing key throws before any HTTP call");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

async function main() {
  console.log("golden-llm-adapters — Stage A.3 contract tests\n");
  await testAnthropicAdapter();
  await testGeminiAdapter();
  await testMiniMaxAdapter();
  await testJsonExtractionFallback();
  await testEmptyResponseThrows();
  await testMissingKeyThrows();
  await testServerErrorIncludesBody();
  await testHtmlResponseThrowsClearly();
  console.log("\nPASS golden-llm-adapters: all 8 contract assertions match.");
  console.log("  Anthropic: x-api-key + anthropic-version + system-prompt + content array parsing");
  console.log("  Gemini: model-in-URL + key-as-query-param + systemInstruction + parts parsing");
  console.log("  MiniMax: OpenAI-compatible shape (Bearer auth) — no longer a throw stub");
  console.log("  Shared: prose-wrapped JSON extraction, empty-response throw, missing-key throw");
  console.log("  2026-07-26: 5xx error includes body (P2-LLM-1); HTML response clear error (P2-LLM-2)");
}

/**
 * 2026-07-26 Session 4 audit (P2-LLM-1) — when a provider returns 5xx with a
 * body containing the operator-actionable error message (e.g. "rate limited,
 * retry in 30s"), the adapter MUST include that body in its thrown error.
 * Pre-fix: the adapter threw only `Anthropic request failed with 503` — the
 * operator saw an opaque status code with no recovery hint.
 */
async function testServerErrorIncludesBody() {
  console.log("  [7] Server 5xx error includes body in thrown message...");
  const { AnthropicCompatibleProvider } = await import("../../src/llm/providers/AnthropicCompatibleProvider");
  const calls = installStubFetch(() => ({
    status: 503,
    json: { error: { type: "overloaded_error", message: "Anthropic overloaded — retry in 30s" } },
  }));
  try {
    const provider = new AnthropicCompatibleProvider({
      provider: "anthropic", apiKey: "sk-ant-test-key", baseUrl: "https://api.anthropic.com",
    });
    let threw: Error | null = null;
    try {
      await provider.runJsonTask({
        taskName: "whatsapp_reply", modelTier: "balanced",
        modelName: "claude-haiku-4-5", prompt: "x", input: {},
      });
    } catch (e) {
      threw = e instanceof Error ? e : new Error(String(e));
    }
    assert(threw !== null, "5xx must throw, not silently return undefined.");
    const msg = threw!.message;
    assert(/503/.test(msg), `Error must include the status code; got: ${msg}`);
    // The audit fix: error must include some of the body so the operator has an
    // actionable hint. "retry in 30s" or "overloaded" should appear.
    assert(/overloaded|retry/i.test(msg),
      `Error must include the provider's body message (operator-actionable); got: ${msg}`);
    console.log("    OK 5xx error includes status + body excerpt");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

/**
 * 2026-07-26 Session 4 audit (P2-LLM-2) — when a corporate proxy returns 200
 * OK with an HTML error page (Cloudflare interstitial, "Bad Gateway" HTML),
 * the adapter MUST throw a clear "non-JSON response" error, not an opaque
 * SyntaxError from response.json() ("Unexpected token <").
 */
async function testHtmlResponseThrowsClearly() {
  console.log("  [8] HTML response (proxy error) throws a clear 'non-JSON' error...");
  const { GeminiCompatibleProvider } = await import("../../src/llm/providers/GeminiCompatibleProvider");
  const calls = installStubFetch(() => ({
    status: 200,
    text: "<html><head><title>Bad Gateway</title></head><body>502 Bad Gateway</body></html>",
    contentType: "text/html",
  }));
  try {
    const provider = new GeminiCompatibleProvider({
      provider: "gemini", apiKey: "gem-test-key", baseUrl: "https://generativelanguage.googleapis.com",
    });
    let threw: Error | null = null;
    try {
      await provider.runJsonTask({
        taskName: "knowledge_answer", modelTier: "fast",
        modelName: "gemini-1.5-flash", prompt: "x", input: {},
      });
    } catch (e) {
      threw = e instanceof Error ? e : new Error(String(e));
    }
    assert(threw !== null, "HTML response must throw, not silently return undefined.");
    const msg = threw!.message;
    // The audit fix: error must clearly say it's a non-JSON / HTML response.
    assert(/non-JSON|HTML|not JSON/i.test(msg),
      `Error must clearly say 'non-JSON response' (not opaque SyntaxError); got: ${msg}`);
    // And must NOT be the raw "Unexpected token" parse error.
    assert(!/Unexpected token/.test(msg),
      `Error must NOT be the raw 'Unexpected token' parse error; got: ${msg}`);
    console.log("    OK HTML response throws clear 'non-JSON' error (no opaque SyntaxError)");
  } finally {
    restoreFetch(ORIGINAL_FETCH);
  }
}

main().catch((error) => {
  console.error("\ngolden-llm-adapters FAILED:", error instanceof Error ? error.message : error);
  console.error(error instanceof Error ? error.stack : "");
  process.exit(1);
});
