/**
 * golden-embedding-metered.ts — knowledge-base embedding is METERED SPEND, and
 * it is charged to the workspace whose knowledge base it is.
 *
 * ── THE DEFECT (N-AI-9, found 2026-08-26) ───────────────────────────────────
 * `embedText(text)` took the text and nothing else. It reached into the
 * PLATFORM's OpenAI key and billed the result to nobody:
 *
 *   - no workspace named   (so nothing downstream could know whose call it was)
 *   - no spend cap checked (the caps are per-workspace; none was named)
 *   - no usage recorded    (the spend appeared in no report anywhere)
 *
 * This is the same family as N-AI-7 (voice transcription) and the second and
 * LAST place in the product that talks to a paid AI provider without going
 * through LLMService. Every other paid call goes through `LLMService.runTask`,
 * which gates and records. These two did not.
 *
 * Volume is what makes it expensive. `chunkKnowledgeDocument` embeds EVERY
 * chunk of a document — one paid call per ~900 characters — and
 * `SemanticRetriever` embeds EVERY search query. One customer re-indexing a
 * large product catalogue is hundreds of calls on our card, attributed to
 * nobody, capped by nothing.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL AND NOT A TEXT SEARCH ──────────────────────
 * Grepping embedding.ts for "checkCanRunTask" proves a string is present, which
 * is a statement about the source and not about the money. This drives the real
 * `embedText` over a recording data layer and a recording `fetch`, and asks the
 * questions that decide the bill:
 *
 *   1. When the cap says no, does the request still go out?
 *   2. When the call succeeds, WHOSE budget was decremented, and by how much?
 *   3. When the provider fails, is the customer charged anyway?
 *   4. Is the FREE local path still free — or did metering break it?
 *
 * CASE 5 is specific to this path and does not exist in the transcription
 * alarm: OpenAI reports the REAL token count in its response, so recording the
 * pre-call ESTIMATE instead would be a bill we made up. Whisper reports nothing
 * comparable; here there is a true number available and it must be the one used.
 *
 * ── ONE ENVIRONMENTAL DEPENDENCY, DECLARED ──────────────────────────────────
 * `assertSafeFetchUrl` does a real DNS lookup of api.openai.com before the
 * request. On a machine with no DNS the allow-path cases cannot run. They do
 * not skip silently — they fail with a message that says plainly it is the
 * environment and not the product, because a test that goes green when it could
 * not run is worse than one that goes red.
 *
 * Run: npx tsx scripts/golden/golden-embedding-metered.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
// 2026-09-27: usage caps are off while the product is being built; this test
// checks the caps themselves, so it switches them on (as launch will).
process.env.AI_USAGE_CAPS = "on";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embedText, embeddingCostUsd } from "@/llm/embedding";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import { isFeatureEnabled } from "@/services/FeatureFlagService";
import type { RepositoryBundle } from "@/repositories/interfaces";

/** Never a real credential. The fetch is faked; this only gets past the key check. */
const FAKE_KEY = "golden-test-key-not-a-real-credential";
const KEY_VARS = ["OPENAI_API_KEY", "PLATFORM_OPENAI_API_KEY", "USE_OLLAMA_EMBEDDINGS", "PLATFORM_OLLAMA_BASE_URL"] as const;

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  cases.push({ name, fn });
}

type Seen = { call: string; workspaceId: unknown; payload?: unknown };

type CapState = {
  currentDailyCost: number;
  dailyCostLimit: number;
};

/**
 * A data layer that answers plausibly and writes down every call it saw, in
 * order. A Proxy rather than a hand-written double so that a lookup added to
 * the spend path LATER is recorded too — a hand-written double only records
 * what its author remembered to write down.
 */
function recordingRepos(cap: CapState): { repos: RepositoryBundle; seen: Seen[] } {
  const seen: Seen[] = [];

  const usageRecord = {
    dailyTokenLimit: 1e9,
    monthlyTokenLimit: 1e9,
    dailyCostLimit: cap.dailyCostLimit,
    monthlyCostLimit: 1e9,
    currentDailyTokens: 0,
    currentMonthlyTokens: 0,
    currentDailyCost: cap.currentDailyCost,
    currentMonthlyCost: 0,
    // In the future, so resetUsageIfNeeded hands the record back untouched
    // instead of taking the daily-rollover branch, which is not under test.
    resetAt: new Date(Date.now() + 86_400_000).toISOString(),
  };

  const answers: Record<string, (args: unknown[]) => unknown> = {
    "aiUsageLimit.getByWorkspace": () => usageRecord,
    "aiUsageLimit.upsertForWorkspace": (a) => a[1] ?? usageRecord,
  };

  const bundle = new Proxy(
    {},
    {
      get(_t, repoName) {
        if (typeof repoName !== "string") return undefined;
        return new Proxy(
          {},
          {
            get(_t2, method) {
              if (typeof method !== "string" || method === "then") return undefined;
              const call = `${repoName}.${method}`;
              return async (...args: unknown[]) => {
                const first = args[0];
                seen.push({
                  call,
                  workspaceId: typeof first === "string" ? first : undefined,
                  payload: args[1],
                });
                return answers[call]?.(args);
              };
            },
          },
        );
      },
    },
  );

  return { repos: bundle as RepositoryBundle, seen };
}

type FetchOutcome =
  | { ok: true; vector: number[]; reportedTokens?: number }
  | { ok: false; status: number };

type RunResult = {
  seen: Seen[];
  urls: string[];
  vector?: number[];
  error?: string;
};

/**
 * Run embedText with the network faked. Returns everything observed: what the
 * data layer saw, WHICH urls were contacted (so the free local path and the
 * paid cloud path can be told apart), and what came back out.
 */
async function runEmbed(opts: {
  workspaceId: string;
  text: string;
  cap: CapState;
  outcome: FetchOutcome;
  /**
   * Whether the operator has opted into the FREE local path, and whether the
   * daemon is actually up. Three real configurations:
   *   undefined       — no Ollama at all; only the paid provider exists.
   *   { vector }      — Ollama configured AND running: the call is free.
   *   { down: true }  — Ollama configured but the daemon is not answering, so
   *                     the code probes it, gets nothing, and falls through to
   *                     the paid provider. This is the configuration where the
   *                     gate ordering is subtle, because a free probe legitimately
   *                     happens BEFORE the gate.
   */
  ollama?: { vector: number[] } | { down: true };
}): Promise<RunResult> {
  const { repos, seen } = recordingRepos(opts.cap);
  const realFetch = globalThis.fetch;
  const saved = KEY_VARS.map((k) => [k, process.env[k]] as const);
  process.env.OPENAI_API_KEY = FAKE_KEY;
  if (opts.ollama) {
    process.env.USE_OLLAMA_EMBEDDINGS = "true";
  } else {
    // Cleared rather than merely left alone: whether this machine happens to
    // have Ollama configured must not change what these cases measure.
    delete process.env.USE_OLLAMA_EMBEDDINGS;
    delete process.env.PLATFORM_OLLAMA_BASE_URL;
  }

  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    // Recorded in the SAME list as the repository calls so the ORDER of the
    // gate relative to the network request is observable, not inferred.
    seen.push({ call: "network.fetch", workspaceId: undefined, payload: url });

    if (url.includes("/api/embeddings") && !url.includes("openai.com")) {
      // The local Ollama daemon. Free.
      if (!opts.ollama || "down" in opts.ollama) return new Response("not running", { status: 502 });
      return Response.json({ embedding: opts.ollama.vector });
    }

    if (!opts.outcome.ok) return new Response("provider said no", { status: opts.outcome.status });
    return Response.json({
      data: [{ embedding: opts.outcome.vector }],
      usage: opts.outcome.reportedTokens === undefined ? undefined : { total_tokens: opts.outcome.reportedTokens },
    });
  }) as typeof globalThis.fetch;

  try {
    const vector = await embedText(opts.workspaceId, opts.text, repos);
    return { seen, urls, vector };
  } catch (e) {
    return { seen, urls, error: (e as Error).message };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** What the last spend write recorded, or undefined if nothing was written. */
function lastWrite(seen: Seen[]) {
  const writes = seen.filter((s) => s.call === "aiUsageLimit.upsertForWorkspace");
  return writes[writes.length - 1]?.payload as
    | { currentDailyTokens?: number; currentDailyCost?: number }
    | undefined;
}

/** The allow-path cases need this; it fails loudly rather than skipping. */
async function requireAllowPathPreconditions() {
  assert.ok(
    await isFeatureEnabled("ai_usage_enabled"),
    "PRECONDITION: the ai_usage_enabled kill-switch is OFF in this store, so every AI call " +
      "is refused and the allow-path cases below would go red for the wrong reason. Turn it " +
      "back on before reading anything into this failure.",
  );
  const safety = await assertSafeFetchUrl("https://api.openai.com/v1/embeddings");
  assert.ok(
    safety.safe,
    "PRECONDITION (ENVIRONMENT, NOT THE PRODUCT): the SSRF guard could not resolve " +
      "api.openai.com, so embedText cannot reach its fetch on this machine. This is a " +
      "DNS/network problem, not a defect in the spend gate.",
  );
}

// ─── CASE 1 — the brake actually stops the car ──────────────────────────────
test("CASE 1 — over the spend cap: refused, and the text never leaves the building", async () => {
  const r = await runEmbed({
    workspaceId: "ws_customer_a",
    text: "our gold border trimming ships in seven days",
    cap: { currentDailyCost: 999_999, dailyCostLimit: 1 },
    outcome: { ok: true, vector: [1, 0, 0], reportedTokens: 9 },
  });

  assert.ok(r.error, "a workspace over its daily cost cap must be REFUSED, not embedded");
  assert.match(
    r.error ?? "",
    /limit would be exceeded/i,
    `the refusal must say the spend cap stopped it, so an operator can act on it. Got: ${r.error}`,
  );
  assert.deepStrictEqual(
    r.urls.filter((u) => u.includes("openai.com")),
    [],
    "THE POINT OF THE GATE. The provider was contacted anyway. A cap that is checked after the " +
      "request has already been sent has not saved a single cent — the bill is incurred at the " +
      "moment of the call, not at the moment of the answer.",
  );
  assert.strictEqual(
    lastWrite(r.seen),
    undefined,
    "nothing was spent, so nothing may be recorded as spent",
  );
});

// ─── CASE 2 — the right customer is charged ─────────────────────────────────
test("CASE 2 — a successful embedding is charged to the caller, and to nobody else", async () => {
  await requireAllowPathPreconditions();
  const r = await runEmbed({
    workspaceId: "ws_customer_a",
    text: "our gold border trimming ships in seven days",
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: true, vector: [0.1, 0.2, 0.3], reportedTokens: 11 },
  });

  assert.strictEqual(r.error, undefined, `the allow path must succeed. Got: ${r.error}`);
  assert.deepStrictEqual(r.vector, [0.1, 0.2, 0.3]);
  assert.ok(
    r.urls.some((u) => u.includes("openai.com")),
    "TARGET CHECK: the provider was never called, so there is no spend to attribute",
  );

  const wrong = r.seen.filter((s) => s.call.startsWith("aiUsageLimit.") && s.workspaceId !== "ws_customer_a");
  assert.deepStrictEqual(
    wrong,
    [],
    "every spend lookup and every spend write must name the CALLER's workspace. These did not:\n  " +
      wrong.map((w) => `${w.call} -> ${String(w.workspaceId)}`).join("\n  "),
  );

  const write = lastWrite(r.seen);
  assert.ok(
    write,
    "TARGET CHECK: no spend was recorded at all. That is the original defect — the call happened, " +
      "the money left, and nothing wrote it down.",
  );
  assert.ok(
    typeof write?.currentDailyCost === "number" && write.currentDailyCost > 0,
    `the recorded daily spend must go UP after a real embedding. Recorded: ${JSON.stringify(write)}`,
  );
  assert.ok(
    typeof write?.currentDailyTokens === "number" && write.currentDailyTokens > 0,
    "embeddings consume TOKENS, so the token counter must move too. Recording cost alone would let " +
      "a customer sail past a token cap that exists precisely to stop this. Recorded: " +
      JSON.stringify(write),
  );
});

// ─── CASE 3 — a failed call is not billed ───────────────────────────────────
test("CASE 3 — the provider fails: the customer is not charged for it", async () => {
  await requireAllowPathPreconditions();
  const r = await runEmbed({
    workspaceId: "ws_customer_a",
    text: "our gold border trimming ships in seven days",
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: false, status: 500 },
  });

  assert.ok(r.error, "a 500 from the provider must surface as an error, not an empty vector");
  assert.strictEqual(
    lastWrite(r.seen),
    undefined,
    "spend was recorded for a call the provider did not complete. Record AFTER success, matching " +
      "how the LLM chokepoint does it — the provider did not bill us for it either, and a report " +
      "that overstates spend erodes trust in the report exactly as much as one that understates it.",
  );
});

// ─── CASE 4 — the gate runs BEFORE the money is spent ───────────────────────
test("CASE 4 — the cap is checked before the PAID request, not after", async () => {
  await requireAllowPathPreconditions();
  // Ollama configured but not answering: the hardest ordering to get right,
  // because a legitimate FREE probe goes out before the gate. What must not
  // happen is the PAID request going out before the gate.
  const r = await runEmbed({
    workspaceId: "ws_customer_a",
    text: "ordering matters",
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: true, vector: [1], reportedTokens: 3 },
    ollama: { down: true },
  });

  const order = r.seen.map((s) => (s.call === "network.fetch" ? `network.fetch ${String(s.payload)}` : s.call));
  const gateAt = r.seen.findIndex((s) => s.call === "aiUsageLimit.getByWorkspace");
  const paidAt = r.seen.findIndex((s) => s.call === "network.fetch" && String(s.payload).includes("openai.com"));
  assert.notStrictEqual(gateAt, -1, "TARGET CHECK: the spend cap was never read — there is no gate to order");
  assert.notStrictEqual(paidAt, -1, "TARGET CHECK: the PAID provider was never called — there is nothing to order it against");
  assert.ok(
    gateAt < paidAt,
    `the cap must be read BEFORE the paid provider is contacted. Observed order:\n  ${order.join("\n  ")}`,
  );
  // And the free probe is genuinely free: it must not be what the gate guards.
  assert.ok(
    r.urls.filter((u) => !u.includes("openai.com")).length > 0,
    "TARGET CHECK: the free Ollama probe never happened, so this case is not exercising the mixed " +
      "configuration it claims to — it has quietly become a duplicate of the simple ordering check.",
  );
});

// ─── CASE 5 — the bill is the provider's number, not ours ───────────────────
test("CASE 5 — what gets recorded is the REAL token count, not the pre-call estimate", async () => {
  await requireAllowPathPreconditions();

  // 4,000 characters estimates to ~1,000 tokens. The provider reports 7. If the
  // estimate were recorded, this workspace would be billed for 1,000.
  const text = "x".repeat(4000);
  const r = await runEmbed({
    workspaceId: "ws_customer_a",
    text,
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: true, vector: [1], reportedTokens: 7 },
  });

  const write = lastWrite(r.seen);
  assert.ok(write, "TARGET CHECK: nothing was recorded, so there is no number to check");
  assert.strictEqual(
    write?.currentDailyTokens,
    7,
    "the provider TOLD us how many tokens it charged for. Recording our own guess instead is a bill " +
      "we invented: here the guess is ~1,000 against a true 7, so the customer's report would be " +
      `wrong by more than a hundred times. Recorded: ${JSON.stringify(write)}`,
  );

  // And when the provider says nothing, the estimate is the honest fallback —
  // silently recording zero would make an un-instrumented provider free.
  const quiet = await runEmbed({
    workspaceId: "ws_customer_a",
    text,
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: true, vector: [1] },
  });
  const quietWrite = lastWrite(quiet.seen);
  assert.ok(
    typeof quietWrite?.currentDailyTokens === "number" && quietWrite.currentDailyTokens > 100,
    "a provider that reports no usage must fall back to the ESTIMATE, not to zero. Zero would make " +
      `every call on such a provider free and uncapped. Recorded: ${JSON.stringify(quietWrite)}`,
  );
});

// ─── CASE 6 — the free path stayed free ─────────────────────────────────────
test("CASE 6 — local Ollama costs nothing, so it is neither gated nor billed", async () => {
  const r = await runEmbed({
    workspaceId: "ws_customer_a",
    text: "our gold border trimming ships in seven days",
    // Deliberately far over the cap. A free call must not care.
    cap: { currentDailyCost: 999_999, dailyCostLimit: 1 },
    outcome: { ok: true, vector: [9, 9, 9], reportedTokens: 11 },
    ollama: { vector: [0.5, 0.5] },
  });

  assert.strictEqual(r.error, undefined, `the free local path must work even for a workspace over its cap. Got: ${r.error}`);
  assert.deepStrictEqual(
    r.vector,
    [0.5, 0.5],
    "TARGET CHECK: the vector did not come from Ollama, so this case is not exercising the free path",
  );
  assert.deepStrictEqual(
    r.urls.filter((u) => u.includes("openai.com")),
    [],
    "TARGET CHECK: it fell through to the PAID provider, so this case is not exercising the free path",
  );
  assert.deepStrictEqual(
    r.seen.filter((s) => s.call.startsWith("aiUsageLimit.")),
    [],
    "a call that costs nothing must not be metered. Refusing a free local embedding because of a " +
      "DOLLAR budget would be a brake on the wrong wheel, and recording spend for it would put " +
      "money in the report that nobody ever paid.",
  );
});

// ─── CASE 7 — an unknown model is not a free model ──────────────────────────
test("CASE 7 — pricing: cost grows with tokens, and an unknown model is priced at the dearest rate", () => {
  const small = embeddingCostUsd(1_000, "text-embedding-3-small");
  const large = embeddingCostUsd(1_000, "text-embedding-3-large");
  const unknown = embeddingCostUsd(1_000, "some-model-nobody-priced-yet");

  assert.ok(small > 0, "a zero price makes the brake decorative: nothing can ever exceed a cap by adding zero to it");
  assert.ok(
    embeddingCostUsd(10_000, "text-embedding-3-small") > small,
    "ten times the tokens must cost more than one times the tokens",
  );
  assert.ok(
    large > small,
    `the price table must actually distinguish models. small=${small} large=${large}`,
  );
  assert.ok(
    unknown >= large,
    `an UNKNOWN model must be priced at the dearest known rate, not the cheapest and certainly not ` +
      `zero. unknown=${unknown} dearest=${large}. A cheap guess turns a mis-set EMBEDDING_MODEL into ` +
      "a way to slip under every cap — which is N-AI-9 coming back through a different door.",
  );
});

// ─── CASE 8 — the compiler, not memory, enforces the workspace ──────────────
test("CASE 8 — embedding cannot be called without saying who it is for", () => {
  const src = readFileSync(join(process.cwd(), "src", "llm", "embedding.ts"), "utf8");

  const typeAt = src.indexOf("export type EmbedFn");
  assert.notStrictEqual(typeAt, -1, "TARGET CHECK: EmbedFn is gone or renamed — this case is watching nothing");
  const typeDecl = src.slice(typeAt, src.indexOf(";", typeAt));
  assert.ok(
    /workspaceId\s*:\s*string/.test(typeDecl) && !/workspaceId\s*\?/.test(typeDecl),
    "workspaceId must be a REQUIRED parameter of EmbedFn. Optional puts the burden back on every " +
      "caller to remember, and the caller that forgets produces spend attributed to nobody. Found:\n" + typeDecl,
  );
  assert.ok(
    /RepositoryBundle/.test(typeDecl),
    "the repository bundle must be required too — without it the gate would silently open its own " +
      "connection to the default store, which is how a per-tenant check turns into a global one. Found:\n" + typeDecl,
  );

  // The injectable hooks must have the SAME shape as the real function. A
  // narrower hook is a hole: an unmetered implementation could be substituted
  // in and still typecheck.
  const kb = readFileSync(join(process.cwd(), "src", "services", "KnowledgeBaseService.ts"), "utf8");
  assert.match(
    kb,
    /embedFn\?:\s*EmbedFn/,
    "KnowledgeBaseService's injectable embedder must be typed as EmbedFn itself, not re-spelled as a " +
      "narrower inline signature that would let an unmetered stub through.",
  );
  // 2026-09-17 (session 57): chunkKnowledgeDocument now has TWO embedding call
  // sites — the injected one (tests) and the batched real one via
  // src/rag/embed-chunks.ts. BOTH must name the workspace, so both are checked
  // here, and so is the batching helper they lead to. Same property as before
  // (no embedding call without an owner), widened to the paths that now exist.
  assert.match(
    kb,
    /options\.embedFn\(\s*workspaceId\s*,/,
    "TARGET CHECK: chunkKnowledgeDocument no longer passes its workspaceId to the INJECTED embedder — the " +
      "highest-volume paid path in the product is unattributed again.",
  );
  assert.match(
    kb,
    /embedChunks\(\s*workspaceId\s*,/,
    "TARGET CHECK: chunkKnowledgeDocument no longer passes its workspaceId to the BATCHED embedder, which is " +
      "the path production actually takes.",
  );
  const embedChunksSrc = readFileSync(join(process.cwd(), "src", "rag", "embed-chunks.ts"), "utf8");
  assert.match(
    embedChunksSrc,
    /embedTexts\(\s*workspaceId\s*,/,
    "TARGET CHECK: the batching helper drops the workspace on its way to the provider, so every chunk of every " +
      "uploaded document is billed to nobody.",
  );

  const retriever = readFileSync(join(process.cwd(), "src", "rag", "SemanticRetriever.ts"), "utf8");
  assert.match(
    retriever,
    /this\.embedFn\(\s*workspaceId\s*,/,
    "TARGET CHECK: SemanticRetriever no longer passes the searching workspace to the embedder, so " +
      "every knowledge-base search is billed to nobody again.",
  );
});

// ─── RUN ────────────────────────────────────────────────────────────────────
async function main() {
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\nembedding-metered: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
