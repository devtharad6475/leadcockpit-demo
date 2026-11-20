/**
 * golden-webhook-replay-dedup.ts — inbound webhook message-id dedup (NEW, S6 I-3).
 *
 * WHY THIS TEST EXISTS:
 *   Audit S6 I-3: Meta's WhatsApp Cloud webhook contract EXPLICITLY says
 *   "expect duplicate deliveries; dedup on message.id." The system processed
 *   every delivery unconditionally → duplicate replies, tickets, and (worst)
 *   duplicate DNC registrations (a customer who re-consented could be silently
 *   re-blocked by a stale replay). AUDIT-EXCLUSIONS.md's claim that idempotency
 *   guards existed was FALSE. This golden pins the dedup contract.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — first delivery PROCESSES (creates the lead/reply/draft side-effects).
 *     A fresh message.id is processed exactly once: processedMessages has 1
 *     entry with status "processed", and a Reply + AutoReplyLog are created.
 *
 *   CASE B — second delivery of the SAME message.id is SKIPPED (the dedup).
 *     Re-delivering the identical payload produces a processedMessages entry
 *     with status "ignored" + reason mentioning "Duplicate". NO new Reply,
 *     NO new AutoReplyLog, NO new lead. The dedup log has exactly 1 row for
 *     that message.id.
 *
 *   CASE C — a replay after a DNC removal does NOT re-register DNC.
 *     This is the load-bearing compliance case. Seed: a message.id that was
 *     already processed is replayed AFTER the owner removed the contact from
 *     DNC. The replay must be skipped at the dedup gate — it must NEVER reach
 *     the DNC logic, so it cannot re-block the customer.
 *
 *   CASE D — the dedup is keyed on (workspaceId, message.id): the same id in a
 *     DIFFERENT workspace is NOT treated as a duplicate (multi-tenant hygiene).
 *
 * REAL PIPELINE: imports the REAL processWhatsAppCloudWebhook + REAL repos.
 * Each case uses a unique timestamped workspace. The Mock LLM is the default
 * fallback so no real AI call is made.
 *
 * Run: `npm run golden:webhook-replay-dedup`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { processWhatsAppCloudWebhook } from "@/services/WhatsAppWebhookService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";
import type { JsonRecord } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_whdedup_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/** Build a realistic Meta WhatsApp Cloud webhook payload for one text message. */
function webhookPayload(opts: { messageId: string; from: string; body: string; contactName?: string }): JsonRecord {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "test_phone_id" },
          contacts: [{ wa_id: opts.from, profile: { name: opts.contactName || "Test Customer" } }],
          messages: [{
            from: opts.from,
            id: opts.messageId,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body: opts.body },
          }],
        },
      }],
    }],
  };
}

async function countReplies(repos: RepositoryBundle, ws: string): Promise<number> {
  const data = await repos.readAll!();
  return ((data.replies as unknown[] | undefined) || []).filter((r) => (r as { workspaceId?: string }).workspaceId === ws).length;
}
async function countAutoReplyLogs(repos: RepositoryBundle, ws: string): Promise<number> {
  const data = await repos.readAll!();
  return ((data.autoReplyLogs as unknown[] | undefined) || []).filter((r) => (r as { workspaceId?: string }).workspaceId === ws).length;
}
async function countDedupRows(repos: RepositoryBundle, ws: string, messageId: string): Promise<number> {
  const data = await repos.readAll!();
  return ((data.processedWebhookMessageIds as unknown[] | undefined) || [])
    .filter((m) => (m as { workspaceId?: string; providerMessageId?: string }).workspaceId === ws
      && (m as { providerMessageId?: string }).providerMessageId === messageId).length;
}

test("CASE A — first delivery PROCESSES (creates reply + draft side-effects)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  const msgId = `wamid.HBgM${Date.now()}_A`;
  const result = await processWhatsAppCloudWebhook(WS, webhookPayload({ messageId: msgId, from: "+919999988881", body: "Hi, do you sell zari thread?" }), repos);
  // Exactly 1 message processed, status "processed".
  assert.strictEqual(result.processedMessages.length, 1, "one message in the result");
  assert.strictEqual(result.processedMessages[0].status, "processed", "first delivery status = processed");
  // Side effects created.
  const replies = await countReplies(repos, WS);
  const drafts = await countAutoReplyLogs(repos, WS);
  assert.ok(replies >= 1, `first delivery creates ≥1 reply, got ${replies}`);
  assert.ok(drafts >= 1, `first delivery creates ≥1 auto-reply draft, got ${drafts}`);
  // The dedup log has exactly 1 row for this message.id.
  const dedupRows = await countDedupRows(repos, WS, msgId);
  assert.strictEqual(dedupRows, 1, "dedup log has exactly 1 row for the processed message.id");
});

test("CASE B — second delivery of the SAME message.id is SKIPPED (no new side-effects)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const msgId = `wamid.HBgM${Date.now()}_B`;
  const payload = webhookPayload({ messageId: msgId, from: "+919999988882", body: "Hello, prices please" });

  // First delivery.
  await processWhatsAppCloudWebhook(WS, payload, repos);
  const repliesAfter1 = await countReplies(repos, WS);
  const draftsAfter1 = await countAutoReplyLogs(repos, WS);

  // Second delivery of the IDENTICAL payload (what Meta does on retry).
  const result2 = await processWhatsAppCloudWebhook(WS, payload, repos);
  const repliesAfter2 = await countReplies(repos, WS);
  const draftsAfter2 = await countAutoReplyLogs(repos, WS);

  // THE load-bearing dedup assertion: no new side-effects.
  assert.strictEqual(result2.processedMessages[0].status, "ignored", "second delivery status = ignored");
  assert.ok(/duplicate/i.test(result2.processedMessages[0].reason || ""), `reason mentions "duplicate", got "${result2.processedMessages[0].reason}"`);
  assert.strictEqual(repliesAfter2, repliesAfter1, "NO new reply created on replay");
  assert.strictEqual(draftsAfter2, draftsAfter1, "NO new draft created on replay");
  // Dedup log still has exactly 1 row (the second delivery did not insert another).
  const dedupRows = await countDedupRows(repos, WS, msgId);
  assert.strictEqual(dedupRows, 1, "dedup log still has exactly 1 row (replay did not duplicate the row)");
});

test("CASE C — a replay AFTER a DNC removal does NOT re-register DNC (compliance critical)", async () => {
  // This is the worst-case the dedup prevents: a customer texts "stop", gets
  // DNC-registered, the owner removes the DNC, then a STALE replay of the
  // original "stop" message arrives. Without dedup, the replay would re-run
  // DNC handling and silently re-block the customer. With dedup, the replay
  // is skipped at the gate — it never reaches DNC logic.
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const msgId = `wamid.HBgM${Date.now()}_C`;
  const from = "+919999988883";
  const stopPayload = webhookPayload({ messageId: msgId, from, body: "stop sending me messages" });

  // First delivery: processes the "stop" (may or may not trigger DNC depending
  // on the engine's stop-handling, but either way the message.id is recorded).
  await processWhatsAppCloudWebhook(WS, stopPayload, repos);
  const dedupAfter1 = await countDedupRows(repos, WS, msgId);
  assert.strictEqual(dedupAfter1, 1, "first 'stop' delivery recorded in dedup log");

  // Simulate the owner removing any DNC entry for this contact.
  // (We don't need to seed DNC to prove the point — the dedup must skip the
  // replay BEFORE the engine runs, so DNC handling is never reached at all.)
  const dataBeforeReplay = await repos.readAll!();
  const dncBefore = (dataBeforeReplay.doNotContactRegistry || []).length;

  // Replay the IDENTICAL "stop" message.
  const replayResult = await processWhatsAppCloudWebhook(WS, stopPayload, repos);
  assert.strictEqual(replayResult.processedMessages[0].status, "ignored", "replay status = ignored (dedup gate)");
  assert.ok(/duplicate/i.test(replayResult.processedMessages[0].reason || ""), "replay reason mentions duplicate");

  // The DNC registry must NOT have grown from the replay (the replay never
  // reached DNC logic because the dedup gate skipped it).
  const dataAfterReplay = await repos.readAll!();
  const dncAfter = (dataAfterReplay.doNotContactRegistry || []).length;
  assert.strictEqual(dncAfter, dncBefore, "DNC registry did NOT grow from the replay (dedup blocked re-registration)");
  // And no new reply.
  const repliesAfter1 = ((dataBeforeReplay.replies as unknown[] | undefined) || []).filter((r) => (r as { workspaceId?: string }).workspaceId === WS).length;
  const repliesAfter2 = ((dataAfterReplay.replies as unknown[] | undefined) || []).filter((r) => (r as { workspaceId?: string }).workspaceId === WS).length;
  assert.strictEqual(repliesAfter2, repliesAfter1, "no new reply from the replay");
});

test("CASE D — dedup is keyed on (workspaceId, message.id): same id in a DIFFERENT workspace is NOT a duplicate", async () => {
  // Multi-tenant hygiene: two workspaces that somehow receive the same Meta
  // message.id (shouldn't happen, but defensively) must each be allowed to
  // process it once. The dedup must NOT cross tenant boundaries.
  const repos = createJsonRepos();
  const WS1 = caseWorkspace("D1");
  const WS2 = caseWorkspace("D2");
  const sharedMsgId = `wamid.HBgM${Date.now()}_D_shared`;
  const payload = webhookPayload({ messageId: sharedMsgId, from: "+919999988884", body: "shared id test" });

  // WS1 processes first.
  const r1 = await processWhatsAppCloudWebhook(WS1, payload, repos);
  assert.strictEqual(r1.processedMessages[0].status, "processed", "WS1 processes the shared id");
  // WS2 must ALSO be allowed to process it (different workspace).
  const r2 = await processWhatsAppCloudWebhook(WS2, payload, repos);
  assert.strictEqual(r2.processedMessages[0].status, "processed", "WS2 also processes the same id (no cross-tenant dedup)");
  // Each workspace's dedup log has 1 row.
  assert.strictEqual(await countDedupRows(repos, WS1, sharedMsgId), 1, "WS1 dedup row count = 1");
  assert.strictEqual(await countDedupRows(repos, WS2, sharedMsgId), 1, "WS2 dedup row count = 1");
});

test("CASE E — five copies of one message arriving AT ONCE: exactly one is processed", async () => {
  // 2026-09-26 break test: every copy passed the "seen before?" check before
  // any of them recorded the id, so all five ran the full pipeline — five
  // reply drafts, five AI calls. Recording is now also the claim.
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  const msgId = `wamid.HBgM${Date.now()}_E`;
  const payload = webhookPayload({ messageId: msgId, from: "+919999988885", body: "Do you have gold zari in stock?" });
  const results = await Promise.all(Array.from({ length: 5 }, () => processWhatsAppCloudWebhook(WS, payload, repos)));
  const statuses = results.map((r) => r.processedMessages[0]?.status);
  assert.strictEqual(statuses.filter((s) => s === "processed").length, 1, `copies processed: ${statuses.join(", ")}`);
  assert.strictEqual(await countAutoReplyLogs(repos, WS), 1, "one reply draft, not one per copy");
  assert.strictEqual(await countDedupRows(repos, WS, msgId), 1);
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
  console.log(`webhook-replay-dedup: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
