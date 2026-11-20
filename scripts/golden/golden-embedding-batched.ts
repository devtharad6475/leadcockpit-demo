/**
 * golden-embedding-batched.ts — batched, model-labelled embeddings
 * (2026-09-17, session 56).
 *
 *   CASE A — OpenAI: 130 texts go out as 3 requests (64 + 64 + 2), each asks
 *            for 1536 dimensions, vectors come back in INPUT order even when
 *            the provider returns them shuffled, every request is metered, and
 *            the result is labelled "openai:<model>".
 *   CASE B — Gemini: batchEmbedContents, the key in a header and never in the
 *            URL, document vs query task types, 1536 dimensions, "gemini:" label.
 *   CASE C — a spend refusal is final: with BOTH keys set, neither provider is
 *            contacted.
 *   CASE D — provider fallback: OpenAI failing falls through to Gemini; with
 *            EMBEDDING_PROVIDER pinned to openai it does not.
 *   CASE E — a response with fewer vectors than texts is an error, not a
 *            silently shifted list.
 *   CASE F — activeEmbeddingModel follows the provider order and the pin.
 *   CASE G — embedChunks: no provider → chunks unchanged; unchanged text with
 *            the same model label is reused and not paid for again; a failure
 *            never throws.
 *
 * The network is faked. The SSRF guard still does a real DNS lookup of the
 * provider hosts; without DNS the allow-path cases fail with a message saying so.
 *
 * Run: npx tsx scripts/golden/golden-embedding-batched.ts
 */
import "./_helpers/isolate-standalone";
// 2026-09-27: usage caps are off while the product is being built; this test
// checks the caps themselves, so it switches them on (as launch will).
process.env.AI_USAGE_CAPS = "on";
import assert from "node:assert";
import { activeEmbeddingModel, embedQuery, embedTexts, EmbeddingSpendRefused, EMBEDDING_DIMENSIONS } from "@/llm/embedding";
import { embedChunks } from "@/rag/embed-chunks";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import type { RepositoryBundle } from "@/repositories/interfaces";

const ENV_VARS = [
  "OPENAI_API_KEY",
  "PLATFORM_OPENAI_API_KEY",
  "PLATFORM_GEMINI_API_KEY",
  "GEMINI_API_KEY",
  "USE_OLLAMA_EMBEDDINGS",
  "PLATFORM_OLLAMA_BASE_URL",
  "EMBEDDING_PROVIDER",
] as const;
const FAKE_OPENAI = "golden-openai-key-not-real";
const FAKE_GEMINI = "golden-gemini-key-not-real";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

function repos(opts: { refuse?: boolean } = {}) {
  const writes: unknown[] = [];
  const usage = {
    dailyTokenLimit: 1e12,
    monthlyTokenLimit: 1e12,
    dailyCostLimit: opts.refuse ? 1 : 1e9,
    monthlyCostLimit: 1e9,
    currentDailyTokens: 0,
    currentMonthlyTokens: 0,
    currentDailyCost: opts.refuse ? 999_999 : 0,
    currentMonthlyCost: 0,
    resetAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const lookups: string[] = [];
  const bundle = {
    aiUsageLimit: {
      getByWorkspace: async (ws: string) => {
        lookups.push(ws);
        return usage;
      },
      upsertForWorkspace: async (_ws: string, patch: unknown) => {
        writes.push(patch);
        return patch;
      },
    },
  };
  return { repos: bundle as unknown as RepositoryBundle, writes, lookups };
}

type Call = { url: string; headers: Record<string, string>; body: any };

/** Run `fn` with the given env and a fake fetch; restores both afterwards. */
async function withEnv<T>(
  env: Partial<Record<(typeof ENV_VARS)[number], string>>,
  respond: (call: Call) => Response,
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; calls: Call[] }> {
  const saved = ENV_VARS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_VARS) delete process.env[k];
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers || {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  try {
    return { value: await fn(), calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A distinct vector per text, so order mistakes are visible. */
function vectorFor(text: string): number[] {
  const n = Number(/\d+/.exec(text)?.[0] ?? 0);
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = n;
  v[1] = 1;
  return v;
}

function openAiResponder(call: Call) {
  if (!call.url.includes("openai.com")) return new Response("unexpected", { status: 599 });
  const inputs: string[] = Array.isArray(call.body.input) ? call.body.input : [call.body.input];
  const data = inputs.map((text, index) => ({ index, embedding: vectorFor(text) }));
  data.reverse(); // the provider may return rows in any order; `index` is authoritative
  return Response.json({ data, usage: { total_tokens: inputs.length * 3 } });
}

function geminiResponder(call: Call) {
  if (!call.url.includes("generativelanguage.googleapis.com")) return new Response("unexpected", { status: 599 });
  const embeddings = call.body.requests.map((r: any) => ({ values: vectorFor(r.content.parts[0].text) }));
  return Response.json({ embeddings });
}

async function requireDns(host: string) {
  const safety = await assertSafeFetchUrl(`https://${host}/`);
  assert.ok(safety.safe, `PRECONDITION (ENVIRONMENT, NOT THE PRODUCT): could not resolve ${host}. ${"reason" in safety ? safety.reason : ""}`);
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `chunk number ${i}`);

test("CASE A — OpenAI: batched, dimensioned, ordered, metered, labelled", async () => {
  await requireDns("api.openai.com");
  const { repos: r, writes } = repos();
  const run = await withEnv({ OPENAI_API_KEY: FAKE_OPENAI }, openAiResponder, () => embedTexts("ws_a", texts(130), r));
  assert.ifError(run.error);
  assert.deepStrictEqual(run.calls.map((c) => c.body.input.length), [64, 64, 2], "130 texts must be 3 requests of 64, 64, 2");
  for (const c of run.calls) assert.strictEqual(c.body.dimensions, EMBEDDING_DIMENSIONS, "text-embedding-3 must be asked for 1536 dimensions");
  const out = run.value!;
  assert.strictEqual(out.vectors.length, 130);
  out.vectors.forEach((v, i) => assert.strictEqual(v[0], i, `vector ${i} belongs to text ${v[0]} — order lost`));
  assert.strictEqual(out.model, "openai:text-embedding-3-small");
  assert.strictEqual(writes.length, 3, "each request is metered once");

  const single = await withEnv({ OPENAI_API_KEY: FAKE_OPENAI }, openAiResponder, () => embedTexts("ws_a", ["only one 7"], r));
  assert.strictEqual(typeof single.calls[0].body.input, "string", "a single text is sent as a plain string");
});

test("CASE B — Gemini: header key, task types, dimensions, label", async () => {
  await requireDns("generativelanguage.googleapis.com");
  const { repos: r, writes } = repos();
  const docs = await withEnv({ PLATFORM_GEMINI_API_KEY: FAKE_GEMINI }, geminiResponder, () => embedTexts("ws_b", texts(3), r));
  assert.ifError(docs.error);
  const call = docs.calls[0];
  assert.ok(call.url.endsWith("/models/gemini-embedding-001:batchEmbedContents"), `wrong endpoint: ${call.url}`);
  assert.ok(!call.url.includes(FAKE_GEMINI), "the API key must never be in the URL");
  assert.strictEqual(call.headers["x-goog-api-key"], FAKE_GEMINI);
  assert.strictEqual(call.body.requests.length, 3);
  for (const req of call.body.requests) {
    assert.strictEqual(req.taskType, "RETRIEVAL_DOCUMENT");
    assert.strictEqual(req.outputDimensionality, EMBEDDING_DIMENSIONS);
    assert.strictEqual(req.model, "models/gemini-embedding-001");
  }
  assert.strictEqual(docs.value!.model, "gemini:gemini-embedding-001");
  assert.deepStrictEqual(docs.value!.vectors.map((v) => v[0]), [0, 1, 2]);
  assert.strictEqual(writes.length, 1);

  const query = await withEnv({ PLATFORM_GEMINI_API_KEY: FAKE_GEMINI }, geminiResponder, () => embedQuery("ws_b", "what is the price 5", r));
  assert.ifError(query.error);
  assert.strictEqual(query.calls[0].body.requests[0].taskType, "RETRIEVAL_QUERY", "a search query must be embedded as a query");
  assert.strictEqual(query.value![0], 5);
});

test("CASE C — a spend refusal is final: no provider is contacted", async () => {
  const { repos: r, writes, lookups } = repos({ refuse: true });
  const run = await withEnv(
    { OPENAI_API_KEY: FAKE_OPENAI, PLATFORM_GEMINI_API_KEY: FAKE_GEMINI },
    (c) => (c.url.includes("openai") ? openAiResponder(c) : geminiResponder(c)),
    () => embedTexts("ws_c", texts(2), r),
  );
  assert.ok(run.error instanceof EmbeddingSpendRefused, `expected a spend refusal, got ${String(run.error)}`);
  assert.deepStrictEqual(run.calls.map((c) => c.url), [], "a refused request must not go to ANY provider — retrying on the second one spends the refused money");
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(
    lookups.length,
    1,
    "the budget was checked more than once: the refusal was carried to the second provider and asked again, " +
      "which is how a refused spend becomes a spend as soon as one provider happens to say yes",
  );
});

test("CASE D — OpenAI failure falls through to Gemini unless a provider is pinned", async () => {
  await requireDns("api.openai.com");
  await requireDns("generativelanguage.googleapis.com");
  const failingOpenAi = (c: Call) => (c.url.includes("openai") ? new Response("down", { status: 500 }) : geminiResponder(c));
  const { repos: r } = repos();
  const both = await withEnv({ OPENAI_API_KEY: FAKE_OPENAI, PLATFORM_GEMINI_API_KEY: FAKE_GEMINI }, failingOpenAi, () => embedTexts("ws_d", texts(2), r));
  assert.ifError(both.error);
  assert.strictEqual(both.value!.model, "gemini:gemini-embedding-001", "the vectors must be labelled with the model that actually made them");
  assert.deepStrictEqual(both.calls.map((c) => (c.url.includes("openai") ? "openai" : "gemini")), ["openai", "gemini"]);

  const pinned = await withEnv(
    { OPENAI_API_KEY: FAKE_OPENAI, PLATFORM_GEMINI_API_KEY: FAKE_GEMINI, EMBEDDING_PROVIDER: "openai" },
    failingOpenAi,
    () => embedTexts("ws_d", texts(2), r),
  );
  assert.ok(pinned.error, "a pinned provider that fails must fail");
  assert.deepStrictEqual(pinned.calls.map((c) => (c.url.includes("openai") ? "openai" : "gemini")), ["openai"], "pinned: Gemini must not be tried");
});

test("CASE E — a short response is an error, never a shifted list", async () => {
  await requireDns("api.openai.com");
  const { repos: r, writes } = repos();
  const short = () => Response.json({ data: [{ index: 0, embedding: vectorFor("0") }] });
  const run = await withEnv({ OPENAI_API_KEY: FAKE_OPENAI }, short, () => embedTexts("ws_e", texts(3), r));
  assert.ok(run.error, "3 texts and 1 vector must be refused");
  assert.strictEqual(writes.length, 0, "a rejected response is not recorded as spend");
});

test("CASE F — activeEmbeddingModel follows the order and the pin", async () => {
  const model = async (env: Partial<Record<(typeof ENV_VARS)[number], string>>) =>
    (await withEnv(env, () => new Response(null, { status: 599 }), async () => activeEmbeddingModel())).value;
  assert.strictEqual(await model({}), null);
  assert.strictEqual(await model({ PLATFORM_GEMINI_API_KEY: FAKE_GEMINI }), "gemini:gemini-embedding-001");
  assert.strictEqual(await model({ OPENAI_API_KEY: FAKE_OPENAI, PLATFORM_GEMINI_API_KEY: FAKE_GEMINI }), "openai:text-embedding-3-small");
  assert.strictEqual(await model({ OPENAI_API_KEY: FAKE_OPENAI, PLATFORM_GEMINI_API_KEY: FAKE_GEMINI, EMBEDDING_PROVIDER: "gemini" }), "gemini:gemini-embedding-001");
  assert.match(String(await model({ OPENAI_API_KEY: FAKE_OPENAI, USE_OLLAMA_EMBEDDINGS: "true" })), /^ollama:/);
});

test("CASE G — embedChunks: unchanged without a provider, reuses unchanged text, never throws", async () => {
  await requireDns("api.openai.com");
  const { repos: r } = repos();
  const chunks: Array<{ chunkText: string; embedding?: number[]; metadata?: Record<string, unknown> }> = [
    { chunkText: "kept 1" },
    { chunkText: "edited 2" },
    { chunkText: "new 3" },
  ];

  const none = await withEnv({}, () => new Response(null, { status: 599 }), () => embedChunks("ws_g", chunks, r));
  assert.deepStrictEqual(none.value, chunks, "no provider: chunks are stored as they are");
  assert.strictEqual(none.calls.length, 0);

  const previous = [
    { chunkText: "kept 1", embedding: vectorFor("kept 91"), metadata: { embeddingModel: "openai:text-embedding-3-small" } },
    { chunkText: "edited 2", embedding: vectorFor("x 92"), metadata: { embeddingModel: "gemini:gemini-embedding-001" } },
  ];
  const reuse = await withEnv({ OPENAI_API_KEY: FAKE_OPENAI }, openAiResponder, () => embedChunks("ws_g", chunks, r, previous));
  assert.ifError(reuse.error);
  const sent = reuse.calls.flatMap((c) => (Array.isArray(c.body.input) ? c.body.input : [c.body.input]));
  assert.deepStrictEqual(sent, ["edited 2", "new 3"], "only text without a same-model vector may be paid for");
  const out = reuse.value!;
  assert.strictEqual(out[0].embedding![0], 91, "the unchanged chunk keeps its previous vector");
  assert.strictEqual(out[1].embedding![0], 2, "a vector from ANOTHER model must not be reused");
  assert.strictEqual(out[2].embedding![0], 3);
  for (const c of out) assert.strictEqual(c.metadata?.embeddingModel, "openai:text-embedding-3-small");
  assert.strictEqual((chunks[0] as { embedding?: unknown }).embedding, undefined, "the caller's chunks must not be mutated");

  const down = await withEnv({ OPENAI_API_KEY: FAKE_OPENAI }, () => new Response("down", { status: 500 }), () => embedChunks("ws_g", chunks, r, previous));
  assert.ifError(down.error);
  assert.strictEqual(down.value![0].embedding![0], 91, "reused vectors survive a provider failure");
  assert.strictEqual(down.value![1].embedding, undefined, "a failed chunk is stored without a vector, not with a fake one");
});

(async () => {
  console.log("\n=== GOLDEN: batched, labelled embeddings ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: embedding-batched");
    process.exit(1);
  }
})();
