/**
 * Golden — leftovers from the 2026-09-27 review (2026-09-28).
 * Rules: docs/LOGIC.md 2026-09-28 REVIEW-LEFTOVERS.
 *
 *   W11  A first message that is a photo or voice note opens WhatsApp's
 *        24-hour reply window (lastInboundAt is stamped like the text path).
 *   DNC  The register matches numbers on their last 10 digits however they are
 *        written, checks BOTH of a lead's numbers, and holds a website host so
 *        a website-only company can be put on it (L10) — and then cannot be
 *        added again by hand; remove-dnc takes the website entry off too.
 *   KILL The operator's WhatsApp switch says "Sending is paused by the
 *        platform" as a NeedsActionError (shown as written), for text AND
 *        template sends — the template path used to RETURN "blocked", which
 *        the approve path records as an approved draft.
 *   L10  One stored name per lead stage: closed_won → won, closed_lost →
 *        lost, prospected → discovered, on create and update; a filter on
 *        either name finds rows written with the other.
 *   RUN  "Search is not connected" is a setup notice: still in the run's
 *        errors (so the morning summary shows it), but the scheduler's exit
 *        code is 0 unless something else failed.
 *
 * Run: npx tsx scripts/golden/golden-review-leftovers.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { readSource } from "./_helpers/read-source";
import { processInboundMediaMessage } from "@/services/InboundMediaService";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import { registerDoNotContact, isContactBlocked, removeFromDncRegistry } from "@/lib/dnc-registry";
import { createManualLead, putLeadOnDoNotContact } from "@/services/LeadImportService";
import { NeedsActionError } from "@/lib/user-errors";
import { repositories } from "@/repositories";
import { schedulerExitCode, splitRunProblems } from "@/lib/daily-run-outcome";

const cases: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);
const repos = createJsonRepos();
const RUN = Date.now();
let n = 0;
async function workspace(tag: string) {
  const id = `ws_left_${tag}_${RUN}_${n++}`;
  await ensureWorkspace(repos, id);
  return id;
}
const media = { downloadMedia: async () => Buffer.from("bytes"), describeImage: async () => ({ description: "a border", confidence: 0.9 }), transcribe: async () => "need 50 metres", sendOutbound: async () => { throw new Error("must not send"); } };

test("W11 — a first photo from an existing lead opens the 24-hour window", async () => {
  const ws = await workspace("photo");
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: "Photo Co", whatsappNumber: "919811100001", source: "whatsapp", reviewStatus: "approved" });
  assert.equal(isWithin24hWindow(lead.lastInboundAt).open, false, "setup: window should start closed");
  const result = await processInboundMediaMessage({ workspaceId: ws, message: { from: "919811100001", id: `wamid.${RUN}.p`, type: "image", image: { id: "img1", mime_type: "image/jpeg" } } }, repos, media);
  assert.equal(result.status, "processed");
  const after = await repos.lead.getLeadById(ws, lead.id);
  assert.ok(after?.lastInboundAt, "a photo did not stamp lastInboundAt");
  assert.equal(isWithin24hWindow(after?.lastInboundAt).open, true);
});

test("W11 — a voice note from a new number creates the lead with the window open", async () => {
  const ws = await workspace("voice");
  await processInboundMediaMessage({ workspaceId: ws, message: { from: "919811100002", id: `wamid.${RUN}.v`, type: "audio", audio: { id: "aud1", mime_type: "audio/ogg", voice: true } } }, repos, media);
  const lead = await repos.lead.findLeadByPhone(ws, "919811100002");
  assert.ok(lead, "no lead for the new sender");
  assert.equal(isWithin24hWindow(lead?.lastInboundAt).open, true, "a first voice note left the window closed");
});

test("DNC — numbers match on the last 10 digits; both of a lead's numbers are checked", async () => {
  const ws = await workspace("dnc_phone");
  await registerDoNotContact(ws, { phone: "+91 98250 44444", reason: "said stop" }, repos);
  assert.equal((await isContactBlocked(ws, { phone: "09825044444" }, repos)).blocked, true);
  assert.equal((await isContactBlocked(ws, { whatsappNumber: "919825044444" }, repos)).blocked, true);
  // The WhatsApp number is fine; the office phone is the opted-out one.
  assert.equal((await isContactBlocked(ws, { whatsappNumber: "919800000099", phone: "98250-44444" }, repos)).blocked, true, "only the WhatsApp number was checked");
  assert.equal((await isContactBlocked(ws, { phone: "9825044445" }, repos)).blocked, false);
});

test("DNC — a website-only company can go on the register, and stays off the lead list", async () => {
  const ws = await workspace("dnc_site");
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: "Site Only Textiles", websiteUrl: "https://www.SiteOnly-Textiles.in/about" });
  const { registered, lead: marked } = await putLeadOnDoNotContact(ws, lead.id, "asked us to stop", repos, "owner_1");
  assert.equal(registered, 1, "a website-only lead put nothing on the register");
  assert.equal(marked.doNotContact, true);
  assert.equal(marked.status, "do_not_contact");
  const entries = await repos.doNotContact.listByWorkspace(ws);
  assert.equal(entries[0]?.normalizedDomain, "siteonly-textiles.in");
  await assert.rejects(
    createManualLead(ws, { companyName: "Another name", websiteUrl: "siteonly-textiles.in/contact" }, repos),
    (e: unknown) => e instanceof NeedsActionError && /do-not-contact/.test(e.message),
  );
  assert.equal((await isContactBlocked(ws, { websiteUrl: "http://siteonly-textiles.in" }, repos)).blocked, true);
  const audit = (await repos.auditLog.listByWorkspace(ws)).find((a) => a.eventType === "dnc_added");
  assert.ok(audit, "putting a lead on the register was not audited");
  assert.equal(await removeFromDncRegistry(ws, { websiteUrl: "www.siteonly-textiles.in" }, repos), 1);
  await assert.rejects(putLeadOnDoNotContact(ws, lead.id, " ", repos), NeedsActionError);
});

test("KILL — a paused platform says so plainly, for text and template sends", async () => {
  const { MetaWhatsAppCloudProvider, WHATSAPP_PAUSED_MESSAGE } = await import("@/providers/whatsapp/MetaWhatsAppCloudProvider");
  assert.match(WHATSAPP_PAUSED_MESSAGE, /^Sending is paused by the platform/);
  await repositories.featureFlag.upsert({ key: "whatsapp_send_enabled", enabled: false, lastToggledByAdminId: "golden" });
  try {
    const provider = new MetaWhatsAppCloudProvider();
    await assert.rejects(
      provider.sendTextMessage({ workspaceId: "ws", to: "919800000001", body: "hi" }),
      (e: unknown) => e instanceof NeedsActionError && e.message === WHATSAPP_PAUSED_MESSAGE,
    );
    await assert.rejects(
      provider.sendTemplateMessage({ workspaceId: "ws", to: "919800000001", templateName: "t", language: "en_US" }),
      (e: unknown) => e instanceof NeedsActionError && e.message === WHATSAPP_PAUSED_MESSAGE,
      "the template path still returns instead of refusing",
    );
  } finally {
    await repositories.featureFlag.upsert({ key: "whatsapp_send_enabled", enabled: true, lastToggledByAdminId: "golden" });
  }
  // The API shows a NeedsActionError's message as written.
  const route = readSource("src/app/api/[[...path]]/route.ts");
  assert.ok(/if \(error instanceof NeedsActionError\)/.test(route));
});

test("L10 — one stored name per stage; filters find both names", async () => {
  const ws = await workspace("status");
  const a = await repos.lead.createLead({ workspaceId: ws, companyName: "A", status: "closed_won" });
  assert.equal(a.status, "won");
  const b = await repos.lead.createLead({ workspaceId: ws, companyName: "B", status: "prospected" });
  assert.equal(b.status, "discovered");
  assert.equal((await repos.lead.updateLeadStatus(ws, b.id, "closed_lost")).status, "lost");
  // A row written before the change, with the other name.
  await repos.mutateAll!((data) => { data.leads.push({ ...a, id: `lead_old_${RUN}`, status: "closed_won" }); });
  const wonByShort = (await repos.lead.listLeads(ws, { status: "won" })).map((l) => l.id).sort();
  const wonByLong = (await repos.lead.listLeads(ws, { status: "closed_won" })).map((l) => l.id).sort();
  assert.deepEqual(wonByShort, [a.id, `lead_old_${RUN}`].sort());
  assert.deepEqual(wonByLong, wonByShort);
});

test("L10 — a lead score cannot be typed by hand", async () => {
  const { leadUpdateSchema } = await import("@/validation/schemas");
  assert.equal(leadUpdateSchema.safeParse({ leadScore: 72 }).success, false);
  assert.equal(leadUpdateSchema.safeParse({ fitScore: 60 }).success, false);
  assert.equal(leadUpdateSchema.safeParse({ companyName: "fine" }).success, true);
});

test("RUN — 'search is not connected' is loud but not a failed run", () => {
  const notice = "Search is not connected — no new buyers found today.";
  assert.deepEqual(splitRunProblems([notice, "AI scoring failed: x"]), { failures: ["AI scoring failed: x"], setupNotices: [notice] });
  assert.equal(schedulerExitCode([{ errors: [notice] }]), 0);
  assert.equal(schedulerExitCode([{ errors: [notice] }, { errors: ["Auto-approve failed: y"] }]), 1);
  assert.equal(schedulerExitCode([{ skipped: "suspended", errors: ["x"] }]), 0);
  const entry = readSource("scripts/scheduler-entrypoint.ts");
  assert.ok(/schedulerExitCode\(reports\)/.test(entry), "the scheduler does not use schedulerExitCode");
  assert.ok(!/if \(totalErrors > 0\) process\.exit\(1\)/.test(entry), "the scheduler still fails on any error");
  assert.ok(/NEEDS SETUP/.test(entry), "the notice is not printed loudly");
  const scheduler = readSource("src/services/DailyProspectingScheduler.ts");
  assert.ok(/summary\.errors\.push\(message\)/.test(scheduler), "the notice no longer reaches the morning summary");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`); }
    catch (error) { failed += 1; console.log(`  FAIL ${name}\n       ${(error as Error).message.split("\n")[0]}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
