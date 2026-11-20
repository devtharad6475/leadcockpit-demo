/**
 * golden-provider-health.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Reported by the CEO: "if he's using some API key and the balance got over
 * zero, the system will automatically go to the fallback... So the owner will
 * not know that the system is now running on the fallback, and he will think
 * that everything is going correct."
 *
 * That was exactly true. LLMService.runTask caught every provider error in one
 * `catch`, swapped in the mock provider, and kept the reason in a `warning`
 * string on the returned object that nothing stored and no screen aggregated.
 * The header chip on EVERY screen went on reading "AI running 6/6", because it
 * reported which autonomy jobs were switched on and had never known whether the
 * key behind them worked.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the money case. OpenAI signals "your account has no credit" with
 *   HTTP 429 and `insufficient_quota` — the SAME status code it uses for real
 *   rate limiting. If that is read as rate limiting, the owner is told to wait,
 *   and waiting never refills an empty account. Balance must be checked before
 *   rate limit.
 *
 *   CASE B — the other providers' real wordings, each mapping to the action the
 *   owner actually has to take. "Top up" and "your key is invalid" are
 *   different jobs; telling someone the wrong one wastes their afternoon.
 *
 *   CASE C — a healthy workspace is not nagged. Real successes → healthy, and
 *   no alarm colour appears on a workspace that simply started today.
 *
 *   CASE D — the reported scenario end to end: runs that fell back because the
 *   balance ran out produce a BLOCKED lamp that names the cause and the action.
 *
 *   CASE E — recovery needs no switch. A real success after the failures flips
 *   the lamp back on its own, because a "turn the AI back on" step is the same
 *   silent-degradation bug moved one step later.
 *
 *   CASE F — the owner's OWN spend cap is the second way to run out. It blocks
 *   calls BEFORE the provider is contacted, so there is no failed run to read;
 *   without this the lamp would sit on healthy while nothing ran at all.
 *
 *   CASE G — one blip is not a condition. A single failed call must not shout.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { classifyProviderFailure } from "@/llm/provider-failure";
import { getProviderHealth } from "@/services/ProviderHealthService";

type Case = { name: string; fn: () => Promise<void> | void };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void> | void) { cases.push({ name, fn }); }

const repos = createJsonRepos();

/** An error shaped the way a provider SDK actually throws one. */
function providerError(message: string, status?: number) {
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) error.status = status;
  return error;
}

let seq = 0;
const ws = () => `ws_health_${Date.now()}_${seq++}`;

/** A run that reached the real model. */
async function realRun(workspaceId: string, provider = "deepseek") {
  return repos.agentRun.create({
    workspaceId,
    agentName: "reply_agent",
    status: "completed",
    output: { taskName: "whatsapp_reply", provider, modelName: "deepseek-chat", output: { reply: "ok" } },
  });
}

/** A run that fell back to the mock because the real provider refused. */
async function fallbackRun(workspaceId: string, failureReason: string, attemptedProvider = "deepseek") {
  return repos.agentRun.create({
    workspaceId,
    agentName: "reply_agent",
    status: "completed",
    output: { taskName: "whatsapp_reply", provider: "mock", fallbackUsed: true, attemptedProvider, failureReason, failureSummary: "x" },
  });
}

/**
 * A run that failed outright, at a chosen moment. This is the production shape
 * of the bug N14 exists for: extraction threw, the row is `failed`, and its
 * timestamp is the whole question — a failure now and the same failure last
 * night must not read the same way.
 */
async function failedRunAt(workspaceId: string, at: number, failureReason = "unknown") {
  return repos.agentRun.create({
    workspaceId,
    agentName: "document_extraction",
    status: "failed",
    createdAt: new Date(at).toISOString(),
    output: { taskName: "document_extraction", attemptedProvider: "deepseek", failureReason },
  });
}

const HOUR = 60 * 60 * 1000;

test("CASE A — an out-of-credit 429 is not read as 'just wait'", () => {
  // The real OpenAI shape. Both signals point at rate limiting; only the text
  // says what is actually wrong.
  const openai = classifyProviderFailure(providerError(
    "429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)",
    429,
  ));
  assert.strictEqual(openai.reason, "out_of_balance",
    "read as rate_limited, the owner is told to wait — and waiting never refills an empty account");
  assert.ok(/top up/i.test(openai.action), `the action must be the one that fixes it, got: ${openai.action}`);
  assert.strictEqual(openai.transient, false, "an empty account does not heal itself, so it must not be marked transient");

  // And a genuine rate limit is still a genuine rate limit — the fix above must
  // not turn every 429 into a billing scare.
  const real = classifyProviderFailure(providerError("Rate limit reached for requests", 429));
  assert.strictEqual(real.reason, "rate_limited");
  assert.strictEqual(real.transient, true, "nothing for the owner to do; it clears on its own");
});

test("CASE B — each provider's real wording maps to the owner's real next action", () => {
  const expected: Array<[string, number | undefined, string]> = [
    ["Insufficient Balance", 402, "out_of_balance"],                                   // DeepSeek
    ["Your credit balance is too low to access the Anthropic API", 400, "out_of_balance"], // Anthropic
    ["Incorrect API key provided: sk-***", 401, "invalid_key"],
    ["Missing API key for this slot", undefined, "no_key"],                            // our own guard
    ["Request timed out", undefined, "timeout"],
    ["503 Service Unavailable", 503, "provider_down"],
    ["something nobody has seen before", undefined, "unknown"],
  ];
  const wrong = expected
    .map(([message, status, reason]) => ({ message, got: classifyProviderFailure(providerError(message, status)).reason, want: reason }))
    .filter((row) => row.got !== row.want);
  assert.deepStrictEqual(wrong, [], "a wrong diagnosis sends the owner to fix the wrong thing");

  // "unknown" must still be actionable — saying nothing is how this bug started.
  assert.ok(classifyProviderFailure(providerError("???")).action.length > 0);
});

test("CASE C — a healthy workspace is not nagged, and a new one is not alarmed", async () => {
  const fresh = ws();
  const untouched = await getProviderHealth(fresh, repos);
  assert.strictEqual(untouched.status, "unknown", "a workspace that has not run the AI yet has no bad news to report");

  await realRun(fresh);
  await realRun(fresh);
  const healthy = await getProviderHealth(fresh, repos);
  assert.strictEqual(healthy.status, "healthy");
  assert.strictEqual(healthy.reason, "none");
  assert.strictEqual(healthy.degradedCalls, 0);
  assert.ok(healthy.lastRealSuccessAt, "and it can say when the real model last answered");
});

test("CASE D — the reported scenario: a dead balance is visible, named, and actionable", async () => {
  const workspaceId = ws();
  await realRun(workspaceId);                                  // it worked this morning
  await fallbackRun(workspaceId, "out_of_balance");            // then the balance ran out
  await fallbackRun(workspaceId, "out_of_balance");
  await fallbackRun(workspaceId, "out_of_balance");

  const health = await getProviderHealth(workspaceId, repos);
  assert.strictEqual(health.status, "blocked", "this is the state that used to render as 'AI running 6/6'");
  assert.strictEqual(health.reason, "out_of_balance");
  assert.strictEqual(health.degradedCalls, 3, "it counts only the unbroken recent streak, not all history");
  assert.strictEqual(health.provider, "deepseek", "and names WHICH provider needs the top-up");
  assert.ok(/no credit/i.test(health.headline), `the headline must say what is wrong: ${health.headline}`);
  assert.ok(/top up/i.test(health.action), `and the single next action: ${health.action}`);
  assert.ok(health.since, "and when it started, so the owner knows how long they have been on canned replies");
  assert.ok(health.lastRealSuccessAt, "and when it last genuinely worked");
});

test("CASE E — recovery needs no switch: one real success clears it", async () => {
  const workspaceId = ws();
  await fallbackRun(workspaceId, "out_of_balance");
  await fallbackRun(workspaceId, "out_of_balance");
  assert.strictEqual((await getProviderHealth(workspaceId, repos)).status, "blocked");

  // The top-up lands. Nothing in the product is toggled; the next call simply
  // succeeds, because the fallback was per-call and never a latch.
  await realRun(workspaceId);
  const recovered = await getProviderHealth(workspaceId, repos);
  assert.strictEqual(recovered.status, "healthy",
    "an owner who tops up and then has to remember a switch is back to running on canned replies without knowing");
  assert.strictEqual(recovered.degradedCalls, 0);
});

test("CASE F — the owner's own spend cap lights the same lamp", async () => {
  const workspaceId = ws();
  await realRun(workspaceId); // the last calls all succeeded; the CAP is what stopped the next one
  await repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
    dailyTokenLimit: 1000,
    currentDailyTokens: 1000,
    currentMonthlyTokens: 1000,
    currentDailyCost: 0,
    currentMonthlyCost: 0,
  });

  const health = await getProviderHealth(workspaceId, repos);
  assert.strictEqual(health.status, "blocked",
    "a cap stops calls BEFORE the provider is contacted, so there is no failed run to read — the lamp would have stayed green while nothing ran");
  assert.strictEqual(health.reason, "budget_exhausted");
  assert.ok(health.action.length > 0, "and it says where to raise it");
});

test("CASE G — one blip does not shout at the owner", async () => {
  const workspaceId = ws();
  await realRun(workspaceId);
  await fallbackRun(workspaceId, "timeout");

  const health = await getProviderHealth(workspaceId, repos);
  assert.strictEqual(health.status, "degraded",
    "a single transient timeout is worth noting quietly; a red alarm for it teaches the owner to ignore the red alarm");
  assert.strictEqual(health.transient, true);

  // But a transient fault that will not clear stops being transient news.
  await fallbackRun(workspaceId, "timeout");
  await fallbackRun(workspaceId, "timeout");
  await fallbackRun(workspaceId, "timeout");
  assert.strictEqual((await getProviderHealth(workspaceId, repos)).status, "blocked",
    "four failed calls in a row is a condition, whatever the provider called it");
});

test("CASE H — a failure from last night must not be reported as an outage this morning", async () => {
  // The exact sequence seen on production, 2026-09-18: two extraction calls
  // failed at 22:45, the bug behind them was fixed and deployed the same night,
  // and nothing ran afterwards. At 10am the chip still read "AI not answering"
  // — an hour before the owner showed the product to someone.
  const workspaceId = ws();
  const now = Date.now();
  await failedRunAt(workspaceId, now - 12 * HOUR);
  await failedRunAt(workspaceId, now - 11 * HOUR);

  const stale = await getProviderHealth(workspaceId, repos, now);
  assert.strictEqual(
    stale.status,
    "unknown",
    "THE POINT: nothing has been ATTEMPTED for eleven hours, so there is no evidence about now. " +
      "Claiming a present outage on eleven-hour-old evidence is how a warning light teaches an owner to ignore it.",
  );
  assert.ok(/hours ago/.test(stale.headline), `it must say WHEN, not just shrug. Got: ${stale.headline}`);
  assert.ok(/unknown/i.test(stale.headline), "and it must say plainly that the current state is not known");
  assert.strictEqual(stale.reason, "unknown", "the diagnosis is not thrown away — only the alarm is");
  assert.ok(stale.since, "and when the trouble started is still reported, so the owner can go and look");

  // The boundary, both sides. A fault from this morning still shouts through
  // the working day; one from last night does not greet the owner as today's.
  const fresh = ws();
  await failedRunAt(fresh, now - 5 * HOUR);
  assert.strictEqual(
    (await getProviderHealth(fresh, repos, now)).status,
    "blocked",
    "five hours is still today's problem — the calm state must not swallow a live outage",
  );

  const older = ws();
  await failedRunAt(older, now - 7 * HOUR);
  assert.strictEqual((await getProviderHealth(older, repos, now)).status, "unknown", "seven hours is history");
});

test("CASE I — a streak that STARTED long ago but failed again just now still shouts", async () => {
  // The trap in the fix: a run of failures has two timestamps — when it began
  // and when it last happened. Only the LATEST one says whether this is
  // happening now. Judge staleness by the oldest and a provider that has been
  // dead since yesterday, and is still failing this minute, goes quiet.
  const workspaceId = ws();
  const now = Date.now();
  await failedRunAt(workspaceId, now - 25 * HOUR, "out_of_balance");
  await failedRunAt(workspaceId, now - 20 * HOUR, "out_of_balance");
  await failedRunAt(workspaceId, now - 30 * 60 * 1000, "out_of_balance");

  const health = await getProviderHealth(workspaceId, repos, now);
  assert.strictEqual(
    health.status,
    "blocked",
    "the last attempt was half an hour ago and it failed — that is a live outage, however long it has been going on",
  );
  assert.strictEqual(health.degradedCalls, 3, "and the whole streak is still counted, not just the recent part");
  assert.ok(
    health.since && Date.parse(health.since) <= now - 24 * HOUR,
    "while 'since' still points at where it began, which is the other half of the story",
  );
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-provider-health — N-BUG (a dead API key must not read as 'AI running')\n");
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
  console.log(`provider-health: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
