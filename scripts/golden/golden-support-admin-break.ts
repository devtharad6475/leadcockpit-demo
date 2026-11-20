/**
 * golden-support-admin-break.ts — what the 2026-09-26 break test found in
 * tickets, SLA timers, orders after creation, and the operator's admin tools.
 * Each case failed on the code before its fix.
 *
 *   A — a business that works Sundays: Sunday hours count toward the reply
 *       deadline (Sunday was never counted — the settings say 7, the clock said 0).
 *   B — business hours on the half hour (09:30–17:30) are kept to the minute
 *       (the clock ran from 09:00 to 18:00).
 *   C — "no working days" does not push every deadline a month out; the
 *       clock falls back to plain hours.
 *   D — a reopened ticket gets a fresh deadline instead of showing as late the
 *       moment it reopens, and loses its old resolved/closed dates.
 *   E — a ticket cannot be handed to someone who is not an active member of
 *       the team (removed, invited, or a made-up id); the history names the
 *       person, not their id; an assignment rule pointing at a removed person
 *       leaves the ticket unassigned.
 *   F — a ticket with a made-up priority is refused (its deadline was "now").
 *   G — an order cannot be marked as shipping more than was ordered, lines it
 *       does not have, or fewer than were already shipped.
 *   H — three "Revise" clicks at once make one replacement quote, not three.
 *   I — an older password-reset link stops working once a newer one is sent;
 *       one link used twice at once sets the password once.
 *   J — two "Impersonate" clicks at once start one session, not two.
 *   K — erasing a customer also removes their other phone numbers, their chat
 *       lines and the review notes about them — and nothing of anyone else's.
 *   L — resuming a workspace that is not suspended changes nothing and does
 *       not write a false "resumed" entry.
 *
 * Run: npm run golden:support-admin-break
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { TicketSlaSettings } from "@/lib/types";
import { computeSla, defaultTicketSlaSettings } from "@/lib/ticket-sla";
import { NeedsActionError } from "@/lib/user-errors";
import { defaultWorkspaceId } from "@/lib/db";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

function sla(overrides: Partial<TicketSlaSettings>): TicketSlaSettings {
  return { id: "s", createdAt: "", updatedAt: "", ...defaultTicketSlaSettings("ws"), ...overrides } as TicketSlaSettings;
}

async function post(path: string[], body: unknown) {
  const { POST } = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/${path.join("/")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await POST(request as never, { params: Promise.resolve({ path }) });
  return { status: response.status, body: await response.json() };
}

test("A — Sunday hours count for a business that works Sundays", async () => {
  // Sunday 27 Sep 2026, 10:00 IST. Urgent = 4 working hours, open 7 days 09:00–18:00.
  const due = computeSla({
    priority: "urgent", startedAt: new Date("2026-09-27T04:30:00Z"), now: new Date("2026-09-27T04:30:00Z"),
    settings: sla({ businessDays: [1, 2, 3, 4, 5, 6, 7], urgentSlaMinutes: 240 }),
  }).dueAt;
  assert.equal(due.toISOString(), "2026-09-27T08:30:00.000Z", `due ${due.toISOString()} — Sunday was not counted`);
});

test("B — half-hour business hours are kept to the minute", async () => {
  // Monday 28 Sep 17:00 IST, hours 09:30–17:30, 60 working minutes:
  // 30 today + 30 from 09:30 tomorrow = Tuesday 10:00 IST.
  const due = computeSla({
    priority: "urgent", startedAt: new Date("2026-09-28T11:30:00Z"), now: new Date("2026-09-28T11:30:00Z"),
    settings: sla({ businessHoursStart: "09:30", businessHoursEnd: "17:30", urgentSlaMinutes: 60 }),
  }).dueAt;
  assert.equal(due.toISOString(), "2026-09-29T04:30:00.000Z", `due ${due.toISOString()}`);
});

test("C — no working days does not push the deadline a month out", async () => {
  const start = new Date("2026-09-28T05:00:00Z");
  for (const settings of [sla({ businessDays: [], urgentSlaMinutes: 240 }), sla({ businessHoursStart: "18:00", businessHoursEnd: "09:00", urgentSlaMinutes: 240 })]) {
    const due = computeSla({ priority: "urgent", startedAt: start, now: start, settings }).dueAt;
    assert.equal((due.getTime() - start.getTime()) / 60000, 240, `deadline was ${(due.getTime() - start.getTime()) / 60000} minutes away`);
  }
});

test("D — a reopened ticket gets a fresh deadline, not an instant 'late'", async () => {
  const { createTicketFromInbound, changeTicketStatus, computeLiveBreach } = await import("@/services/TicketService");
  const ws = `ws_reopen_${RUN}`;
  await ensureWorkspace(repos, ws);
  const t = await createTicketFromInbound({ workspaceId: ws, sourceChannel: "manual", type: "complaint", priority: "urgent", subject: "Late parcel", description: "x" }, repos);
  await changeTicketStatus(ws, t.id, "closed", { actorType: "owner", note: "Customer confirmed the parcel issue was resolved." }, repos);
  // It was closed long ago; its old deadline is weeks in the past.
  await repos.ticket.update(ws, t.id, { slaDueAt: "2026-01-01T00:00:00.000Z", resolvedAt: "2026-01-01T00:00:00.000Z" });
  const reopened = await changeTicketStatus(ws, t.id, "reopened", { actorType: "owner" }, repos);
  assert.equal(computeLiveBreach(reopened, new Date()).breached, false, "the reopened ticket was late the moment it reopened");
  assert.equal(reopened.closedAt, undefined, "the reopened ticket still says it was closed");
  assert.equal(reopened.resolvedAt, undefined);
  // Moving an open ticket straight back to open keeps its deadline.
  const again = await changeTicketStatus(ws, t.id, "in_progress", { actorType: "owner" }, repos);
  assert.equal(again.slaDueAt, reopened.slaDueAt);
});

test("E — tickets go only to active team members, and the history names them", async () => {
  const { createTicketFromInbound, assignTicketToMember } = await import("@/services/TicketService");
  const ws = `ws_assign_${RUN}`;
  await ensureWorkspace(repos, ws);
  const now = new Date().toISOString();
  await repos.workspaceMember.create({ id: `m1_${RUN}`, workspaceId: ws, userId: `u_asha_${RUN}`, email: "asha@example.test", name: "Asha", role: "sales_member", status: "active", createdAt: now, updatedAt: now });
  await repos.workspaceMember.create({ id: `m2_${RUN}`, workspaceId: ws, userId: `u_gone_${RUN}`, email: "gone@example.test", name: "Gone", role: "sales_member", status: "disabled", createdAt: now, updatedAt: now });
  const t = await createTicketFromInbound({ workspaceId: ws, sourceChannel: "manual", type: "question", priority: "low", subject: "Q", description: "x" }, repos);
  for (const bad of [`u_gone_${RUN}`, "user_made_up", 42]) {
    await assert.rejects(() => assignTicketToMember(ws, t.id, bad as never, undefined, repos), NeedsActionError, `assigned to ${String(bad)}`);
  }
  assert.equal((await repos.ticket.getById(ws, t.id))?.assignedTo, undefined);
  const ok = await assignTicketToMember(ws, t.id, `u_asha_${RUN}`, undefined, repos);
  assert.equal(ok.assignedTo, `u_asha_${RUN}`);
  const events = await repos.ticketEvent.listByTicket(ws, t.id);
  const note = events.find((e) => e.eventType === "assigned")?.note || "";
  assert.ok(note.includes("Asha") && !note.includes("u_asha"), `history said: ${note}`);
  assert.equal((await assignTicketToMember(ws, t.id, undefined, undefined, repos)).assignedTo, undefined, "unassigning stopped working");
  // An assignment rule that still points at the removed person.
  await repos.ticketSlaSettings.upsertForWorkspace(ws, { ...defaultTicketSlaSettings(ws), assignmentMode: "auto_rule", assignmentRules: [{ match: { priority: "high" }, assignToUserId: `u_gone_${RUN}` }] } as never);
  const ruled = await createTicketFromInbound({ workspaceId: ws, sourceChannel: "manual", type: "question", priority: "high", subject: "R", description: "x" }, repos);
  assert.equal(ruled.assignedTo, undefined, "a rule handed the ticket to someone removed from the team");
  // And through the API the screen uses.
  await ensureWorkspace(repos, defaultWorkspaceId);
  const apiTicket = await createTicketFromInbound({ workspaceId: defaultWorkspaceId, sourceChannel: "manual", type: "question", priority: "low", subject: "API", description: "x" }, repos);
  const r = await post(["tickets", apiTicket.id, "assign"], { assignedTo: "user_made_up" });
  assert.ok(r.status >= 400 && r.status < 500, `the API assigned a ticket to a made-up id (HTTP ${r.status})`);
  assert.equal((await repos.ticket.getById(defaultWorkspaceId, apiTicket.id))?.assignedTo, undefined);
});

test("C2 — a long SLA target does not freeze ticket creation", async () => {
  const start = new Date("2026-09-28T05:00:00Z");
  const t0 = Date.now();
  computeSla({ priority: "low", startedAt: start, now: start, settings: sla({ lowSlaMinutes: 1_000_000 }) });
  assert.ok(Date.now() - t0 < 1000, `computing one deadline took ${Date.now() - t0} ms`);
});

test("F — a made-up priority is refused", async () => {
  const { createTicketFromInbound } = await import("@/services/TicketService");
  const ws = `ws_prio_${RUN}`;
  await ensureWorkspace(repos, ws);
  await assert.rejects(() => createTicketFromInbound({ workspaceId: ws, sourceChannel: "manual", type: "question", priority: "banana" as never, subject: "Q", description: "x" }, repos), NeedsActionError);
  await assert.rejects(() => createTicketFromInbound({ workspaceId: ws, sourceChannel: "manual", type: "gossip" as never, priority: "low", subject: "Q", description: "x" }, repos), NeedsActionError);
});

test("G — shipping more than was ordered, unknown lines, or going backwards is refused", async () => {
  const ws = defaultWorkspaceId;
  await ensureWorkspace(repos, ws);
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: `Ship Co ${RUN}` });
  const order = await repos.order.create({ workspaceId: ws, leadId: lead.id, status: "confirmed", origin: "direct", currencyCode: "INR", grandTotal: 100, lineItems: [{ id: "l1", productName: "Zari", quantity: 10, unitPrice: 10, lineTotal: 100 } as never] });
  for (const bad of [{ l1: 50 }, { nope: 1 }, { l1: -2 }, { l1: "lots" }, { l1: 0 }]) {
    const r = await post(["orders", order.id, "status"], { toStatus: "partial_shipped", shippedQuantityByLine: bad });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(bad)} → HTTP ${r.status}`);
  }
  const good = await post(["orders", order.id, "status"], { toStatus: "partial_shipped", shippedQuantityByLine: { l1: 4 } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  const back = await post(["orders", order.id, "status"], { toStatus: "partial_shipped", shippedQuantityByLine: { l1: 2 } });
  assert.equal(back.status, 409, `shipped count went from 4 back to 2 (HTTP ${back.status})`);
  assert.deepEqual((await repos.order.getById(ws, order.id))?.shippedQuantityByLine, { l1: 4 });
});

test("H — three Revise clicks at once make one replacement", async () => {
  const ws = defaultWorkspaceId;
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: `Revise Co ${RUN}` });
  const quote = await repos.quote.create({ workspaceId: ws, leadId: lead.id, status: "sent", lineItems: [{ id: "q1", productName: "x", quantity: 1, unitPrice: 5, lineTotal: 5 } as never], grandTotal: 5, currencyCode: "INR" });
  const results = await Promise.all([1, 2, 3].map(() => post(["quotes", quote.id, "revise"], {})));
  const replacements = (await repos.quote.listByLead(ws, lead.id)).filter((q) => q.supersedesQuoteId === quote.id);
  assert.equal(replacements.length, 1, `${replacements.length} replacements (HTTP ${results.map((r) => r.status).join(",")})`);
});

test("I — an older reset link dies when a newer one is sent; one link works once", async () => {
  const { repositories } = await import("@/repositories");
  const { issuePasswordReset } = await import("@/services/PlatformAdminService");
  const { redeemPasswordReset } = await import("@/services/PasswordResetService");
  const ws = `ws_reset_${RUN}`;
  await ensureWorkspace(repositories, ws);
  const admin = `adm_reset_${RUN}`;
  await repositories.platformAdmin.createWithCredential({ admin: { id: admin, email: `op_${RUN}@example.test`, name: "Op", role: "operator", status: "active" }, credential: { adminId: admin, email: `op_${RUN}@example.test`, passwordHash: "x".repeat(60) } } as never);
  const user = `u_reset_${RUN}`;
  const now = new Date().toISOString();
  await repositories.user.create({ id: user, workspaceId: ws, name: "Staff", email: `s_${RUN}@example.test`, role: "admin", createdAt: now, updatedAt: now } as never);
  await repositories.userCredential.create({ id: `cred_${user}`, userId: user, workspaceId: ws, email: `s_${RUN}@example.test`, passwordHash: "old", sessionVersion: 1, createdAt: now, updatedAt: now } as never);
  const first = await issuePasswordReset({ adminId: admin, targetUserId: user, targetWorkspaceId: ws });
  const second = await issuePasswordReset({ adminId: admin, targetUserId: user, targetWorkspaceId: ws });
  await assert.rejects(() => redeemPasswordReset({ rawToken: first.token, newPassword: "first-link-pass" }), /newer one/, "the older link still set a password");
  const both = await Promise.allSettled([1, 2].map((n) => redeemPasswordReset({ rawToken: second.token, newPassword: `pass-number-${n}` })));
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, "one reset link set the password twice");
});

test("J — two Impersonate clicks at once start one session", async () => {
  const { repositories } = await import("@/repositories");
  const { startImpersonation } = await import("@/services/PlatformAdminService");
  const ws = `ws_imp_${RUN}`;
  await ensureWorkspace(repositories, ws);
  const admin = `adm_imp_${RUN}`;
  await repositories.platformAdmin.createWithCredential({ admin: { id: admin, email: `imp_${RUN}@example.test`, name: "Op", role: "operator", status: "active" }, credential: { adminId: admin, email: `imp_${RUN}@example.test`, passwordHash: "x".repeat(60) } } as never);
  const now = new Date().toISOString();
  const target = `u_imp_${RUN}`;
  await repositories.user.create({ id: target, workspaceId: ws, name: "Sales", email: `imp_u_${RUN}@example.test`, role: "sales_member", createdAt: now, updatedAt: now } as never);
  const both = await Promise.allSettled([1, 2].map(() => startImpersonation({ adminId: admin, targetUserId: target, targetWorkspaceId: ws, reason: "support" })));
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1, "two impersonation sessions started at once");
});

test("K — erasure removes the customer's numbers, chat lines and review notes, and nothing else", async () => {
  const { eraseLeadCascade } = await import("@/services/ErasureCascade");
  const { readData, mutateData } = await import("@/lib/db");
  const ws = `ws_erase_${RUN}`;
  await ensureWorkspace(repos, ws);
  // UUID suffixes are not phone numbers: stripping letters can make two
  // different suffixes (a1b2/c1d2) produce the same lookup. Pin that old
  // collision here, but give each customer an actual distinct fixture number.
  const gone = await repos.lead.createLead({ id: `lead_erase_${RUN}_a1b2`, workspaceId: ws, companyName: "Erase Me", phone: "+919800000001" });
  const stays = await repos.lead.createLead({ id: `lead_keep_${RUN}_c1d2`, workspaceId: ws, companyName: "Keep Me", phone: "+919800000002" });
  const extraPhones = new Map([[gone.id, "+919800001001"], [stays.id, "+919800001002"]]);
  for (const lead of [gone, stays]) {
    await repos.lead.addLeadPhoneNumber(ws, lead.id, { number: extraPhones.get(lead.id)!, type: "mobile" });
  }
  assert.notEqual(extraPhones.get(gone.id), extraPhones.get(stays.id));
  assert.equal((await repos.lead.findLeadByPhone(ws, extraPhones.get(gone.id)!))?.id, gone.id);
  assert.equal((await repos.lead.findLeadByPhone(ws, extraPhones.get(stays.id)!))?.id, stays.id);
  const now = new Date().toISOString();
  await mutateData((d) => {
    d.interactions ||= [];
    d.leadReviewDecisions ||= [];
    d.humanFallbackTasks ||= [];
    for (const lead of [gone, stays]) {
      d.interactions.push({ id: `int_${lead.id}`, workspaceId: ws, leadId: lead.id, role: "PROSPECT", channel: "WHATSAPP", content: `private words from ${lead.companyName}`, timestamp: now, needsHumanHelp: true, createdAt: now, updatedAt: now });
      d.leadReviewDecisions.push({ id: `lrd_${lead.id}`, workspaceId: ws, leadId: lead.id, decision: "approve", confidenceScore: 0.9, reason: `${lead.companyName} fits`, matchedSignals: [], riskSignals: [], modeUsed: "manual" as never, decidedBy: "human", createdAt: now, updatedAt: now });
      d.humanFallbackTasks.push({ id: `hft_${lead.id}`, workspaceId: ws, interactionId: `int_${lead.id}`, prospectQuery: `question from ${lead.companyName}`, status: "PENDING", createdAt: now, updatedAt: now });
    }
  });
  await eraseLeadCascade({ workspaceId: ws, leadId: gone.id, data: await readData(), mutateData: mutateData as never });
  const d = await readData();
  const left = (rows: Array<{ workspaceId: string; leadId?: string; interactionId?: string }> | undefined, id: string) =>
    (rows || []).filter((r) => r.workspaceId === ws && (r.leadId === id || r.interactionId === `int_${id}`)).length;
  assert.equal(left(d.leadPhoneNumbers, gone.id), 0, "the erased customer's phone numbers are still stored");
  assert.equal(left(d.interactions, gone.id), 0, "the erased customer's chat lines are still stored");
  assert.equal(left(d.leadReviewDecisions, gone.id), 0, "review notes about the erased customer are still stored");
  assert.equal(left(d.humanFallbackTasks, gone.id), 0, "the erased customer's open questions are still stored");
  for (const rows of [d.leadPhoneNumbers, d.interactions, d.leadReviewDecisions, d.humanFallbackTasks]) {
    assert.equal(left(rows as never, stays.id), 1, "another customer's records were deleted");
  }
  const { findLeadByPhone } = repos.lead as unknown as { findLeadByPhone: (w: string, p: string) => Promise<unknown> };
  assert.equal(await findLeadByPhone(ws, extraPhones.get(gone.id)!), undefined);
  assert.equal((await repos.lead.findLeadByPhone(ws, extraPhones.get(stays.id)!))?.id, stays.id, "the retained customer's phone must still resolve");
});

test("L — resuming an active workspace writes no false 'resumed' entry", async () => {
  const { repositories } = await import("@/repositories");
  const { resumeWorkspace } = await import("@/services/PlatformAdminService");
  const ws = `ws_resume_${RUN}`;
  await ensureWorkspace(repositories, ws);
  const admin = `adm_resume_${RUN}`;
  await repositories.platformAdmin.createWithCredential({ admin: { id: admin, email: `res_${RUN}@example.test`, name: "Op", role: "operator", status: "active" }, credential: { adminId: admin, email: `res_${RUN}@example.test`, passwordHash: "x".repeat(60) } } as never);
  const { readData } = await import("@/lib/db");
  const count = async () => ((await readData()).platformAuditLogs || []).filter((l) => l.action === "workspace_resumed" && (l.metadata as { workspaceId?: string })?.workspaceId === ws).length;
  const before = await count();
  const ws2 = await resumeWorkspace({ adminId: admin, workspaceId: ws });
  assert.equal(ws2.status, "active");
  assert.equal(await count(), before, "a workspace that was never suspended was logged as resumed");
});

(async () => {
  console.log("golden-support-admin-break — tickets, SLA, orders after creation, operator tools\n");
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
  }
  console.log(`\nsupport-admin-break: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
  process.exit(failed ? 1 : 0);
})();
