/**
 * golden-message-batching.ts — pins CP-23 (message batching / conversation window).
 *
 * WHAT THIS PROVES:
 *   The MessageBatcher collects multiple rapid-fire messages from the same
 *   phone number, waits for the quiet window to elapse, then merges them into
 *   ONE combined message and passes it to the processor. The processor receives
 *   the full context, not fragments.
 *
 * CONTRACTS (hand-computed BEFORE assertions):
 *   CASE 1 — 3 messages from the same number → 1 combined call to the processor.
 *     The merged text contains all 3 fragments, newline-separated, in order.
 *   CASE 2 — messages from DIFFERENT numbers → processed separately (2 buffers,
 *     2 calls). No cross-contamination.
 *   CASE 3 — deduplication: the same exact text sent twice → appears once in the
 *     merge (no duplicate fragments).
 *   CASE 4 — a short window (100ms for the test) flushes correctly: after the
 *     window elapses with no new message, the buffer is empty (pendingCount=0).
 *
 * Run: npx tsx scripts/golden/golden-message-batching.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { MessageBatcher } from "@/services/MessageBatcher";
import type { WhatsAppConversationInput } from "@/services/WhatsAppConversationEngine";
import type { RepositoryBundle } from "@/repositories/interfaces";
import assert from "node:assert";

/**
 * N-TEST-10 (2026-08-26, S29). Every `addMessage` call below used to pass
 * `{} as never` as its repository bundle — ten separate copies of it.
 *
 * An empty bundle is the RIGHT thing to pass here: `MessageBatcher` never calls
 * a repository. It stores the bundle on the buffer (MessageBatcher.ts:87) and
 * hands the same object back to the processor when the window closes
 * (MessageBatcher.ts:129). That is the whole of its involvement.
 *
 * But `as never` does not say "deliberate stub". It says "this value is
 * unreachable", which is untrue, and it is the same instrument used elsewhere
 * in this suite to hide fixtures that could never be stored. One named constant
 * says what is meant, in one place, and lets the identity of the stub be
 * asserted — see CASE 1, which now pins the forwarding contract that ten
 * anonymous `{}` literals made impossible to check.
 */
const NO_REPOS = {} as unknown as RepositoryBundle;

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- CASE 1: 3 messages from same number → 1 merged call ---
test("CASE 1 — 3 rapid messages from the same number merge into 1 processor call", async () => {
  const processed: WhatsAppConversationInput[] = [];
  const forwarded: unknown[] = [];
  const batcher = new MessageBatcher(
    async (input, repos) => { processed.push(input); forwarded.push(repos); },
    150, // 150ms window for fast testing
  );
  batcher.addMessage({ workspaceId: "ws1", phone: "+123", rawText: "Hi" }, NO_REPOS, false);
  batcher.addMessage({ workspaceId: "ws1", phone: "+123", rawText: "Price" }, NO_REPOS, false);
  batcher.addMessage({ workspaceId: "ws1", phone: "+123", rawText: "500 meters gold zari" }, NO_REPOS, false);
  assert.strictEqual(batcher.pendingCount(), 1, "1 buffer pending before window closes");
  // Wait for the window to flush.
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(processed.length, 1, "exactly 1 merged call after window");
  assert.strictEqual(batcher.pendingCount(), 0, "buffer cleared after flush");
  const merged = processed[0];
  assert.ok(merged.rawText.includes("Hi"), "merged text includes 'Hi'");
  assert.ok(merged.rawText.includes("Price"), "merged text includes 'Price'");
  assert.ok(merged.rawText.includes("500 meters gold zari"), "merged text includes the detail");
  assert.strictEqual(merged.metadata?.batchedMessageCount, 3, "metadata records 3 messages merged");
  // N-TEST-10 (2026-08-26, S29). The batcher's OTHER contract, previously
  // unpinned: it carries the caller's repository bundle through the quiet
  // window untouched and hands the SAME object to the processor. If it ever
  // substituted its own bundle, every message flushed after a batch would be
  // written through the wrong one — and nothing in this file would have said so.
  assert.strictEqual(forwarded.length, 1, "processor called once");
  assert.strictEqual(forwarded[0], NO_REPOS, "the processor receives the SAME bundle addMessage was given");
});

// --- CASE 2: different numbers → separate processing ---
test("CASE 2 — messages from different numbers are processed separately", async () => {
  const processed: WhatsAppConversationInput[] = [];
  const batcher = new MessageBatcher(async (input) => { processed.push(input); }, 150);
  batcher.addMessage({ workspaceId: "ws1", phone: "+111", rawText: "Hello from A" }, NO_REPOS, false);
  batcher.addMessage({ workspaceId: "ws1", phone: "+222", rawText: "Hello from B" }, NO_REPOS, false);
  assert.strictEqual(batcher.pendingCount(), 2, "2 separate buffers");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(processed.length, 2, "2 separate processor calls");
  const texts = processed.map((p) => p.rawText);
  assert.ok(texts.some((t) => t.includes("Hello from A")), "A's message processed");
  assert.ok(texts.some((t) => t.includes("Hello from B")), "B's message processed");
});

// --- CASE 3: duplicate text deduplication ---
test("CASE 3 — exact-duplicate texts are deduplicated in the merge", async () => {
  const processed: WhatsAppConversationInput[] = [];
  const batcher = new MessageBatcher(async (input) => { processed.push(input); }, 150);
  batcher.addMessage({ workspaceId: "ws1", phone: "+333", rawText: "Price" }, NO_REPOS, false);
  batcher.addMessage({ workspaceId: "ws1", phone: "+333", rawText: "Price" }, NO_REPOS, false); // duplicate
  batcher.addMessage({ workspaceId: "ws1", phone: "+333", rawText: "500m" }, NO_REPOS, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(processed.length, 1, "1 merged call");
  // "Price" should appear ONCE (deduped), "500m" once.
  const priceMatches = processed[0].rawText.match(/Price/gi);
  assert.ok(priceMatches && priceMatches.length === 1, "duplicate 'Price' appears only once");
  assert.ok(processed[0].rawText.includes("500m"), "500m included");
  assert.strictEqual(processed[0].metadata?.batchedMessageCount, 2, "2 unique messages (not 3)");
});

// --- CASE 4: buffer empties after flush ---
test("CASE 4 — after the window flushes, the buffer is empty for new messages", async () => {
  const processed: WhatsAppConversationInput[] = [];
  const batcher = new MessageBatcher(async (input) => { processed.push(input); }, 150);
  batcher.addMessage({ workspaceId: "ws1", phone: "+444", rawText: "First batch" }, NO_REPOS, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(processed.length, 1, "first batch processed");
  assert.strictEqual(batcher.pendingCount(), 0, "buffer empty after flush");
  // A new message after the flush starts a fresh buffer.
  batcher.addMessage({ workspaceId: "ws1", phone: "+444", rawText: "Second batch" }, NO_REPOS, false);
  assert.strictEqual(batcher.pendingCount(), 1, "new buffer created for the second message");
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(processed.length, 2, "second batch processed separately");
});

// ─── Runner ────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const c of cases) {
    try { await c.fn(); passed++; console.log(`  ✅ ${c.name}`); }
    catch (err) { failed++; console.error(`  ❌ ${c.name}`); console.error(`     ${(err as Error).message}`); }
  }
  console.log(`\nmessage-batching: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAILED ❌"}`);
  if (failed > 0) { console.error("❌ golden-message-batching FAILED."); process.exit(1); }
  console.log("✅ golden-message-batching ALL GREEN ✅");
  process.exit(0);
})();
