/**
 * golden-llm-workspace-attribution.ts — AI work is charged to the customer who
 * asked for it, and to nobody else.
 *
 * ── THE DEFECT (found 2026-08-26) ───────────────────────────────────────────
 * `LLMService.runTask` opened with:
 *
 *     const workspaceId = options.workspaceId || "workspace_demo";
 *
 * Four things downstream are keyed off that single value:
 *
 *   1. WHICH MODEL runs        — llmModelRouting.listByWorkspace
 *   2. WHOSE API KEY PAYS      — llmProviderCredential.listByWorkspace
 *   3. WHOSE SPEND CAP applies — checkCanRunTask / recordUsage
 *   4. WHOSE AUDIT TRAIL       — agentRun.create / update
 *
 * So a caller that forgot to name a workspace ran a REAL customer's AI work on
 * the DEMO tenant's provider key, against the demo tenant's budget, with the
 * record of it filed in the demo tenant's workspace. It never errored, because
 * a default that is always valid never complains. Two real product paths were
 * doing exactly that: the WhatsApp inbound-photo vision call, and the
 * market-research planner.
 *
 * The fix was not to change the default. It was to DELETE the default and make
 * `workspaceId` required, so the compiler names every caller that was relying
 * on it. That is how the count of two was measured rather than guessed.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL AND NOT A TEXT SEARCH ──────────────────────
 * Grepping for `workspace_demo` would prove the string is absent, which is a
 * statement about the source, not about the money. This drives the real
 * `runTask` with a recording data layer underneath it and asks the only
 * question that matters: WHICH WORKSPACE did every billing-relevant lookup
 * actually see? A future re-introduction of the fallback under any other
 * spelling still turns this red.
 *
 * Two dependencies are NOT faked and read the ordinary store read-only: the
 * `ai_usage_enabled` feature flag and the agent instruction bundle. Neither
 * writes, and neither is what is being asserted. `runTask` is allowed to
 * THROW (the usage gate may refuse) — the assertions are about the calls the
 * data layer saw, which is what gets billed, not about the call succeeding.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *   1. Every billing-relevant lookup sees the CALLER's workspace
 *   2. "workspace_demo" is never reached by any of them
 *   3. A second customer in the same process gets their own attribution
 *   4. The four critical lookups actually happened (no vacuous pass)
 *   5. `workspaceId` is required at the type level, so the compiler enforces it
 *
 * Run: npx tsx scripts/golden/golden-llm-workspace-attribution.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LLMService } from "@/llm/LLMService";
import type { RepositoryBundle } from "@/repositories/interfaces";

const DEMO = "workspace_demo";

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  cases.push({ name, fn });
}

type Seen = { call: string; workspaceId: unknown };

/**
 * A data layer that answers plausibly and writes down every workspace it was
 * asked about. A Proxy rather than a hand-written double because the point is
 * to catch EVERY call, including ones added later that this file has never
 * heard of — a hand-written double only records what its author remembered.
 */
function recordingRepos(): { repos: RepositoryBundle; seen: Seen[] } {
  const seen: Seen[] = [];

  // Limits high and the reset in the future, so resetUsageIfNeeded returns this
  // record unchanged instead of taking a branch that is not under test.
  const usageRecord = {
    dailyTokenLimit: 1e9,
    monthlyTokenLimit: 1e9,
    dailyCostLimit: 1e9,
    monthlyCostLimit: 1e9,
    currentDailyTokens: 0,
    currentMonthlyTokens: 0,
    currentDailyCost: 0,
    currentMonthlyCost: 0,
    resetAt: new Date(Date.now() + 86_400_000).toISOString(),
  };

  const answers: Record<string, (args: unknown[]) => unknown> = {
    "llmModelRouting.listByWorkspace": () => [],
    "llmProviderCredential.listByWorkspace": () => [],
    "aiUsageLimit.getByWorkspace": () => usageRecord,
    "aiUsageLimit.upsertForWorkspace": (a) => a[1] ?? usageRecord,
    "agentRun.create": () => ({ id: "run_under_test" }),
    "agentRun.update": () => ({}),
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
                // The workspace arrives either as the first argument or as a
                // field on a create/update payload. Record whichever it is —
                // "no workspace anywhere" is itself a finding, not a skip.
                const first = args[0];
                const ws =
                  typeof first === "string"
                    ? first
                    : first && typeof first === "object" && "workspaceId" in first
                      ? (first as { workspaceId: unknown }).workspaceId
                      : undefined;
                seen.push({ call, workspaceId: ws });
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

/** Drive the real runTask for one customer and hand back what the data layer saw. */
async function runFor(workspaceId: string): Promise<Seen[]> {
  const { repos, seen } = recordingRepos();
  const service = new LLMService(undefined, repos);
  try {
    await service.runTask("icp_generation", { note: "golden — not a real customer request" }, { workspaceId });
  } catch {
    /* The usage gate or a provider may refuse. What was BILLED is already recorded. */
  }
  return seen;
}

// ─── CASE 1 — the caller's workspace, everywhere ────────────────────────────
test("CASE 1 — every billing-relevant lookup sees the workspace the caller named", async () => {
  const seen = await runFor("ws_customer_a");
  assert.ok(seen.length > 0, "TARGET CHECK: the data layer was never called at all — this test is watching nothing");

  const wrong = seen.filter((s) => s.workspaceId !== "ws_customer_a");
  assert.deepStrictEqual(
    wrong,
    [],
    "every lookup that decides which model runs, whose key pays, whose cap applies and whose " +
      "audit trail records it must name the CALLER's workspace. These did not:\n  " +
      wrong.map((w) => `${w.call} -> ${String(w.workspaceId)}`).join("\n  "),
  );
});

// ─── CASE 2 — the demo tenant is never touched ──────────────────────────────
test("CASE 2 — a real customer's AI work never reaches the demo tenant", async () => {
  const seen = await runFor("ws_customer_a");
  const demo = seen.filter((s) => s.workspaceId === DEMO);
  assert.deepStrictEqual(
    demo,
    [],
    `THE DEFECT ITSELF. A lookup reached ${DEMO} while serving ws_customer_a. That means the demo ` +
      "tenant's provider key paid for it, its spend cap was checked instead of the customer's, and " +
      "the record of the run was filed in the wrong workspace. Reached by:\n  " +
      demo.map((d) => d.call).join("\n  "),
  );
});

// ─── CASE 3 — two customers in one process do not bleed ─────────────────────
test("CASE 3 — a second customer is attributed to themselves, not to the first", async () => {
  const a = await runFor("ws_customer_a");
  const b = await runFor("ws_customer_b");
  assert.ok(b.length > 0, "TARGET CHECK: the second run touched nothing");
  assert.deepStrictEqual(
    b.filter((s) => s.workspaceId !== "ws_customer_b"),
    [],
    "the second customer's run must be attributed entirely to the second customer — a value cached " +
      "or captured from the first run would show up here",
  );
  assert.strictEqual(
    a.length,
    b.length,
    "both customers must take the same path through the data layer; a difference means one of them " +
      "is being handled specially",
  );
});

// ─── CASE 4 — the four that decide the money actually ran ───────────────────
test("CASE 4 — the four billing-relevant lookups genuinely happened", async () => {
  const seen = await runFor("ws_customer_a");
  const calls = new Set(seen.map((s) => s.call));
  const required = [
    ["llmModelRouting.listByWorkspace", "which model runs"],
    ["llmProviderCredential.listByWorkspace", "whose API key pays for the call"],
    ["aiUsageLimit.getByWorkspace", "whose spend cap is checked"],
    ["agentRun.create", "whose audit trail records the run"],
  ] as const;
  for (const [call, why] of required) {
    assert.ok(
      calls.has(call),
      `${call} never ran, so CASES 1-3 proved nothing about ${why}. Either runTask changed shape ` +
        `(then update this list deliberately) or it failed before reaching this point. Calls seen:\n  ` +
        [...calls].join("\n  "),
    );
  }
});

// ─── CASE 5 — the compiler, not memory, enforces it ─────────────────────────
test("CASE 5 — workspaceId is a required field, so a caller cannot forget it", () => {
  const types = readFileSync(join(process.cwd(), "src", "llm", "types.ts"), "utf8");
  // Declared as `export type ... = {`, not an interface. Matching on the name
  // alone rather than the keyword, so switching between the two forms does not
  // silently turn this case into a no-op.
  const at = types.search(/\b(type|interface)\s+LLMTaskOptions\b/);
  assert.notStrictEqual(at, -1, "TARGET CHECK: LLMTaskOptions is gone or renamed — this case is watching nothing");
  const body = types.slice(at, types.indexOf("}", at));
  assert.ok(
    /\bworkspaceId\s*:\s*string/.test(body),
    "workspaceId must be REQUIRED on LLMTaskOptions. Optional (`workspaceId?:`) puts the burden back " +
      "on every caller to remember, which is exactly what failed twice. Found:\n" + body,
  );
  assert.ok(
    !/\bworkspaceId\s*\?/.test(body),
    "workspaceId is optional again. The two callers that were found by making it required " +
      "(WhatsApp photo vision, market-research planner) were found by the COMPILER, not by review.",
  );

  const service = readFileSync(join(process.cwd(), "src", "llm", "LLMService.ts"), "utf8");
  const runTaskAt = service.indexOf("async runTask");
  assert.notStrictEqual(runTaskAt, -1, "TARGET CHECK: runTask is gone or renamed");
  const head = service.slice(runTaskAt, runTaskAt + 400);
  assert.ok(
    !/options\.workspaceId\s*\|\|/.test(head) && !/options\.workspaceId\s*\?\?/.test(head),
    "runTask has a fallback for a missing workspace again. Any fallback here is silent " +
      "misattribution: it cannot be right, because the correct answer is only known to the caller.",
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
  console.log(`\nllm-workspace-attribution: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
