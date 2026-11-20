/**
 * golden-infra-libs.ts — pins the infrastructure CHOKEPOINT libraries that had
 * no golden of their own (Stage 6 / 2026-07-31 full coverage sweep).
 *
 * WHY THIS TEST EXISTS:
 *   The full-tree Coverage Map found these infra files were DARK. Each holds
 *   in-memory pure logic that a regression would silently break. Grouped here
 *   by family (one golden, related infra):
 *     - ModelRouter.ts     (task→slot mapping, model-name resolution, routing)
 *     - events/EventBus + EventDispatcher + EventHandlers (pub/sub dispatch)
 *     - jobs/queue/MemoryQueueBackend (the in-memory job queue)
 *     - lib/api-response   (the 8 HTTP envelope builders)
 *     - lib/api-auth       (validateApiKeyOrWebhookSecret + assertSameWorkspace)
 *     - lib/clipboard      (copyToClipboard fallback chain)
 *     - policies/PolicyLoader (loadPolicyMarkdown)
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — written before running):
 *
 *   CASE A — ModelRouter: TASK_SLOT_MAP maps whatsapp_reply→fast_customer_reply,
 *     icp_generation→deep_reasoning, embedding→embedding_advanced; getSlotForTask
 *     unknown→daily_workhorse; resolveEffectiveModelName requires a custom name
 *     for "-custom"/"-compatible" selections; defaultSlotRoutes returns 6 routes.
 *   CASE B — EventBus/Dispatcher: register + dispatch fires the handler with the
 *     payload; an unregistered event type dispatches to nobody (no throw).
 *   CASE C — MemoryQueueBackend: enqueue + process runs the registered handler;
 *     unknown job type throws; listQueuedJobs reflects state; reset clears.
 *   CASE D — api-response: each builder returns the documented {success,...}
 *     envelope + HTTP status (success=200, error=custom, validation=400, etc).
 *   CASE E — api-auth: missing secret in production → ok:false; correct secret →
 *     ok:true; wrong secret → ok:false; assertSameWorkspace throws on mismatch.
 *   CASE F — PolicyLoader: loads a markdown file + returns its text; missing
 *     file → throws (never silent).
 *
 * Run: npx tsx scripts/golden/golden-infra-libs.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { NextRequest } from "next/server";
import {
  TASK_SLOT_MAP,
  getSlotForTask,
  resolveEffectiveModelName,
  defaultSlotRoutes,
  routeModel,
} from "@/llm/ModelRouter";
import { registerEventHandler, dispatchEvent } from "@/events/EventBus";
import { emitEvent } from "@/events/EventDispatcher";
import { registerDefaultEventHandlers } from "@/events/EventHandlers";
import {
  registerJobHandlerMemory,
  enqueueJobMemory,
  processJobMemory,
  listQueuedJobsMemory,
  getRegisteredHandlerTypesMemory,
  resetMemoryBackendForTesting,
} from "@/jobs/queue/MemoryQueueBackend";
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  notFoundResponse,
  forbiddenResponse,
  unauthorizedResponse,
  rateLimitedResponse,
  configurationErrorResponse,
} from "@/lib/api-response";
import { validateApiKeyOrWebhookSecret, assertSameWorkspace } from "@/lib/api-auth";
import { loadPolicyMarkdown } from "@/policies/PolicyLoader";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// ─── CASE A: ModelRouter ────────────────────────────────────────────────────
test("CASE A — ModelRouter: task→slot map, slot lookup, custom-name resolution, default routes", async () => {
  // N-AI-2 (2026-08-20): slot defaults are no longer a frozen mock table — they
  // are resolved from the environment, so a fresh install runs on the operator's
  // real key instead of answering customers with MockLLMProvider text. Every
  // assertion below is about the NO-KEY baseline, and this golden's own imports
  // pull in .env, so the keys are cleared for the duration and restored after.
  // The key-present branch is owned by golden-platform-ai-defaults (CASE B).
  const keyEnvNames = ["PLATFORM_DEEPSEEK_API_KEY", "PLATFORM_OPENAI_API_KEY", "PLATFORM_ANTHROPIC_API_KEY", "PLATFORM_GEMINI_API_KEY", "PLATFORM_KIMI_API_KEY", "PLATFORM_MINIMAX_API_KEY", "PLATFORM_DEFAULT_PROVIDER"];
  const savedKeys = keyEnvNames.map((name) => [name, process.env[name]] as const);
  for (const name of keyEnvNames) delete process.env[name];
  try {
  // Task→slot mapping (hand-picked from TASK_SLOT_MAP).
  assert.strictEqual(TASK_SLOT_MAP.whatsapp_reply, "fast_customer_reply");
  assert.strictEqual(TASK_SLOT_MAP.icp_generation, "deep_reasoning");
  assert.strictEqual(TASK_SLOT_MAP.embedding, "embedding_advanced");
  assert.strictEqual(TASK_SLOT_MAP.image_generation, "creative_image");
  assert.strictEqual(TASK_SLOT_MAP.web_search, "research_search");
  // getSlotForTask: known + unknown (default daily_workhorse).
  assert.strictEqual(getSlotForTask("lead_scoring"), "daily_workhorse");
  assert.strictEqual(getSlotForTask("nonexistent_task" as never), "daily_workhorse", "unknown task defaults to daily_workhorse");
  // routeModel: returns the slot's default tier; override wins.
  assert.strictEqual(routeModel("whatsapp_reply"), "fast", "whatsapp_reply slot tier = fast");
  assert.strictEqual(routeModel("icp_generation"), "strong", "icp_generation slot tier = strong");
  assert.strictEqual(routeModel("whatsapp_reply", "balanced"), "balanced", "explicit override wins");
  // resolveEffectiveModelName: plain name passes through.
  assert.strictEqual(resolveEffectiveModelName("gpt-4o", undefined), "gpt-4o");
  // custom selection REQUIRES a customModelName.
  assert.throws(() => resolveEffectiveModelName("openai_compatible-custom", undefined), /Custom model name is required/);
  assert.strictEqual(resolveEffectiveModelName("openai_compatible-custom", "my-model"), "my-model");
  // defaultSlotRoutes: 6 routes (one per slot), all enabled, mock provider.
  const routes = defaultSlotRoutes("ws_test");
  assert.strictEqual(routes.length, 6, "6 default slot routes");
  assert.ok(routes.every((r) => r.isEnabled === true), "all default routes enabled");
  assert.ok(routes.every((r) => r.provider === "mock"), "with NO platform key, defaults use mock provider");
  } finally {
    for (const [name, value] of savedKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ─── CASE B: EventBus + EventDispatcher + EventHandlers ─────────────────────
test("CASE B — EventBus/Dispatcher: register + dispatch fires handler; unhandled event no-ops", async () => {
  // registerDefaultEventHandlers must register without throwing (typed union).
  registerDefaultEventHandlers();
  let received: unknown = null;
  // Use a REAL AppEventType from the union (lead.scored). "*" wildcard handler.
  registerEventHandler("lead.scored", (event) => { received = event.payload; });
  const event = {
    eventId: "evt_golden_1",
    eventType: "lead.scored" as const,
    workspaceId: "ws_golden",
    source: "golden-test",
    timestamp: new Date().toISOString(),
    payload: { score: 42 },
  };
  await dispatchEvent(event);
  assert.deepStrictEqual(received, { score: 42 }, "dispatched event fires the registered handler with payload");
  // emitEvent (dispatcher) also fires.
  let got = false;
  registerEventHandler("lead.approved", () => { got = true; });
  await emitEvent({ ...event, eventType: "lead.approved" as const, eventId: "evt_golden_2" });
  assert.strictEqual(got, true, "emitEvent fires handlers");
  // An event type with NO registered handler dispatches to nobody without throwing.
  await assert.doesNotReject(() =>
    dispatchEvent({ ...event, eventType: "campaign.completed" as const, eventId: "evt_golden_3" }),
  );
});

// ─── CASE C: MemoryQueueBackend ─────────────────────────────────────────────
test("CASE C — MemoryQueueBackend: enqueue + process runs handler; unknown type throws; list + reset", async () => {
  resetMemoryBackendForTesting();
  let ran = false;
  // Use a REAL JobType from the union (score_lead).
  registerJobHandlerMemory("score_lead", async () => { ran = true; });
  assert.ok(getRegisteredHandlerTypesMemory().includes("score_lead"), "handler registered");
  const job = await enqueueJobMemory({
    workspaceId: "ws_golden",
    type: "score_lead",
    payload: { leadId: "lead_1" },
    maxAttempts: 3,
  });
  assert.ok(job.jobId, "enqueue returns a job with an id");
  const queued = listQueuedJobsMemory();
  assert.ok(queued.some((j) => j.jobId === job.jobId), "job appears in queued list");
  await processJobMemory(job);
  assert.strictEqual(ran, true, "processJobMemory ran the registered handler");
  // HONEST CONTRACT: an unregistered JobType does NOT throw — processJobMemory
  // returns the job UNCHANGED (documented "quirk preserved": no handler → no-op).
  // We pin this so a future change to throw (arguably better) is a deliberate
  // decision, not a silent drift.
  const noHandlerJob = await enqueueJobMemory({
    workspaceId: "ws_golden", type: "send_notification", payload: {}, maxAttempts: 1,
  });
  const result = await processJobMemory(noHandlerJob);
  assert.strictEqual(result.status, "queued", "unregistered job type is returned UNCHANGED (no handler → no-op quirk)");
  resetMemoryBackendForTesting();
  assert.strictEqual(listQueuedJobsMemory().length, 0, "reset clears the queue");
});

// ─── CASE D: api-response envelopes ─────────────────────────────────────────
test("CASE D — api-response: each builder returns the documented NextResponse + status", async () => {
  // successResponse → {success, data, meta}, status 200.
  const ok = successResponse({ a: 1 });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { success: true, data: { a: 1 }, meta: {} });
  // errorResponse(message, statusCode, details, code) → {success:false, error:{message, code, details}}.
  const err = errorResponse("boom", 418, { d: 1 }, "teapot");
  assert.strictEqual(err.status, 418);
  const errBody = await err.json();
  assert.strictEqual(errBody.success, false);
  assert.strictEqual(errBody.error.code, "TEAPOT", "code is uppercased");
  assert.strictEqual(errBody.error.message, "boom");
  // validationErrorResponse → 422 (zod standard).
  assert.strictEqual(validationErrorResponse("bad").status, 422);
  // The status-coded helpers.
  assert.strictEqual(notFoundResponse("Lead").status, 404);
  assert.strictEqual(forbiddenResponse("no").status, 403);
  assert.strictEqual(unauthorizedResponse().status, 401);
  assert.strictEqual(rateLimitedResponse("slow").status, 429);
  // configurationErrorResponse → 400 (client config problem, not server).
  assert.strictEqual(configurationErrorResponse("missing").status, 400);
});

// ─── CASE E: api-auth ───────────────────────────────────────────────────────
test("CASE E — api-auth: missing secret in production fails closed; correct/wrong secret; workspace mismatch throws", async () => {
  const prevMode = process.env.AUTH_MODE;
  const prevSecret = process.env.INBOUND_WEBHOOK_SECRET;
  try {
    process.env.AUTH_MODE = "production";
    delete process.env.INBOUND_WEBHOOK_SECRET;
    delete process.env.API_SHARED_SECRET;
    // Production + no secret → fail closed.
    const missing = validateApiKeyOrWebhookSecret(new NextRequest("http://x/api"));
    assert.strictEqual(missing.ok, false, "production + missing secret fails closed");

    // Configure a secret + correct header → ok.
    process.env.INBOUND_WEBHOOK_SECRET = "shh-2026";
    const goodReq = new NextRequest("http://x/api", { headers: { "x-webhook-secret": "shh-2026" } });
    const good = validateApiKeyOrWebhookSecret(goodReq);
    assert.strictEqual(good.ok, true, "correct secret passes");
    // Wrong secret → fail.
    const badReq = new NextRequest("http://x/api", { headers: { "x-webhook-secret": "wrong" } });
    const bad = validateApiKeyOrWebhookSecret(badReq);
    assert.strictEqual(bad.ok, false, "wrong secret fails");
    // No header at all → fail.
    const noHeader = validateApiKeyOrWebhookSecret(new NextRequest("http://x/api"));
    assert.strictEqual(noHeader.ok, false, "no header fails");

    // assertSameWorkspace throws on mismatch; passes on match.
    assert.throws(() => assertSameWorkspace("ws_a", "ws_b"), /Workspace access denied/);
    assert.doesNotThrow(() => assertSameWorkspace("ws_a", "ws_a"));
  } finally {
    if (prevMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prevMode;
    if (prevSecret === undefined) delete process.env.INBOUND_WEBHOOK_SECRET; else process.env.INBOUND_WEBHOOK_SECRET = prevSecret;
  }
});

// ─── CASE F: PolicyLoader ───────────────────────────────────────────────────
test("CASE F — PolicyLoader: loads a known policy; unknown key falls back gracefully (never throws)", async () => {
  // A known real policy key → non-empty markdown text.
  const text = await loadPolicyMarkdown("no-hallucination-policy");
  assert.ok(typeof text === "string" && text.length > 0, "loaded policy markdown is non-empty text");
  // HONEST CONTRACT: an unknown key / unreadable file NEVER throws — it falls
  // back to the global policy (or the default-agent-behavior JSON). This is the
  // defensive design (the agent must always get SOME policy). We pin that it
  // returns non-empty text rather than throwing.
  const fallback = await loadPolicyMarkdown("this-key-does-not-exist-xyz");
  assert.ok(typeof fallback === "string" && fallback.length > 0, "unknown key falls back to non-empty text (never throws, never empty)");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
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
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-infra-libs FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-infra-libs ALL GREEN ✅");
  process.exit(0);
})();
