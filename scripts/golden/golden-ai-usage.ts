/**
 * golden-ai-usage.ts — AIUsageService math pin (NEW coverage, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   AIUsageService had NO golden test (gap-analysis finding). It is the cost /
 *   token gate for every LLM call — if the accumulation math is wrong, either
 *   the operator gets silently overcharged (cost counter drifts) or the daily
 *   limit lets through more tokens than configured. Both are silent money bugs.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — recordUsage ACCUMULATES into daily AND monthly (independent counters).
 *     Start:        daily=0, monthly=0, dailyCost=0, monthlyCost=0
 *     recordUsage(tokens=500, cost=0.10)
 *     recordUsage(tokens=300, cost=0.05)
 *     Hand-computed AFTER:
 *       currentDailyTokens   = 500 + 300        = 800
 *       currentMonthlyTokens = 500 + 300        = 800   (same session, no reset)
 *       currentDailyCost     = 0.10 + 0.05      = 0.15
 *       currentMonthlyCost   = 0.10 + 0.05      = 0.15
 *     If the code resets daily on every call, monthly=800 but daily=300 → FAIL.
 *     If the code swaps daily/monthly, daily=800/monthly=800 still passes BUT
 *     CASE B separates them.
 *
 *   CASE B — resetUsageIfNeeded zeros DAILY counters when resetAt has passed,
 *     but PRESERVES monthly. This is the rule that prevents the monthly cost
 *     from silently resetting at midnight (operator would under-report spend).
 *       Before reset: daily=800, monthly=800, dailyCost=0.15, monthlyCost=0.15
 *       Force resetAt into the past → call resetUsageIfNeeded
 *       Hand-computed AFTER:
 *         currentDailyTokens   = 0     (daily resets)
 *         currentMonthlyTokens = 800   (monthly PRESERVED)
 *         currentDailyCost     = 0
 *         currentMonthlyCost   = 0.15  (PRESERVED)
 *
 *   CASE C — checkCanRunTask enforces the daily token limit exactly.
 *     dailyTokenLimit=1000, currentDailyTokens=800.
 *       estimatedTokens=150 → 800+150=950  ≤ 1000 → allowed=true
 *       estimatedTokens=250 → 800+250=1050 > 1000 → allowed=false
 *       estimatedTokens=200 → 800+200=1000 ≤ 1000 → allowed=true (boundary inclusive)
 *     Boundary-inclusive is the hand-computed rule (≤, not <).
 *
 *   CASE D — recordUsage CLAMPS negative tokens/cost to 0 (no negative drift).
 *       recordUsage(tokens=-999, cost=-5)
 *       Hand-computed: counters UNCHANGED (Math.max(0, negative) = 0 added).
 *     Without this clamp, a buggy upstream negative-report would REDUCE the
 *     counters, letting the operator exceed the daily limit for free.
 *
 *   CASE E — a fresh workspace gets SENSIBLE DEFAULT caps (R-4 fix). No record
 *     is ever uncapped: resetUsageIfNeeded seeds the defaults on create, and
 *     (T-4) even an anomalous record with undefined limits falls back to the
 *     default instead of Infinity (pinned by CASE H).
 *
 * REAL PIPELINE: imports the real AIUsageService functions + the real JSON repo.
 * A unique timestamped workspaceId means the real demo data is never touched.
 *
 * Run: `npm run golden:ai-usage`
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
import { checkCanRunTask, recordUsage, resetUsageIfNeeded, getUsage, DEFAULT_DAILY_TOKEN_LIMIT } from "@/services/AIUsageService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// Each case gets its OWN workspace so cases can't contaminate each other
// (recordUsage mutates persistent state; sharing WS would let CASE A's 800
// tokens leak into CASE B and double the monthly counter). A unique prefix
// per run also keeps the real demo JSON clean.
function caseWorkspace(caseSlug: string): string {
  return `ws_golden_aiusage_${caseSlug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function freshUsage(repos: RepositoryBundle, ws: string) {
  // Ensure a usage row exists (getUsage creates defaults on first read).
  return getUsage(ws, repos);
}

test("CASE A — recordUsage accumulates into BOTH daily and monthly counters (independent)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  await freshUsage(repos, WS);
  await recordUsage(WS, { tokens: 500, cost: 0.10 }, repos);
  await recordUsage(WS, { tokens: 300, cost: 0.05 }, repos);
  const u = await getUsage(WS, repos);
  // Hand-computed: 500+300=800 tokens, 0.10+0.05=0.15 cost in BOTH windows.
  assert.strictEqual(u.currentDailyTokens, 800, "daily tokens = 500+300 = 800");
  assert.strictEqual(u.currentMonthlyTokens, 800, "monthly tokens = 500+300 = 800 (no reset between)");
  // Cost: use approx equality to dodge float noise (0.10+0.05 = 0.15).
  assert.ok(Math.abs(u.currentDailyCost - 0.15) < 1e-9, `daily cost ≈ 0.15, got ${u.currentDailyCost}`);
  assert.ok(Math.abs(u.currentMonthlyCost - 0.15) < 1e-9, `monthly cost ≈ 0.15, got ${u.currentMonthlyCost}`);
});

test("CASE B — resetUsageIfNeeded zeros DAILY but PRESERVES monthly (midnight reset)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  await freshUsage(repos, WS);
  // Build up: daily=800, monthly=800, dailyCost=0.15, monthlyCost=0.15
  await recordUsage(WS, { tokens: 500, cost: 0.10 }, repos);
  await recordUsage(WS, { tokens: 300, cost: 0.05 }, repos);

  // Force the resetAt into the PAST so resetUsageIfNeeded triggers a daily reset.
  const before = await getUsage(WS, repos);
  await repos.aiUsageLimit.upsertForWorkspace(WS, { ...before, resetAt: "2000-01-01T00:00:00.000Z" });

  await resetUsageIfNeeded(WS, repos);
  const u = await getUsage(WS, repos);
  // Hand-computed: daily zeroes, monthly PRESERVED.
  assert.strictEqual(u.currentDailyTokens, 0, "daily tokens RESET to 0 at resetAt boundary");
  assert.strictEqual(u.currentMonthlyTokens, 800, "monthly tokens PRESERVED across daily reset");
  assert.ok(Math.abs(u.currentDailyCost - 0) < 1e-9, "daily cost RESET to 0");
  assert.ok(Math.abs(u.currentMonthlyCost - 0.15) < 1e-9, `monthly cost PRESERVED at 0.15, got ${u.currentMonthlyCost}`);
});

test("CASE Z — while the product is being built (AI_USAGE_CAPS not 'on') the caps do not block, but usage is still recorded", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("Z");
  await freshUsage(repos, WS);
  await recordUsage(WS, { tokens: 800, cost: 0 }, repos);
  const cur = await getUsage(WS, repos);
  await repos.aiUsageLimit.upsertForWorkspace(WS, { ...cur, dailyTokenLimit: 1000 });
  const saved = process.env.AI_USAGE_CAPS;
  try {
    delete process.env.AI_USAGE_CAPS;
    const over = await checkCanRunTask(WS, "msg-gen", 5000, 0, repos);
    assert.strictEqual(over.allowed, true, "a call over the cap was blocked while caps are off");
    assert.strictEqual((await getUsage(WS, repos)).currentDailyTokens, 800, "usage stopped being recorded");
    process.env.AI_USAGE_CAPS = "on";
    assert.strictEqual((await checkCanRunTask(WS, "msg-gen", 5000, 0, repos)).allowed, false, "AI_USAGE_CAPS=on did not turn the caps back on");
  } finally {
    process.env.AI_USAGE_CAPS = saved;
  }
});

test("CASE C — checkCanRunTask enforces dailyTokenLimit exactly (boundary inclusive)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  await freshUsage(repos, WS);
  // Set dailyTokenLimit=1000 and prime currentDailyTokens=800.
  await recordUsage(WS, { tokens: 800, cost: 0 }, repos);
  const cur = await getUsage(WS, repos);
  await repos.aiUsageLimit.upsertForWorkspace(WS, { ...cur, dailyTokenLimit: 1000 });

  // Hand-computed: 800+150=950 ≤ 1000 → allowed.
  const r1 = await checkCanRunTask(WS, "msg-gen", 150, 0, repos);
  assert.strictEqual(r1.allowed, true, "950 ≤ 1000 → allowed");

  // 800+250=1050 > 1000 → blocked.
  const r2 = await checkCanRunTask(WS, "msg-gen", 250, 0, repos);
  assert.strictEqual(r2.allowed, false, "1050 > 1000 → blocked");

  // 800+200=1000 ≤ 1000 → allowed (boundary INCLUSIVE, not strict <).
  const r3 = await checkCanRunTask(WS, "msg-gen", 200, 0, repos);
  assert.strictEqual(r3.allowed, true, "1000 ≤ 1000 → allowed (boundary inclusive)");
});

test("CASE D — recordUsage CLAMPS negative tokens/cost to 0 (no negative drift)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  await freshUsage(repos, WS);
  await recordUsage(WS, { tokens: 500, cost: 0.20 }, repos);
  const before = await getUsage(WS, repos);

  // A buggy upstream reports negative usage. Must NOT reduce the counters.
  await recordUsage(WS, { tokens: -999, cost: -5 }, repos);
  const after = await getUsage(WS, repos);

  assert.strictEqual(after.currentDailyTokens, before.currentDailyTokens, "negative tokens clamped to 0 — daily unchanged");
  assert.strictEqual(after.currentMonthlyTokens, before.currentMonthlyTokens, "negative tokens clamped to 0 — monthly unchanged");
  assert.ok(Math.abs(after.currentDailyCost - before.currentDailyCost) < 1e-9, "negative cost clamped to 0 — daily cost unchanged");
});

test("CASE E — fresh workspace gets SENSIBLE DEFAULT caps (R-4 fix: no more Infinity)", async () => {
  // Audit 2026-07-27 S6 R-4: a fresh workspace previously had NO limits
  // (undefined → Infinity), so a runaway loop could burn the budget. Now
  // resetUsageIfNeeded seeds DEFAULT_DAILY_TOKEN_LIMIT etc. A request within
  // the defaults is allowed; one exceeding them is blocked.
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  const u = await freshUsage(repos, WS);
  // Defaults must be set (not undefined).
  //
  // 2026-09-18 (session 57): this read `=== 500_000`. The operator raised the
  // default to 2,000,000 after a measured extraction was refused mid-run by the
  // old cap, and the case then failed for spelling a number rather than for
  // anything being wrong. What it actually exists to protect is that a fresh
  // workspace is CAPPED — a real, finite, non-zero ceiling — so that is what it
  // asserts now, against the service's own constant. A zero or missing cap does
  // not throttle AI, it disables it; Infinity is the original R-4 defect.
  assert.strictEqual(
    u.dailyTokenLimit,
    DEFAULT_DAILY_TOKEN_LIMIT,
    `a fresh workspace must be seeded with the service's default daily cap (${DEFAULT_DAILY_TOKEN_LIMIT}), got ${u.dailyTokenLimit}`,
  );
  assert.ok(
    Number.isFinite(u.dailyTokenLimit) && (u.dailyTokenLimit || 0) > 0,
    `the default daily cap must be finite and above zero — Infinity is the R-4 defect and 0 disables AI entirely. Got ${u.dailyTokenLimit}`,
  );
  // N-AI-8 (2026-08-26): this used to read 15_000. That was never a monthly
  // budget of fifteen thousand of anything the product measures — the only
  // place a cost is COMPUTED is LLMService's per-1k-token table, which is US
  // dollars, so the cap was dollars wearing a rupee label and the real ceiling
  // was $15,000/month. This is not a loosened assertion: it is the same
  // assertion, on the number that was always meant. See CASE I.
  assert.ok(u.monthlyCostLimit === 180, `fresh workspace monthlyCostLimit = 180 USD, got ${u.monthlyCostLimit}`);
  // A small request within defaults is allowed.
  const within = await checkCanRunTask(WS, "msg-gen", 1000, 1, repos);
  assert.strictEqual(within.allowed, true, "small request within defaults → allowed");
  // A huge request exceeding the daily token default is BLOCKED (was allowed pre-fix).
  const huge = await checkCanRunTask(WS, "msg-gen", 10_000_000, 0, repos);
  assert.strictEqual(huge.allowed, false, "10M tokens exceeds 500K daily default → blocked (R-4 fix)");
});

test("CASE F — checkCanRunTask enforces the MONTHLY COST gate (R-4 fix: was unchecked)", async () => {
  // Audit 2026-07-27 S6 R-4: previously only dailyTokenLimit was checked; the
  // monthly cost limit was IGNORED even when set. Now any of the 4 limits
  // exceeding blocks the task. Seed a workspace near its monthly cost cap and
  // prove a small additional cost is blocked.
  const repos = createJsonRepos();
  const WS = caseWorkspace("F");
  await freshUsage(repos, WS);
  // Prime: currentMonthlyCost = 1900, monthlyCostLimit = 2000.
  await recordUsage(WS, { tokens: 100, cost: 1900 }, repos);
  const cur = await getUsage(WS, repos);
  // The DAILY cost cap is lifted out of the way on purpose. recordUsage adds
  // to the daily and monthly counters together, so priming 1900 of monthly
  // spend also primes 1900 of daily spend. This case is about the MONTHLY
  // gate; leaving the daily cap at its default would mean the daily gate
  // fires first and this case silently stops testing what it names.
  //
  // It used to pass without this line only because the default daily cap was
  // 2,000 -- the rupee-scale value corrected in N-AI-8. A test that depends
  // on a default being absurdly large is a test resting on a bug.
  await repos.aiUsageLimit.upsertForWorkspace(WS, { ...cur, monthlyCostLimit: 2000, dailyCostLimit: 1e9 });
  // A $1 task: 1900 + 1 = 1901 ≤ 2000 → allowed. (The cap is set explicitly
  // in this case, so it is unaffected by the N-AI-8 default change.)
  const ok = await checkCanRunTask(WS, "msg-gen", 100, 1, repos);
  assert.strictEqual(ok.allowed, true, "1901 ≤ 2000 monthly cost → allowed");
  // A $200 task: 1900 + 200 = 2100 > 2000 → BLOCKED (the load-bearing R-4 assertion).
  const blocked = await checkCanRunTask(WS, "msg-gen", 100, 200, repos);
  assert.strictEqual(blocked.allowed, false, "2100 > 2000 monthly cost → blocked (R-4: monthly cost gate now enforced)");
  assert.ok(/monthly cost/i.test(blocked.reason), `reason mentions monthly cost, got "${blocked.reason}"`);
});

test("CASE G — the blocking reason names WHICH limit was exceeded", async () => {
  // Operator clarity: when blocked, the reason must say which limit fired so
  // the owner knows whether to raise the daily token cap, monthly cost cap, etc.
  const repos = createJsonRepos();
  const WS = caseWorkspace("G");
  await freshUsage(repos, WS);
  const cur = await getUsage(WS, repos);
  await repos.aiUsageLimit.upsertForWorkspace(WS, { ...cur, dailyTokenLimit: 100, monthlyTokenLimit: 100, dailyCostLimit: 1, monthlyCostLimit: 1 });
  // A request exceeding daily tokens only.
  const r = await checkCanRunTask(WS, "msg-gen", 500, 0, repos);
  assert.strictEqual(r.allowed, false, "blocked");
  assert.ok(/daily tokens/i.test(r.reason), `reason names "daily tokens", got "${r.reason}"`);
});

test("CASE H — an anomalous record with UNDEFINED limits falls back to the safe DEFAULT, never Infinity (T-4 fix)", async () => {
  // Session 7 (2026-07-28) T-4: the limit fields are optional in the type, so a
  // record could exist with undefined limits (created before defaults, or
  // manually edited). Previously checkCanRunTask fell back to +Infinity for a
  // missing limit — i.e. NO cap — the exact budget-burn risk R-4 was meant to
  // close. Now a missing limit falls back to DEFAULT_DAILY_TOKEN_LIMIT etc., so
  // no record can ever be uncapped. We force an anomalous record (explicitly
  // undefined limits) and prove a huge request is BLOCKED by the default.
  const { DEFAULT_DAILY_TOKEN_LIMIT } = await import("@/services/AIUsageService");
  const repos = createJsonRepos();
  const WS = caseWorkspace("H");
  await freshUsage(repos, WS);
  // Force an anomalous record: wipe all 4 limits to undefined while keeping the row.
  const cur = await getUsage(WS, repos);
  await repos.aiUsageLimit.upsertForWorkspace(WS, {
    ...cur,
    dailyTokenLimit: undefined,
    monthlyTokenLimit: undefined,
    dailyCostLimit: undefined,
    monthlyCostLimit: undefined,
  });
  // A request WAY over the default token cap MUST be blocked (was allowed pre-T-4).
  const huge = await checkCanRunTask(WS, "msg-gen", DEFAULT_DAILY_TOKEN_LIMIT + 100_000, 0, repos);
  assert.strictEqual(huge.allowed, false, "T-4: anomalous record with undefined limit must fall back to the DEFAULT (not Infinity) — huge request blocked");
  assert.ok(/daily tokens/i.test(huge.reason), `T-4: reason names daily tokens (fell back to default), got "${huge.reason}"`);
  // And a request within the default is allowed (default is applied, not a hard zero).
  const within = await checkCanRunTask(WS, "msg-gen", 1000, 1, repos);
  assert.strictEqual(within.allowed, true, "T-4: request within the default cap is allowed (default applied, not over-blocking)");
});

test("CASE I — the cost caps are in the SAME currency the product records, and nothing converts (N-AI-8)", async () => {
  // ── THE DEFECT ────────────────────────────────────────────────────────────
  // The two default cost caps were written as ₹2,000/day and ₹15,000/month and
  // the refusal message printed a ₹ sign. Nothing in the product ever converted
  // a currency. The ONLY place a cost is computed is LLMService's
  // COST_PER_1K_TOKENS_USD table — dollars — and every seed and script that
  // sets a cap uses dollar-sized numbers ($5/$100, $50/$500). So the "hard
  // stop" advertised as ₹2,000 was really $2,000: roughly 80x looser than the
  // number it claimed to be.
  //
  // It had never bitten, because the TOKEN cap always bound first. Voice
  // transcription (N-AI-7) removed that shield: Whisper is priced per minute
  // and burns no tokens, so for a voice note this cost cap is the only brake
  // there is. This case exists so the label and the money can never drift apart
  // again.
  const { DEFAULT_DAILY_COST_LIMIT, DEFAULT_MONTHLY_COST_LIMIT, DEFAULT_DAILY_TOKEN_LIMIT } =
    await import("@/services/AIUsageService");

  // 1. NOTHING CONVERTS. A cost recorded is the cost stored, to the cent. An FX
  //    multiplication anywhere on this path shows up here immediately.
  const repos = createJsonRepos();
  const WS = caseWorkspace("I");
  await freshUsage(repos, WS);
  await recordUsage(WS, { tokens: 0, cost: 0.15 }, repos);
  const after = await getUsage(WS, repos);
  assert.strictEqual(
    after.currentDailyCost,
    0.15,
    `a recorded cost of 0.15 must be stored as 0.15. Got ${after.currentDailyCost}. Any other value ` +
      "means something on this path is multiplying by an exchange rate — which would also have to be " +
      "divided back out at every read, in the UI, and in every report.",
  );

  // 2. THE DEFAULT CAP IS A BACKSTOP, NOT THE BRAKE, AND NOT DECORATION.
  //    Tied to the real pricing table rather than to a magic number: the daily
  //    token cap costs about this much at the fallback rate, so the daily cost
  //    cap must sit ABOVE it (or the token cap never gets to fire) and within
  //    reach of it (or it can never fire at all — which is what ₹2,000 did).
  const llm = readFileSync(join(process.cwd(), "src", "llm", "LLMService.ts"), "utf8");
  const rateMatch = llm.match(/COST_PER_1K_TOKENS_USD\[providerName\] \?\? ([0-9.]+)/);
  assert.ok(rateMatch, "TARGET CHECK: the per-1k-token fallback rate is gone from LLMService — this case is watching nothing");
  const fallbackRate = Number(rateMatch![1]);
  const dailyTokenCapCostsUsd = (DEFAULT_DAILY_TOKEN_LIMIT / 1000) * fallbackRate;

  assert.ok(
    DEFAULT_DAILY_COST_LIMIT > dailyTokenCapCostsUsd,
    `the daily cost cap ($${DEFAULT_DAILY_COST_LIMIT}) must exceed what a full day of tokens costs ` +
      `($${dailyTokenCapCostsUsd}), otherwise the cost cap fires first and the token cap is decoration.`,
  );
  assert.ok(
    DEFAULT_DAILY_COST_LIMIT < dailyTokenCapCostsUsd * 100,
    `the daily cost cap ($${DEFAULT_DAILY_COST_LIMIT}) is more than 100x a full day of tokens ` +
      `($${dailyTokenCapCostsUsd}). That is the rupee-scale value coming back: a ceiling nothing can ` +
      "reach is not a hard stop, and voice transcription has no token cap standing in front of it.",
  );
  assert.ok(
    DEFAULT_MONTHLY_COST_LIMIT > DEFAULT_DAILY_COST_LIMIT,
    `a monthly cap ($${DEFAULT_MONTHLY_COST_LIMIT}) below the daily cap ($${DEFAULT_DAILY_COST_LIMIT}) ` +
      "makes the daily cap unreachable",
  );

  // 3. THE MESSAGE SAYS DOLLARS. An operator reading "₹" next to a dollar
  //    figure will size their budget wrong by a factor of eighty.
  const capped = createJsonRepos();
  const WS2 = caseWorkspace("I2");
  await freshUsage(capped, WS2);
  const cur = await getUsage(WS2, capped);
  await capped.aiUsageLimit.upsertForWorkspace(WS2, { ...cur, dailyCostLimit: 1 });
  const blocked = await checkCanRunTask(WS2, "msg-gen", 0, 5, capped);
  assert.strictEqual(blocked.allowed, false, "TARGET CHECK: $5 against a $1 cap must be refused, or there is no message to read");
  assert.ok(
    blocked.reason.includes("$") && !blocked.reason.includes("₹"),
    `the refusal must name the currency the number is actually in. Got: "${blocked.reason}"`,
  );
});

test("CASE J — a row whose caps are ZERO heals to the defaults instead of disabling all AI (N-BUG 2026-09-07)", async () => {
  // ── THE DEFECT ────────────────────────────────────────────────────────────
  // On the live Postgres deployment every LLM call was refused before dispatch
  // with "Usage limit would be exceeded: daily tokens (1000 > 0); monthly
  // tokens (1000 > 0)". Nobody had set a zero budget. The chain was:
  //
  //   1. AISettingsService.getOrCreateUsage created the singleton usage row
  //      with all four limits `undefined` → four NULL columns.
  //   2. The Prisma mapper tested `record.dailyTokenLimit === undefined`.
  //      Prisma hands back NULL as `null`, not `undefined`, so that test was
  //      false and the limit came back as `Number(null)` === 0.
  //   3. checkCanRunTask's `?? DEFAULT_DAILY_TOKEN_LIMIT` does not fire on 0,
  //      so a hard zero cap stuck — and the next daily reset copied it back
  //      into the row as a literal 0, making it permanent.
  //
  // JSON mode never saw any of it, because a missing key there really IS
  // `undefined`. So the whole AI surface was dead on Postgres and green in
  // every test. Steps 1 and 2 are fixed at source; this case pins step 3 — a
  // cap of 0 is not a budget decision anybody can make in this product, so it
  // is repaired on read rather than silently disabling the product.
  const { DEFAULT_DAILY_TOKEN_LIMIT, DEFAULT_MONTHLY_TOKEN_LIMIT } = await import("@/services/AIUsageService");
  const repos = createJsonRepos();
  const WS = caseWorkspace("J");
  await freshUsage(repos, WS);
  // Reproduce the damaged row exactly: all four caps a literal 0, and a reset
  // window still open so the daily-rollover path is NOT what saves us.
  const cur = await getUsage(WS, repos);
  await repos.aiUsageLimit.upsertForWorkspace(WS, {
    ...cur,
    dailyTokenLimit: 0,
    monthlyTokenLimit: 0,
    dailyCostLimit: 0,
    monthlyCostLimit: 0,
    currentDailyTokens: 250,
    currentDailyCost: 0.5,
    resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const healed = await getUsage(WS, repos);
  assert.strictEqual(healed.dailyTokenLimit, DEFAULT_DAILY_TOKEN_LIMIT, `a zero daily cap heals to the default, got ${healed.dailyTokenLimit}`);
  assert.strictEqual(healed.monthlyTokenLimit, DEFAULT_MONTHLY_TOKEN_LIMIT, `a zero monthly cap heals to the default, got ${healed.monthlyTokenLimit}`);
  // Healing must not double as a free amnesty on the day's spend.
  assert.strictEqual(healed.currentDailyTokens, 250, `healing the caps must not reset the day's token counter, got ${healed.currentDailyTokens}`);
  assert.strictEqual(healed.currentDailyCost, 0.5, `healing the caps must not reset the day's cost counter, got ${healed.currentDailyCost}`);

  // The symptom itself: an ordinary batch is allowed again.
  const ordinary = await checkCanRunTask(WS, "knowledge-extraction", 1000, 0.01, repos);
  assert.strictEqual(ordinary.allowed, true, `an ordinary 1000-token batch must run after healing. Got: "${ordinary.reason}"`);
  // And the cap is still a real cap, not an amnesty.
  const huge = await checkCanRunTask(WS, "knowledge-extraction", DEFAULT_DAILY_TOKEN_LIMIT + 1, 0, repos);
  assert.strictEqual(huge.allowed, false, "healing must restore a REAL cap — a request over the default is still blocked");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
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
  console.log("");
  console.log(`ai-usage: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
