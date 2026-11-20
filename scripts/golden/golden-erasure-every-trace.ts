/**
 * Golden — erasing a customer leaves nothing that names them (2026-09-28, S5).
 * Rules: docs/LOGIC.md 2026-09-28 ERASURE-EVERY-TRACE (extends Q18).
 *
 *   CASE A — CENSUS. Every Postgres model with a lead id or a phone field is
 *     listed below with how erasure handles it. A new model with such a field
 *     and no decision FAILS this golden — the way erasure used to miss review
 *     notes, drafts and the webhook-log phone. "fk-cascade" claims are checked
 *     against the schema (the relation must really say onDelete: Cascade);
 *     "repository" claims are checked against eraseLeadViaRepositories and
 *     the JSON cascade (the named call / collection must really be there).
 *
 *   CASE B — the JSON cascade (eraseLeadCascade). A customer is seeded into
 *     every collection that can hold them — replies, outreach, ticket + event,
 *     order, quote, auto-reply log, open question, photo, chat line + fallback
 *     task, extra number, review note, drafted message, reminder, an agent run
 *     that quotes their number with spaces in it, the webhook log, the owner
 *     assistant's pointer. After erasure the whole store (except the
 *     do-not-contact register and the audit trail, both kept by rule) must not
 *     contain their id, number, email or company name. A second customer in
 *     the same company must be untouched.
 *
 *   CASE C — the repository path (eraseLeadViaRepositories, what Postgres
 *     runs), driven over the JSON repositories with the same seed and the same
 *     check. It also proves ticket events are removed by TICKET id (the route
 *     used to hand event ids to a delete that takes ticket ids).
 *
 * Run: npx tsx scripts/golden/golden-erasure-every-trace.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { readSource } from "./_helpers/read-source";
import { eraseLeadCascade, eraseLeadViaRepositories } from "@/services/ErasureCascade";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { readData, mutateData } from "@/lib/db";
import type { AppData } from "@/lib/types";

const cases: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push([name, fn]);
const repos = createJsonRepos();
const RUN = Date.now();

/**
 * How erasure treats each model with a lead or phone field.
 *   fk-cascade   — removed by Postgres when the lead row is deleted (checked).
 *   repository   — removed / scrubbed explicitly; `call` must appear in
 *                  eraseLeadViaRepositories and `json` in the JSON cascade.
 *   kept         — deliberately kept, with the reason.
 */
type Decision =
  | { how: "fk-cascade" }
  | { how: "repository"; call: string; json: string }
  | { how: "kept"; why: string };
const CENSUS: Record<string, Decision> = {
  Lead: { how: "repository", call: "repos.lead.deleteById", json: "d.leads = " },
  LeadPhoneNumber: { how: "fk-cascade" },
  Interaction: { how: "fk-cascade" },
  LeadEnrichmentRun: { how: "fk-cascade" },
  DuplicateCandidate: { how: "fk-cascade" },
  MessageTemplate: { how: "repository", call: "repos.messageTemplate.deleteByLead", json: "d.messageTemplates = " },
  OutreachActivity: { how: "repository", call: "repos.outreachActivity.deleteByLead", json: "d.outreachActivities = " },
  Reply: { how: "repository", call: "repos.reply.deleteByLead", json: "d.replies = " },
  ProcessedWebhookMessage: { how: "repository", call: "repos.scrubProcessedWebhookPhones", json: "d.processedWebhookMessageIds" },
  UnknownQuestion: { how: "repository", call: "repos.unknownQuestion.deleteByLead", json: "d.unknownQuestions = " },
  Ticket: { how: "repository", call: "repos.ticket.deleteByLead", json: "d.tickets = " },
  AutoReplyLog: { how: "repository", call: "repos.autoReplyLog.deleteByLead", json: "d.autoReplyLogs = " },
  MediaCatalogItem: { how: "repository", call: "eraseLeadMedia(", json: "d.mediaCatalogItems = " },
  LeadReviewDecision: { how: "repository", call: "repos.leadReviewDecision.deleteByLead", json: "d.leadReviewDecisions = " },
  Order: { how: "repository", call: "repos.order.deleteByLead", json: "d.orders = " },
  Quote: { how: "repository", call: "repos.quote.deleteByLead", json: "d.quotes = " },
  FollowUp: { how: "repository", call: "repos.followUp.deleteByLead", json: "d.followUps = " },
  OutcomeSignal: { how: "repository", call: "repos.outcomeSignal.deleteByLead", json: "d.outcomeSignals = " },
  OwnerCopilotConversation: { how: "repository", call: "repos.ownerCopilotConversation.clearActiveLead", json: "c.activeLeadId = undefined" },
  DoNotContactEntry: { how: "kept", why: "LOGIC.md Q18: the opt-out must outlive the customer record" },
  Workspace: { how: "kept", why: "the owner's own number, not a customer's" },
  BusinessProfile: { how: "kept", why: "the company's own contact details" },
  ProviderAccount: { how: "kept", why: "the company's WhatsApp sending number" },
  WhatsAppAgentSettings: { how: "kept", why: "the staff escalation contact" },
};
/** Models with no lead field that still hold customer data, and how. */
const INDIRECT: Record<string, Decision> = {
  TicketEvent: { how: "repository", call: "repos.ticketEvent.deleteByTicketIds", json: "d.ticketEvents = " },
  AgentRun: { how: "repository", call: "repos.agentRun.deleteMentioning", json: "d.agentRuns = " },
  HumanFallbackTask: { how: "repository", call: "repos.lead.deleteById", json: "d.humanFallbackTasks = " },
};

function schemaModels(): Map<string, string[]> {
  const models = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of readSource("prisma/schema.prisma").split("\n")) {
    const open = line.match(/^model (\w+) \{/);
    if (open) { current = open[1]; models.set(current, []); continue; }
    if (line.startsWith("}")) { current = null; continue; }
    if (current) models.get(current)!.push(line.trim());
  }
  return models;
}

test("A — every model with a lead or phone field has an erasure decision, and the decision is real", () => {
  const models = schemaModels();
  const cascadeSrc = readSource("src/services/ErasureCascade.ts");
  const repoPath = cascadeSrc.slice(cascadeSrc.indexOf("export async function eraseLeadViaRepositories"));
  const jsonPath = cascadeSrc.slice(cascadeSrc.indexOf("export async function eraseLeadCascade"), cascadeSrc.indexOf("export async function eraseLeadViaRepositories"));
  const missing: string[] = [];
  for (const [name, lines] of models) {
    const fields = lines.filter((l) => l && !l.startsWith("//") && !l.startsWith("@@")).map((l) => l.split(/\s+/)[0]);
    const touches = fields.some((f) => /leadId|LeadId|phone|Phone|whatsappNumber|WhatsappNumber/.test(f));
    if (touches && !CENSUS[name]) missing.push(name);
  }
  assert.deepEqual(missing, [], `models with a lead or phone field and no erasure decision: ${missing.join(", ")}`);
  for (const [name, decision] of Object.entries({ ...CENSUS, ...INDIRECT })) {
    if (decision.how === "fk-cascade") {
      const lines = models.get(name) || [];
      assert.ok(lines.some((l) => /\bLead\b.*@relation\(.*onDelete: Cascade/.test(l)), `${name} is listed as removed by the database, but its lead relation does not cascade`);
    } else if (decision.how === "repository") {
      assert.ok(repoPath.includes(decision.call), `${name}: eraseLeadViaRepositories does not call ${decision.call}`);
      assert.ok(jsonPath.includes(decision.json), `${name}: the JSON cascade does not touch ${decision.json}`);
    }
  }
  // The route's Postgres branch uses the shared function.
  const route = readSource("src/app/api/[[...path]]/route.ts");
  assert.ok(/eraseLeadViaRepositories\(\{ workspaceId, lead, repos \}\)/.test(route), "the erasure route does not use eraseLeadViaRepositories");
});

const PHONE = "+91 98250 55555";
const EXTRA = "0261 2345678";
async function seed(tag: string) {
  const ws = `ws_erase_${tag}_${RUN}`;
  await ensureWorkspace(repos, ws);
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: "Erasable Zari Works", contactName: "Ramesh Erasable", email: "ramesh@erasable.example", whatsappNumber: PHONE });
  const other = await repos.lead.createLead({ workspaceId: ws, companyName: "Keeper Textiles", whatsappNumber: "+91 98250 66666" });
  await repos.lead.addLeadPhoneNumber(ws, lead.id, { number: EXTRA, type: "landline" });
  const id = lead.id;
  await repos.mutateAll!((d: AppData) => {
    const at = new Date().toISOString();
    const base = { workspaceId: ws, createdAt: at, updatedAt: at };
    d.replies.push({ ...base, id: `rep_${tag}`, leadId: id, rawText: "hi from Ramesh" } as never);
    d.outreachActivities.push({ ...base, id: `out_${tag}`, leadId: id, body: "hello" } as never);
    d.tickets = [...(d.tickets || []), { ...base, id: `tkt_${tag}`, leadId: id, title: "shade" } as never];
    d.ticketEvents = [...(d.ticketEvents || []), { ...base, id: `tev_${tag}`, ticketId: `tkt_${tag}`, note: "called" } as never];
    d.orders = [...(d.orders || []), { ...base, id: `ord_${tag}`, leadId: id } as never];
    d.quotes = [...(d.quotes || []), { ...base, id: `quo_${tag}`, leadId: id } as never];
    d.autoReplyLogs = [...(d.autoReplyLogs || []), { ...base, id: `arl_${tag}`, leadId: id, incomingMessage: "price?" } as never];
    d.unknownQuestions = [...(d.unknownQuestions || []), { ...base, id: `uq_${tag}`, leadId: id, question: "gst?" } as never];
    d.interactions = [...(d.interactions || []), { ...base, id: `int_${tag}`, leadId: id, role: "PROSPECT", channel: "WHATSAPP", content: "hello" } as never];
    d.humanFallbackTasks = [...(d.humanFallbackTasks || []), { ...base, id: `hft_${tag}`, interactionId: `int_${tag}`, status: "open" } as never];
    d.leadReviewDecisions = [...(d.leadReviewDecisions || []), { ...base, id: `lrd_${tag}`, leadId: id, reason: "Erasable Zari Works fits because…" } as never];
    d.messageTemplates.push({ ...base, id: `msg_${tag}`, leadId: id, campaignId: "c", channel: "whatsapp", body: "Namaste Ramesh" } as never);
    d.followUps = [...(d.followUps || []), { ...base, id: `fu_${tag}`, leadId: id, note: "call after Diwali", status: "open" } as never];
    d.agentRuns.push({ ...base, id: `run_${tag}`, agentName: "reply", input: { text: "customer on 98250 55555 asked" }, status: "completed", startedAt: at } as never);
    d.agentRuns.push({ ...base, id: `run_keep_${tag}`, agentName: "reply", input: { text: "Keeper Textiles asked" }, status: "completed", startedAt: at } as never);
    d.ownerCopilotConversations = [...(d.ownerCopilotConversations || []), { ...base, id: `cop_${tag}`, ownerUserId: "owner", activeLeadId: id, clarifyBatchCount: 0 } as never];
  });
  await repos.recordProcessedWebhookMessage!({ workspaceId: ws, providerMessageId: `wamid.${tag}.${RUN}`, fromPhone: "919825055555", processedAt: new Date().toISOString(), outcome: "processed" });
  await repos.mediaCatalog.create(ws, { title: "photo", category: "customer_photo", leadId: id, fileType: "image/jpeg", fileName: "p.jpg", url: "/x" } as never, Buffer.from("x"));
  await registerDoNotContact(ws, { phone: PHONE, reason: "said stop", sourceLeadId: id }, repos);
  return { ws, lead, other };
}

async function assertNoTrace(ws: string, leadId: string, otherId: string) {
  const data = await readData();
  const kept = { ...data, doNotContactRegistry: [], auditLogs: [] } as AppData;
  const text = JSON.stringify(kept);
  for (const needle of [leadId, "9825055555", "98250 55555", "ramesh@erasable.example", "Erasable Zari Works", "02612345678", "0261 2345678"]) {
    if (text.includes(needle)) {
      const where = Object.entries(kept).filter(([, rows]) => JSON.stringify(rows ?? null).includes(needle)).map(([key]) => key);
      assert.fail(`"${needle}" is still in the store after erasure (in: ${where.join(", ")})`);
    }
  }
  assert.ok((data.doNotContactRegistry || []).some((e) => e.workspaceId === ws && e.sourceLeadId === leadId), "the do-not-contact entry was not kept");
  assert.ok(data.leads.some((l) => l.id === otherId), "the other customer was erased too");
  assert.ok(data.agentRuns.some((r) => r.workspaceId === ws && JSON.stringify(r.input).includes("Keeper Textiles")), "an agent run about another customer was removed");
  assert.ok((data.processedWebhookMessageIds || []).some((r) => r.workspaceId === ws && r.providerMessageId.startsWith("wamid.")), "the duplicate-check entry itself was removed (only the phone should go)");
}

test("B — the JSON cascade removes every trace", async () => {
  const { ws, lead, other } = await seed("json");
  const result = await eraseLeadCascade({ workspaceId: ws, leadId: lead.id, data: await readData(), mutateData: mutateData as never });
  assert.equal(result.counts.messageDrafts, 1);
  assert.equal(result.counts.agentRuns, 1);
  assert.equal(result.counts.webhookPhonesScrubbed, 1);
  await assertNoTrace(ws, lead.id, other.id);
});

test("C — the repository path (Postgres) removes every trace", async () => {
  const { ws, lead, other } = await seed("repo");
  const counts = await eraseLeadViaRepositories({ workspaceId: ws, lead, repos });
  assert.equal(counts.ticketEvents, 1, "ticket events were not removed by ticket id");
  assert.equal(counts.reviewDecisions, 1);
  assert.equal(counts.messageDrafts, 1);
  assert.equal(counts.agentRuns, 1);
  assert.equal(counts.webhookPhonesScrubbed, 1);
  assert.equal(counts.lead, 1);
  await assertNoTrace(ws, lead.id, other.id);
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
