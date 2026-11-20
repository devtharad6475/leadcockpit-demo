/**
 * golden-edits-cannot-forge-or-wipe.ts — what the 2026-09-26 break test found
 * in the API's edit routes, pinned so it cannot come back.
 *
 *   A — an edit never changes a record's id, workspace or creation time
 *       (a request carrying "id" rewrote the record's id in the database).
 *   B — approval-type fields cannot be set by a plain edit; they have their
 *       own actions, which check and audit.
 *   C — editing a Knowledge Base answer cannot forge where it came from
 *       ("the owner said this", reviewer, review date) and rejects non-text.
 *   D — a settings save with a wrong-shaped product list is refused instead of
 *       replacing the owner's products with an empty list.
 *   E — saving the buyer checklist with no list is refused instead of saving
 *       an empty one (which deleted every line the owner wrote).
 *   F — five "convert to order" clicks at once: exactly one wins.
 *   G — a cancelled order cannot be cancelled again.
 *   H — approving an approved lead again keeps its stage (it fell back to "approved").
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-edits-cannot-forge-or-wipe.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { sanitizeStrictShape, GOVERNED_FIELDS, knowledgeAnswerEditSchema, productSettingsSaveSchema, salesSettingsSaveSchema } from "@/validation/schemas";
import { saveDiscoveryChecklist, getDiscoveryChecklist } from "@/services/DiscoveryService";
import { NeedsActionError } from "@/lib/user-errors";

const repos = createJsonRepos() as RepositoryBundle;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

test("A — an edit cannot change which record it is, whose, or when it was made", async () => {
  const cleaned = sanitizeStrictShape({ id: "forged", workspaceId: "someone_else", createdAt: "1999-01-01", updatedAt: "x", name: "ok", __proto__: { polluted: true } } as Record<string, unknown>);
  assert.deepEqual(Object.keys(cleaned), ["name"]);
});

test("B — approval fields are only changed by their own actions", async () => {
  const campaign = sanitizeStrictShape({ name: "Surat push", approvalStatus: "approved" }, [...GOVERNED_FIELDS.campaign]);
  assert.equal("approvalStatus" in campaign, false, "a campaign was approved through a plain edit");
  const message = sanitizeStrictShape({ body: "hi", status: "approved" }, [...GOVERNED_FIELDS.messageTemplate]);
  assert.equal("status" in message, false, "a message was approved through a plain edit");
  const profile = sanitizeStrictShape({ companyName: "X", status: "approved", checklistKinds: ["pirate"], checklistConfirmedAt: "now" }, [...GOVERNED_FIELDS.businessProfile]);
  assert.deepEqual(Object.keys(profile), ["companyName"], "profile approval or the checklist choice came in through a plain edit");
});

test("C — an answer edit cannot forge its source or reviewer, and refuses non-text", async () => {
  const parsed = knowledgeAnswerEditSchema.safeParse({ answer: "MOQ is 5 kg", sourceType: "user_answer", reviewedByUser: "user_owner", reviewedAt: "2020-01-01", confidenceScore: 1 });
  assert.ok(parsed.success);
  assert.deepEqual(Object.keys(parsed.data!), ["answer"], "provenance fields passed through");
  assert.equal(knowledgeAnswerEditSchema.safeParse({ answer: 5 }).success, false, "a number was accepted as an answer");
  assert.equal(knowledgeAnswerEditSchema.safeParse({ answer: "x".repeat(8001) }).success, false, "an answer over 8,000 characters was accepted");
  assert.equal(knowledgeAnswerEditSchema.safeParse({ answerStatus: "approved_by_god" }).success, false);
});

test("D — a wrong-shaped product list is refused, not saved as empty", async () => {
  assert.equal(productSettingsSaveSchema.safeParse({ products: "manufacturer" }).success, false);
  assert.equal(productSettingsSaveSchema.safeParse({ products: [{ name: 5 }] }).success, false);
  const ok = productSettingsSaveSchema.safeParse({ products: [{ id: "p1", name: "Zari thread", price: 250, junk: "x" }], id: "forged", workspaceId: 7 });
  assert.ok(ok.success);
  assert.deepEqual(Object.keys(ok.data!), ["products"]);
  assert.equal("junk" in ok.data!.products![0], false, "unknown product fields were stored");
  assert.equal(salesSettingsSaveSchema.safeParse({ defaultMOQ: ["x"] }).success, false);
});

test("E — the buyer checklist is not wiped by a save with no list", async () => {
  const workspaceId = `ws_wipe_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: "Wipe test", status: "active" } as never);
  await saveDiscoveryChecklist(workspaceId, { spine: [{ key: "city", label: "Which city are you in?" }], segments: {} }, repos);
  const before = (await getDiscoveryChecklist(workspaceId, repos)).spine.length;
  assert.ok(before >= 1, "the fixture checklist did not save");
  for (const bad of [{}, { spine: "all" }, { spine: [], segments: [] }]) {
    await assert.rejects(() => saveDiscoveryChecklist(workspaceId, bad as never, repos), NeedsActionError, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal((await getDiscoveryChecklist(workspaceId, repos)).spine.length, before, "the checklist was wiped");
  // An empty list sent AS a list is still the owner's choice.
  await saveDiscoveryChecklist(workspaceId, { spine: [], segments: {} }, repos);
  assert.equal((await getDiscoveryChecklist(workspaceId, repos)).spine.length, 0);
});

test("F — five conversions at once: exactly one wins", async () => {
  const workspaceId = `ws_race_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: "Race", status: "active" } as never);
  const lead = await repos.lead.createLead({ workspaceId, companyName: "Race Co" });
  const quote = await repos.quote.create({ workspaceId, leadId: lead.id, status: "accepted", lineItems: [{ productName: "x", quantity: 1, unitPrice: 1, lineTotal: 1 } as never], grandTotal: 1, currencyCode: "INR" });
  const wins = await Promise.all(Array.from({ length: 5 }, () => repos.quote.claimForConversion(workspaceId, quote.id, ["sent", "accepted"])));
  assert.equal(wins.filter(Boolean).length, 1, `${wins.filter(Boolean).length} requests won the claim`);
  assert.equal((await repos.quote.getById(workspaceId, quote.id))?.status, "converted");
  assert.equal(await repos.quote.claimForConversion(workspaceId, quote.id, ["sent", "accepted"]), false, "a converted quote was claimed again");
});

test("G — a cancelled order cannot be cancelled again (it would rewrite who cancelled it and why)", async () => {
  const { cancelOrder } = await import("@/services/OrderService");
  const order = { id: "o1", orderNumber: "ORD-1", status: "cancelled", lineItems: [{ id: "l1", quantity: 2, unitPrice: 10 }], grandTotal: 20, cancelledBy: "owner", cancelReason: "customer asked" } as never;
  await assert.rejects(() => cancelOrder(order, { actor: "someone_else", reason: "rewritten" }), NeedsActionError);
  const delivered = { id: "o2", status: "delivered", lineItems: [], grandTotal: 0 } as never;
  await assert.rejects(() => cancelOrder(delivered, { actor: "owner" }), NeedsActionError, "a delivered-order refusal reached the owner as a server fault");
});

test("H — approving an approved lead again does not send it back to the start", async () => {
  const { approveLead, rejectLead } = await import("@/services/LeadReviewDecisionService");
  const workspaceId = `ws_reapprove_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: "Re-approve", status: "active" } as never);
  const lead = await repos.lead.createLead({ workspaceId, companyName: "Already talking Co" });
  await approveLead(workspaceId, lead.id, repos, "owner");
  await repos.lead.updateLead(workspaceId, lead.id, { status: "contacted" });
  const again = await approveLead(workspaceId, lead.id, repos, "owner");
  assert.equal(again.status, "contacted", "a contacted lead fell back to \"approved\" on a second approve");
  assert.equal((await repos.lead.getLeadById(workspaceId, lead.id))?.status, "contacted");
  await rejectLead(workspaceId, lead.id, repos, { reason: "not a fit" }, "owner");
  assert.equal((await rejectLead(workspaceId, lead.id, repos, undefined, "owner")).status, "rejected");
});

(async () => {
  console.log("golden-edits-cannot-forge-or-wipe — edits cannot forge identity, approval or provenance, or wipe data\n");
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
  }
  console.log(`\nedits-cannot-forge-or-wipe: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
  if (failed) process.exit(1);
})();
