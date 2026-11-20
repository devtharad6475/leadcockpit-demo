/**
 * golden-transcription-metered.ts — a customer voice note is METERED SPEND, and
 * it is charged to the customer who sent it.
 *
 * ── THE DEFECT (N-AI-7, found 2026-08-26) ───────────────────────────────────
 * `transcribeAudio(buffer)` took the audio and nothing else. Every voice note
 * any customer sent went straight out to OpenAI Whisper on a PLATFORM-level key
 * read from the environment, with:
 *
 *   - no workspace named   (so nothing downstream could know whose call it was)
 *   - no spend cap checked (the caps are per-workspace; none was named)
 *   - no usage recorded    (the spend appeared in no report anywhere)
 *
 * Every other AI call in the product goes through `LLMService.runTask`, which
 * does all three. This one bypassed the chokepoint entirely. It is the same
 * family as the `workspace_demo` attribution bug but worse: that one reached
 * the gate against the WRONG tenant; this one never reached the gate at all.
 * A customer sending ten thousand voice notes was an unbounded, unreported bill
 * on our own card, and nothing in the system would have raised its hand.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL AND NOT A TEXT SEARCH ──────────────────────
 * Grepping transcription.ts for "checkCanRunTask" proves a string is present,
 * which is a statement about the source and not about the money. This drives
 * the real `transcribeAudio` over a recording data layer and a recording
 * `fetch`, and asks the three questions that decide the bill:
 *
 *   1. When the cap says no, does the audio still leave the building?
 *   2. When the call succeeds, WHOSE budget was decremented?
 *   3. When the provider fails, is the customer charged anyway?
 *
 * The gate ordering (CASE 4) is proven by the ORDER the fake data layer and the
 * fake fetch were called in, not by reading the file top to bottom. A gate that
 * runs after the request has been sent is not a gate.
 *
 * ── ONE ENVIRONMENTAL DEPENDENCY, DECLARED ──────────────────────────────────
 * `assertSafeFetchUrl` does a real DNS lookup of api.openai.com before the
 * request. On a machine with no DNS the allow-path cases cannot run. They do
 * not skip silently — they fail with a message that says plainly it is the
 * environment and not the product, because a test that goes green when it could
 * not run is worse than one that goes red.
 *
 * Run: npx tsx scripts/golden/golden-transcription-metered.ts
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
import { transcribeAudio } from "@/llm/transcription";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import { isFeatureEnabled } from "@/services/FeatureFlagService";
import type { RepositoryBundle } from "@/repositories/interfaces";

/** Never a real credential. The fetch is faked; this only gets past the key check. */
const FAKE_KEY = "golden-test-key-not-a-real-credential";
const KEY_VARS = ["TRANSCRIPTION_OPENAI_API_KEY", "OPENAI_API_KEY"] as const;

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  cases.push({ name, fn });
}

type Seen = { call: string; workspaceId: unknown; payload?: unknown };

type CapState = {
  /** Rupee-or-dollar figure already spent today. Set high to trip the brake. */
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

type FetchOutcome = { ok: true; text: string } | { ok: false; status: number };

/**
 * Run transcribeAudio with the network faked. Returns everything observed:
 * what the data layer saw, whether the provider was contacted at all, and what
 * came back out (or the error that came out instead).
 */
async function runTranscription(opts: {
  workspaceId: string;
  bytes: number;
  cap: CapState;
  outcome: FetchOutcome;
}): Promise<{ seen: Seen[]; fetched: boolean; text?: string; error?: string }> {
  const { repos, seen } = recordingRepos(opts.cap);
  const realFetch = globalThis.fetch;
  const saved = KEY_VARS.map((k) => [k, process.env[k]] as const);
  process.env.TRANSCRIPTION_OPENAI_API_KEY = FAKE_KEY;

  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    // Recorded in the SAME list as the repository calls so the ORDER of the
    // gate relative to the network request is observable, not inferred.
    seen.push({ call: "network.fetch", workspaceId: undefined });
    if (opts.outcome.ok) return new Response(opts.outcome.text, { status: 200 });
    return new Response("provider said no", { status: opts.outcome.status });
  }) as typeof globalThis.fetch;

  try {
    const text = await transcribeAudio(opts.workspaceId, Buffer.alloc(opts.bytes, 1), repos);
    return { seen, fetched, text };
  } catch (e) {
    return { seen, fetched, error: (e as Error).message };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Both allow-path cases need this; it fails loudly rather than skipping. */
async function requireAllowPathPreconditions() {
  assert.ok(
    await isFeatureEnabled("ai_usage_enabled"),
    "PRECONDITION: the ai_usage_enabled kill-switch is OFF in this store, so every AI call " +
      "is refused and the allow-path cases below would go red for the wrong reason. Turn it " +
      "back on before reading anything into this failure.",
  );
  const safety = await assertSafeFetchUrl("https://api.openai.com/v1/audio/transcriptions");
  assert.ok(
    safety.safe,
    "PRECONDITION (ENVIRONMENT, NOT THE PRODUCT): the SSRF guard could not resolve " +
      "api.openai.com, so transcribeAudio cannot reach its fetch on this machine. This is a " +
      "DNS/network problem, not a defect in the spend gate.",
  );
}

// ─── CASE 1 — the brake actually stops the car ──────────────────────────────
test("CASE 1 — over the spend cap: refused, and the audio never leaves the building", async () => {
  const r = await runTranscription({
    workspaceId: "ws_customer_a",
    bytes: 600_000,
    cap: { currentDailyCost: 999_999, dailyCostLimit: 1 },
    outcome: { ok: true, text: "should never be reached" },
  });

  assert.ok(r.error, "a workspace over its daily cost cap must be REFUSED, not transcribed");
  assert.match(
    r.error ?? "",
    /limit would be exceeded/i,
    `the refusal must say the spend cap stopped it, so an operator can act on it. Got: ${r.error}`,
  );
  assert.strictEqual(
    r.fetched,
    false,
    "THE POINT OF THE GATE. The provider was contacted anyway. A cap that is checked after the " +
      "request has already been sent has not saved a single rupee — the bill is incurred at the " +
      "moment of the call, not at the moment of the answer.",
  );
  assert.deepStrictEqual(
    r.seen.filter((s) => s.call === "aiUsageLimit.upsertForWorkspace" && s.payload),
    [],
    "nothing was spent, so nothing may be recorded as spent",
  );
});

// ─── CASE 2 — the right customer is charged ─────────────────────────────────
test("CASE 2 — a successful transcription is charged to the caller, and to nobody else", async () => {
  await requireAllowPathPreconditions();
  const r = await runTranscription({
    workspaceId: "ws_customer_a",
    bytes: 600_000,
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: true, text: "I need 50 meters of gold border, urgent delivery." },
  });

  assert.strictEqual(r.error, undefined, `the allow path must succeed. Got: ${r.error}`);
  assert.strictEqual(r.text, "I need 50 meters of gold border, urgent delivery.");
  assert.strictEqual(r.fetched, true, "TARGET CHECK: the provider was never called, so there is no spend to attribute");

  const wrong = r.seen.filter((s) => s.call.startsWith("aiUsageLimit.") && s.workspaceId !== "ws_customer_a");
  assert.deepStrictEqual(
    wrong,
    [],
    "every spend lookup and every spend write must name the CALLER's workspace. These did not:\n  " +
      wrong.map((w) => `${w.call} -> ${String(w.workspaceId)}`).join("\n  "),
  );

  const writes = r.seen.filter((s) => s.call === "aiUsageLimit.upsertForWorkspace");
  assert.ok(
    writes.length > 0,
    "TARGET CHECK: no spend was recorded at all. That is the original defect — the call happened, " +
      "the money left, and nothing wrote it down.",
  );
  const last = writes[writes.length - 1].payload as { currentDailyCost?: number } | undefined;
  assert.ok(
    typeof last?.currentDailyCost === "number" && last.currentDailyCost > 0,
    `the recorded daily spend must go UP after a real transcription. Recorded: ${JSON.stringify(last)}`,
  );
});

// ─── CASE 3 — a failed call is not billed ───────────────────────────────────
test("CASE 3 — the provider fails: the customer is not charged for it", async () => {
  await requireAllowPathPreconditions();
  const r = await runTranscription({
    workspaceId: "ws_customer_a",
    bytes: 600_000,
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: false, status: 500 },
  });

  assert.ok(r.error, "a 500 from the provider must surface as an error, not an empty transcript");
  const writes = r.seen.filter(
    (s) => s.call === "aiUsageLimit.upsertForWorkspace" && (s.payload as { currentDailyCost?: number } | undefined)?.currentDailyCost,
  );
  assert.deepStrictEqual(
    writes.map((w) => w.payload),
    [],
    "spend was recorded for a call the provider did not complete. Record AFTER success, matching " +
      "how the LLM chokepoint does it — the provider did not bill us for it either, and a report " +
      "that overstates spend erodes trust in the report exactly as much as one that understates it.",
  );
});

// ─── CASE 4 — the gate runs BEFORE the money is spent ───────────────────────
test("CASE 4 — the cap is checked before the request, not after", async () => {
  await requireAllowPathPreconditions();
  const r = await runTranscription({
    workspaceId: "ws_customer_a",
    bytes: 600_000,
    cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
    outcome: { ok: true, text: "ordering matters" },
  });

  const order = r.seen.map((s) => s.call);
  const gateAt = order.indexOf("aiUsageLimit.getByWorkspace");
  const fetchAt = order.indexOf("network.fetch");
  assert.notStrictEqual(gateAt, -1, "TARGET CHECK: the spend cap was never read — there is no gate to order");
  assert.notStrictEqual(fetchAt, -1, "TARGET CHECK: the provider was never called — there is nothing to order it against");
  assert.ok(
    gateAt < fetchAt,
    `the cap must be read BEFORE the provider is contacted. Observed order:\n  ${order.join("\n  ")}`,
  );
});

// ─── CASE 5 — the estimate is a real number, not a decorative zero ──────────
test("CASE 5 — the cost estimate is positive and grows with the audio", async () => {
  await requireAllowPathPreconditions();
  const costFor = async (bytes: number) => {
    const r = await runTranscription({
      workspaceId: "ws_customer_a",
      bytes,
      cap: { currentDailyCost: 0, dailyCostLimit: 1e9 },
      outcome: { ok: true, text: "x" },
    });
    const writes = r.seen.filter((s) => s.call === "aiUsageLimit.upsertForWorkspace");
    return (writes[writes.length - 1]?.payload as { currentDailyCost?: number } | undefined)?.currentDailyCost ?? 0;
  };

  const small = await costFor(120_000);
  const large = await costFor(1_200_000);
  assert.ok(small > 0, "a zero estimate makes the brake decorative: nothing can ever exceed a cap by adding zero to it");
  assert.ok(
    large > small,
    `a ten-times-longer voice note must estimate a higher cost. small=${small} large=${large}. ` +
      "A flat per-call figure would let one customer send hour-long audio at the price of a two-second one.",
  );
});

// ─── CASE 6 — the compiler, not memory, enforces the workspace ──────────────
test("CASE 6 — transcription cannot be called without saying who it is for", () => {
  const src = readFileSync(join(process.cwd(), "src", "llm", "transcription.ts"), "utf8");
  const at = src.indexOf("export async function transcribeAudio");
  assert.notStrictEqual(at, -1, "TARGET CHECK: transcribeAudio is gone or renamed — this case is watching nothing");
  const sig = src.slice(at, src.indexOf(")", src.indexOf("(", at)) + 1);
  assert.ok(
    /workspaceId\s*:\s*string/.test(sig) && !/workspaceId\s*\?/.test(sig),
    "workspaceId must be a REQUIRED parameter. Optional puts the burden back on every caller to " +
      "remember, and the caller that forgets produces spend attributed to nobody. Found:\n" + sig,
  );
  assert.ok(
    /repos\s*:\s*RepositoryBundle/.test(sig),
    "the repository bundle must be required too — without it the gate would silently open its own " +
      "connection to the default store, which is how a per-tenant check turns into a global one.",
  );

  const inbound = readFileSync(join(process.cwd(), "src", "services", "InboundMediaService.ts"), "utf8");
  const depAt = inbound.indexOf("transcribe?:");
  assert.notStrictEqual(depAt, -1, "TARGET CHECK: the transcribe dependency hook is gone from InboundMediaService");
  const dep = inbound.slice(depAt, inbound.indexOf(";", depAt));
  assert.ok(
    /workspaceId\s*:\s*string/.test(dep) && /RepositoryBundle/.test(dep),
    "the injectable transcriber must have the SAME shape as the real one. A narrower hook is a hole: " +
      "an unmetered implementation could be substituted in and typecheck. Found:\n" + dep,
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
  console.log(`\ntranscription-metered: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
