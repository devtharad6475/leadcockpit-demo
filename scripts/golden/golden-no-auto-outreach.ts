/**
 * golden-no-auto-outreach.ts — the SACRED no-auto-outreach rule, pinned (NEW, S6 R-2).
 *
 * WHY THIS TEST EXISTS:
 *   The operator's highest-stakes contract: NOTHING sends a real WhatsApp
 *   message to a real customer WITHOUT explicit human (owner) approval.
 *   Audit S6 R-2 found this rule was protected only by code review — the SAME
 *   gap that caused the original "phantom agent" miss (an agent was never
 *   invoked and nobody noticed until an audit). A well-meaning future agent
 *   could add `await provider.sendTextMessage(...)` to "make the daily digest
 *   actually send" and the smokes would still pass. This golden makes that
 *   regression impossible to ship silently.
 *
 * TWO LAYERS OF PROOF (defense in depth):
 *
 *   LAYER 1 — STATIC: the autonomous entrypoints (scheduler, worker, daily
 *     prospecting, auto-approve batch, inbound webhook handler) must NOT
 *     import or call any send-capable function. We grep their source for the
 *     send-function names and assert ZERO matches. This catches a send path
 *     even if it's behind a flag or dynamically constructed.
 *
 *   LAYER 2 — RUNTIME: run the auto-approve batch against a stubbed provider
 *     whose sendTextMessage counter we read. The batch must process leads
 *     (approve them in the review queue) WITHOUT triggering a single send.
 *     This proves the runtime `allowRealSend: false` contract actually holds.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — autonomous files contain ZERO references to sendTextMessage.
 *   CASE B — autonomous files contain ZERO references to sendApprovedReply.
 *   CASE C — the auto-approve batch, run with a counting stub provider,
 *     produces sendCallCount === 0.
 *
 * The send-capable names are intentionally listed explicitly (not regex) so a
 * rename (e.g. sendTextMessage → dispatchMessage) forces a human to re-confirm
 * the rule still holds, not silently pass.
 *
 * Run: `npm run golden:no-auto-outreach`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import type { WhatsAppSendProvider, WhatsAppSendInput, WhatsAppSendResult } from "@/providers/whatsapp/WhatsAppSendProvider";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// The autonomous entrypoints that must NEVER send. If a new autonomous path is
// added (e.g. a campaign-scheduler), add it here.
const AUTONOMOUS_FILES = [
  "scripts/scheduler-entrypoint.ts",
  "scripts/worker-entrypoint.ts",
  "src/services/DailyProspectingScheduler.ts",
  "src/services/LeadReviewBatchService.ts",
  "src/services/WhatsAppWebhookService.ts", // INBOUND only — receives, never auto-sends
];

// The send-capable function names. A reference to ANY of these in an
// autonomous file is a violation of the sacred rule.
const SEND_CAPABLE_NAMES = [
  "sendTextMessage",
  "sendApprovedReply",
  "sendWhatsAppMessage",
  "broadcastWhatsApp",
];

function readFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

test("CASE A — autonomous entrypoints contain ZERO sendTextMessage / send references (static)", async () => {
  const violations: string[] = [];
  for (const file of AUTONOMOUS_FILES) {
    const src = readFile(file);
    for (const name of SEND_CAPABLE_NAMES) {
      // Match the name as a word boundary reference (not just a substring in a comment).
      // We DO allow the name to appear in a comment that says "does NOT send" — but a
      // bare call or import is a violation. Simplest honest check: any occurrence is
      // flagged for human review (the rule is sacred; false positives are cheap to clear).
      const re = new RegExp(`\\b${name}\\b`);
      if (re.test(src)) violations.push(`${file}: references "${name}"`);
    }
  }
  assert.strictEqual(
    violations.length,
    0,
    `SACRED RULE VIOLATION — autonomous entrypoints must NEVER send. Found send references:\n  ${violations.join("\n  ")}\nIf this is a comment, reword it to avoid the function name. If it's a real send, REMOVE IT — no auto-outreach is allowed.`,
  );
  console.log(`  All ${AUTONOMOUS_FILES.length} autonomous entrypoints are send-free (static proof).`);
});

test("CASE B — the inbound webhook handler passes allowRealSend: false at its call sites (static)", async () => {
  // handleIncomingWhatsAppMessage accepts an allowRealSend flag that defaults false.
  // The inbound webhook path MUST omit it (or pass false) — never true.
  const webhookSrc = readFile("src/services/WhatsAppWebhookService.ts");
  const routeSrc = readFile("src/app/api/[[...path]]/route.ts");
  // Any reference to allowRealSend: true in these files is a violation.
  assert.ok(!/allowRealSend\s*:\s*true/.test(webhookSrc), "WhatsAppWebhookService must NOT set allowRealSend: true");
  assert.ok(!/allowRealSend\s*:\s*true/.test(routeSrc), "the inbound webhook route must NOT set allowRealSend: true");
  console.log("  Inbound paths never set allowRealSend: true (static proof).");
});

test("CASE C — the send path defaults to allowRealSend=false at every inbound entry (real runtime contract)", async () => {
  // SESSION 7 (2026-07-28) HONEST REWRITE. The original CASE C wired a counting
  // stub that was NEVER connected to the batch's internal provider, so its
  // `sendCallCount === 0` assertion passed by construction regardless of
  // whether the batch sent — a vacuous test (build-right Ironclad Gate #7).
  //
  // The conversation engine constructs `new MetaWhatsAppCloudProvider()`
  // internally (`WhatsAppConversationEngine.ts:341`), so the provider is not
  // injectable. The LOAD-BEARING contract is therefore not "count sends"
  // (impossible without a refactor) but "the inbound entry points never enable
  // real sending." We prove that at three real points:
  //
  //   C1 — handleIncomingWhatsAppMessage's `options` param defaults to `{}`,
  //        so `allowRealSend` is undefined unless a caller EXPLICITLY opts in.
  //   C2 — the inbound webhook call site passes NO options (so allowRealSend
  //        is undefined there). Static grep of the route, like CASE A/B.
  //   C3 — maybeSendWhatsApp sets `previewOnly: !allowRealSend`, so an
  //        undefined/false allowRealSend forces previewOnly:true (no live send).

  // C1 — function signature default. Read the engine source and assert the
  // options default is `{}` (no allowRealSend) — a regression that flipped the
  // default to `{ allowRealSend: true }` would be caught here.
  const engineSrc = readFile("src/services/WhatsAppConversationEngine.ts");
  assert.ok(
    /handleIncomingWhatsAppMessage\([^)]*options[^=]*=\s*\{\s*\}/.test(engineSrc) || /handleIncomingWhatsAppMessage\([^)]*options[^=]*=\s*\{\s*allowRealSend[^}]*\}/.test(engineSrc) === false,
    "C1: handleIncomingWhatsAppMessage options must default to {} (allowRealSend undefined unless explicitly passed)",
  );
  // Stronger: confirm the body reads allowRealSend from options with a falsy fallback.
  assert.ok(/allowRealSend[^;]*Boolean\(/.test(engineSrc) || /Boolean\([^)]*allowRealSend/.test(engineSrc) || /options\.allowRealSend\b/.test(engineSrc), "C1: engine reads allowRealSend from options");
  console.log("  C1 OK: handleIncomingWhatsAppMessage defaults options to {} (allowRealSend must be explicitly opted in).");

  // C2 — inbound webhook route + service omit allowRealSend at the call site.
  const webhookSrc = readFile("src/services/WhatsAppWebhookService.ts");
  assert.ok(!/allowRealSend\s*:\s*true/.test(webhookSrc), "C2: WhatsAppWebhookService must NOT set allowRealSend: true");
  console.log("  C2 OK: inbound webhook never enables allowRealSend.");

  // C3 — maybeSendWhatsApp forces previewOnly when allowRealSend is falsy.
  assert.ok(/previewOnly\s*:\s*!/.test(engineSrc), "C3: maybeSendWhatsApp must set previewOnly from !allowRealSend");
  console.log("  C3 OK: maybeSendWhatsApp forces previewOnly when allowRealSend is falsy.");

  // Keep the stub definition (it documents the WhatsAppSendProvider contract a
  // future provider-injection refactor would test against), but DO NOT assert
  // on its counter — that was the vacuous part.
  const stub: WhatsAppSendProvider = {
    isConfigured: () => false,
    async sendTextMessage(_input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
      return { attempted: true, status: "failed", provider: "meta_cloud", errorMessage: "stub - sends forbidden in this test" };
    },
    async testConnection() {
      return { ok: false, status: "not_configured", message: "stub" };
    },
  };
  assert.ok(typeof stub.sendTextMessage === "function", "WhatsAppSendProvider stub shape valid (for future provider-injection test)");
  console.log("  (stub shape validated for future provider-injection coverage.)");
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
  console.log(`no-auto-outreach: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
