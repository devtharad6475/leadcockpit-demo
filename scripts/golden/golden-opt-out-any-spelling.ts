/**
 * golden-opt-out-any-spelling.ts — someone who said "stop" stays stopped
 * however their number is written (2026-09-24).
 *
 * WhatsApp reports a sender as "919825033333". Indian lists write the same
 * person as "+91 98250 33333" or "98250 33333". The do-not-contact register
 * compared spellings, so an opt-out taken on WhatsApp before the person was in
 * the CRM did not block them once they were imported from a list — at import
 * or at send.
 *
 *   CASE A — the rule: same subscriber across country code, "+", spaces and a
 *            trunk 0; different subscriber never; short numbers only exactly.
 *   CASE B — an opt-out stored in WhatsApp's spelling blocks SENDING to a lead
 *            saved in the list's spelling (the send-time gate).
 *   CASE C — and the reverse: an opt-out stored with "+91" blocks a lead saved
 *            without a country code.
 *   CASE D — the one legitimate way off the register (owner lifts it) removes
 *            it whichever spelling the owner's lead carries.
 *   CASE E — a different person with a near-identical number is NOT blocked.
 *
 * Run: npx tsx scripts/golden/golden-opt-out-any-spelling.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { samePhoneForOptOut } from "@/lib/phone-match";
import { isContactBlocked, registerDoNotContact, removeFromDncRegistry } from "@/lib/dnc-registry";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let n = 0;
const freshWs = () => `ws_optout_${Date.now()}_${(n += 1)}`;

test("CASE A — the matching rule", async () => {
  const same = [
    ["919825033333", "+91 98250 33333"],
    ["919825033333", "98250 33333"],
    ["+91-98250-33333", "09825033333"],
    ["12345", "+1 2345"],
  ];
  for (const [a, b] of same) assert.ok(samePhoneForOptOut(a, b), `${a} should be ${b}`);
  const different = [
    ["919825033333", "919825033334"],
    ["12345", "912345"],
    ["33333", "919825033333"],
    ["", "919825033333"],
  ];
  for (const [a, b] of different) assert.ok(!samePhoneForOptOut(a, b), `${a} must not be ${b}`);
});

test("CASE B — a WhatsApp opt-out blocks sending to the same person imported with +91", async () => {
  const ws = freshWs();
  await registerDoNotContact(ws, { phone: "919825033333", reason: "stop via WhatsApp" }, repos);
  const verdict = await isContactBlocked(ws, { whatsappNumber: "+91 98250 33333" }, repos);
  assert.strictEqual(verdict.blocked, true);
});

test("CASE C — an opt-out with +91 blocks a lead saved without a country code", async () => {
  const ws = freshWs();
  await registerDoNotContact(ws, { phone: "+91 98250 44444", reason: "asked to stop" }, repos);
  assert.strictEqual((await isContactBlocked(ws, { phone: "98250 44444" }, repos)).blocked, true);
});

test("CASE D — the owner lifting an opt-out works whichever spelling the lead carries", async () => {
  const ws = freshWs();
  await registerDoNotContact(ws, { phone: "919825055555", reason: "stop via WhatsApp" }, repos);
  const removed = await removeFromDncRegistry(ws, { whatsappNumber: "+91 98250 55555" }, repos);
  assert.strictEqual(removed, 1);
  assert.strictEqual((await isContactBlocked(ws, { whatsappNumber: "919825055555" }, repos)).blocked, false);
});

test("CASE E — a near-identical number belonging to someone else is not blocked", async () => {
  const ws = freshWs();
  await registerDoNotContact(ws, { phone: "919825066666", reason: "stop" }, repos);
  assert.strictEqual((await isContactBlocked(ws, { whatsappNumber: "+91 98250 66667" }, repos)).blocked, false);
});

(async () => {
  console.log("\n=== GOLDEN: an opt-out holds however the number is written ===\n");
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
    console.log("❌ GOLDEN FAILED: opt-out-any-spelling");
    process.exit(1);
  }
})();
