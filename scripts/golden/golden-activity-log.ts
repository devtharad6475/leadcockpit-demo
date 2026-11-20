/**
 * golden-activity-log.ts — 2026-09-28 (feature book #14). The owner's
 * "who did what" list. Rules: docs/LOGIC.md "2026-09-28 — ACTIVITY LOG".
 *
 *   A — every mapped event type gives a plain sentence (no codes, no ids),
 *       with the right WHO (person / The AI / The daily routine / The system)
 *   B — the CEO's examples read exactly right; India time ("today 10:42")
 *   C — an unknown type gets a safe generic sentence, never its code
 *   D — no secret, token, password hash, raw payload or internal id leaks
 *   E — company-scoped: another company's rows and people never appear
 *   F — filters: people / AI / one person / kind
 *   G — paging: newest first, "before" continues with no gap and no repeat
 *   H — a mirrored event-bus row is not shown twice
 *   I — the route exists and is owner/admin only
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-activity-log.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { readSource } from "./_helpers/read-source";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { listActivity, RULES, whenIst, type ActivityItem } from "@/services/ActivityLogService";
import { ADMIN_REQUIRED_PREFIXES, requiredRoleForPath } from "@/lib/rbac-map";
import { groupRepeats } from "@/lib/activity-groups";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// Monday 28 Sep 2026, 12:00 IST.
const NOW = new Date("2026-09-28T06:30:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MIN).toISOString();

async function company(tag: string) {
  const W = `ws_activity_${tag}_${RUN}`;
  await ensureWorkspace(repos, W);
  const owner = `user_act_owner_${tag}_${RUN}`;
  const admin = `user_act_admin_${tag}_${RUN}`;
  await repos.user.create({ id: owner, workspaceId: W, name: "Meena Shah", email: `meena_${tag}_${RUN}@example.com`, role: "owner" });
  await repos.user.create({ id: admin, workspaceId: W, name: "Ravi Kumar", email: `ravi_${tag}_${RUN}@example.com`, role: "admin" });
  const t = new Date().toISOString();
  await repos.workspaceMember.create({ id: `wm_o_${tag}_${RUN}`, workspaceId: W, userId: owner, email: `meena_${tag}_${RUN}@example.com`, name: "Meena Shah", role: "owner", status: "active", createdAt: t, updatedAt: t });
  await repos.workspaceMember.create({ id: `wm_a_${tag}_${RUN}`, workspaceId: W, userId: admin, email: `ravi_${tag}_${RUN}@example.com`, name: "Ravi Kumar", role: "admin", status: "active", createdAt: t, updatedAt: t });
  return { W, owner, admin };
}

async function audit(W: string, eventType: string, actorUserId: string | undefined, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return repos.auditLog.create({ workspaceId: W, eventType, actorUserId, createdAt: at(minutesAgo), payload: {}, ...extra } as never);
}

const all = (W: string, q: Record<string, unknown> = {}) => listActivity(W, repos, { limit: 200, now: NOW, ...q });

/** A sentence a business owner can read: no codes, no ids, no JSON. */
function assertPlain(item: ActivityItem, eventType: string) {
  const s = item.sentence;
  assert.match(s, /^[A-Z]/, `${eventType}: starts with a capital: ${s}`);
  assert.match(s, /[.”]$/, `${eventType}: ends like a sentence: ${s}`);
  assert.ok(!s.includes(eventType), `${eventType}: the event code leaked: ${s}`);
  assert.ok(!/[a-z]+_[a-z_]+/.test(s), `${eventType}: a snake_case code leaked: ${s}`);
  assert.ok(!/\b[a-z]+\.[a-z_]+\b/.test(s.replace(/\.$/, "")), `${eventType}: a dotted code leaked: ${s}`);
  assert.ok(!/[{}[\]]/.test(s), `${eventType}: raw JSON leaked: ${s}`);
  assert.ok(!/\b(undefined|null|NaN)\b/.test(s), `${eventType}: a missing value leaked: ${s}`);
}

test("A — every mapped event type gives a plain sentence with the right WHO", async () => {
  const { W, owner } = await company("a");
  const types = Object.keys(RULES);
  assert.ok(types.length >= 100, `the map covers the event types found in the codebase (got ${types.length})`);
  let i = 0;
  for (const type of types) {
    await audit(W, type, "system", 1000 + i);
    await audit(W, type, owner, 5000 + i);
    i++;
  }
  const page = await all(W, { limit: 200 });
  const next = await all(W, { limit: 200, before: page.nextBefore });
  const items = [...page.items, ...next.items];
  assert.equal(items.length, types.length * 2, "every row is shown once");
  assert.equal(items.filter((it) => it.personId === owner).length, types.length, "a person's rows carry their id for the filter");
  for (const it of items) assertPlain(it, "(mapped)");
  // WHO for automatic rows follows the rule, never "Someone".
  const auto = items.filter((it) => it.actorKind !== "person");
  assert.equal(auto.length, types.length);
  for (const it of auto) assert.ok(["The AI", "The daily routine", "The system"].includes(it.who), `automatic WHO: ${it.who}`);
  assert.ok(items.filter((it) => it.personId === owner).every((it) => it.who === "Meena Shah"), "the person's real name");
  // Each type's own sentence, checked per type so a failure names the type.
  for (const type of types) {
    const rule = RULES[type];
    const what = rule.say({ row: { id: "x", at: at(0), eventType: type, payload: {} }, customer: "a customer", quote: "a quote", order: "an order", n: () => undefined, s: () => undefined, b: () => undefined });
    assertPlain({ sentence: `The AI ${what}.` } as ActivityItem, type);
  }
  // Kinds: all five owner kinds are used.
  for (const k of ["customers", "knowledge", "money", "team", "settings"]) {
    assert.ok(types.some((t) => RULES[t].kind === k), `kind ${k} has events`);
  }
});

test("B — the CEO's examples read exactly right, in India time", async () => {
  const { W, owner } = await company("b");
  const lead = await repos.lead.createLead({ workspaceId: W, companyName: "Shree Textiles", contactName: "S", source: "manual", status: "replied", reviewStatus: "approved" } as never);
  const qaId = `kqa_act_${RUN}`;
  await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push({ id: qaId, workspaceId: W, domainKey: "sales", questionKey: "moq", question: "What is your minimum order quantity?", answer: "100 kg", answerStatus: "answered", sourceType: "manual_edit", confidenceScore: 1, usedByAgentsJson: {}, createdAt: at(0), updatedAt: at(0) } as never);
    return null;
  });
  // 10:42 IST today = 05:12Z
  await repos.auditLog.create({ workspaceId: W, eventType: "knowledge.question_answer.edited", actorUserId: "user_owner", entityType: "knowledge_question_answer", entityId: qaId, createdAt: "2026-09-28T05:12:00Z", payload: { previous: { answer: "100 kg", answerStatus: "answered" }, next: { answer: "100 kg", answerStatus: "answered" } } } as never);
  await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "hello", retrievedContext: { decisionCategory: "greeting" }, canAutoSend: true, needsHumanReview: false, status: "auto_sent", generatedReply: "Namaste!", createdAt: "2026-09-28T05:00:00Z" } as never);
  await repos.auditLog.create({ workspaceId: W, eventType: "auto_reply.kind_switched_off", actorUserId: "system", entityType: "whatsapp_agent_settings", entityId: "catalogue_request", createdAt: "2026-09-27T12:35:00Z", payload: { topic: "catalogue_request", trigger: "complaint", reason: "A customer complained.", evidenceLogIds: ["arl_1"], leadId: lead.id } } as never);
  await audit(W, "digest_sent", "system", 60 * 24 * 3, { entityType: "digest", entityId: "2026-09-25" });

  const { items } = await all(W);
  const text = items.map((i) => `${i.when} | ${i.sentence}`);
  assert.ok(text.includes("today 10:42 | Meena Shah approved the answer to “What is your minimum order quantity?”."), text.join("\n"));
  assert.ok(text.some((t) => t === "today 10:30 | The AI sent a reply to Shree Textiles — greeting."), text.join("\n"));
  assert.ok(text.some((t) => t === "yesterday 18:05 | The system switched off automatic catalogue request replies after a complaint."), text.join("\n"));
  assert.ok(text.some((t) => /^25 Sep 12:00 \| The daily routine prepared the morning summary\.$/.test(t)), text.join("\n"));
  assert.equal(whenIst("2025-01-05T06:30:00Z", NOW), "5 Jan 2025", "another year shows the year");
  void owner;
});

test("C — an unknown type gets a safe generic sentence, never its code", async () => {
  const { W, admin } = await company("c");
  await audit(W, "zz.internal_thing_happened", admin, 1, { payload: { weird: { nested: true } } });
  await audit(W, "zz.other_thing", "system", 2);
  const { items } = await all(W);
  assert.equal(items[0].sentence, "Ravi Kumar made a change.");
  assert.equal(items[1].sentence, "The system made a change.");
  for (const it of items) assert.ok(!JSON.stringify(it).includes("zz."), "the unknown code is not in the item");
});

test("D — no secret, token, password hash, raw payload or internal id leaks", async () => {
  const { W, owner } = await company("d");
  const SECRET = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";
  const HASH = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA";
  await audit(W, "ai.credential.removed", owner, 1, { entityType: "llm_provider_credential", entityId: "cred_internal_123", payload: { newValuesJson: { apiKey: SECRET, passwordHash: HASH, accessToken: "EAAG_token_value_1234567890_abcdefghijk" } } });
  await audit(W, "insight_note", owner, 2, { payload: { note: `Remember the key is ${SECRET} for the portal` } });
  await audit(W, "owner_notify_settings_changed", owner, 3, { payload: { ownerWhatsappNumber: "91******3210", secret: "whsec_abcdefghijklmnopqrstuvwxyz0123" } });
  await audit(W, "lead.approved", "user_ghost_from_elsewhere", 4, { entityType: "lead", entityId: "lead_missing_999" });
  const page = await all(W);
  const json = JSON.stringify(page.items);
  for (const bad of [SECRET, HASH, "EAAG_token", "whsec_", "cred_internal_123", "lead_missing_999", "user_ghost_from_elsewhere", "passwordHash", "apiKey", "newValuesJson", "91******3210"]) {
    assert.ok(!json.includes(bad), `leaked: ${bad}`);
  }
  const note = page.items.find((i) => i.sentence.includes("wrote a note"));
  assert.ok(note && note.sentence.includes("[hidden]"), `the note is shown with the secret hidden: ${note?.sentence}`);
  const ghost = page.items.find((i) => i.what.startsWith("approved"));
  assert.equal(ghost?.sentence, "Someone on your team approved a customer.", "an unknown person is never shown by id");
  // Items carry only the documented fields.
  for (const it of page.items) {
    assert.deepEqual(Object.keys(it).filter((k) => !["key", "at", "when", "who", "actorKind", "personId", "kind", "what", "sentence"].includes(k)), []);
  }
});

test("E — company-scoped: another company's rows and people never appear", async () => {
  const a = await company("e1");
  const b = await company("e2");
  await audit(a.W, "lead.approved", a.owner, 1);
  await audit(b.W, "order.cancelled", b.owner, 1);
  await repos.user.create({ id: `user_other_${RUN}`, workspaceId: b.W, name: "Other Person", email: `o_${RUN}@example.com`, role: "admin" });
  const pa = await all(a.W);
  assert.equal(pa.items.length, 1);
  assert.ok(pa.items.every((i) => i.kind === "customers"));
  assert.ok(!pa.people.some((p) => p.name === "Other Person"), "another company's people are not offered");
  // Asking for another company's person returns nothing.
  assert.equal((await all(a.W, { who: b.owner })).items.length, 0);
});

test("F — filters: people / AI / one person / kind", async () => {
  const { W, owner, admin } = await company("f");
  await audit(W, "quote.converted", owner, 1, { entityType: "quote", payload: { metadataJson: { quoteNumber: 12 } } });
  await audit(W, "invite.created", admin, 2, { payload: { inviteeEmail: "new@example.com", role: "sales_member" } });
  await audit(W, "lead.scored", "system", 3);
  await audit(W, "digest_sent", "system", 4);
  const people = await all(W, { who: "people" });
  assert.deepEqual(people.items.map((i) => i.who), ["Meena Shah", "Ravi Kumar"]);
  const ai = await all(W, { who: "ai" });
  assert.deepEqual(ai.items.map((i) => i.who), ["The AI", "The daily routine"]);
  const ravi = await all(W, { who: admin });
  assert.deepEqual(ravi.items.map((i) => i.sentence), ["Ravi Kumar invited new@example.com to join as a sales member."]);
  const money = await all(W, { kind: "money" });
  assert.deepEqual(money.items.map((i) => i.sentence), ["Meena Shah turned quote #12 into an order."]);
  const team = await all(W, { kind: "team", who: "ai" });
  assert.equal(team.items.length, 0, "filters combine");
  assert.equal((await all(W, { kind: "nonsense" })).items.length, 4, "an unknown kind filter is ignored, not an error");
  assert.deepEqual(people.people.map((p) => p.name), ["Meena Shah", "Ravi Kumar"]);
});

test("G — paging: newest first, before continues with no gap and no repeat", async () => {
  const { W, owner } = await company("g");
  // 7 rows, three sharing one timestamp.
  for (let i = 0; i < 4; i++) await audit(W, "lead.approved", owner, 10 + i);
  for (let i = 0; i < 3; i++) await audit(W, "lead.rejected", owner, 5);
  const seen: string[] = [];
  let before: string | undefined;
  let pages = 0;
  do {
    const p = await listActivity(W, repos, { limit: 2, before, now: NOW });
    seen.push(...p.items.map((i) => i.key));
    for (let k = 1; k < p.items.length; k++) assert.ok(p.items[k - 1].at >= p.items[k].at, "newest first within a page");
    before = p.nextBefore;
    pages++;
  } while (before && pages < 10);
  assert.equal(pages, 4);
  assert.equal(seen.length, 7, "every row once");
  assert.equal(new Set(seen).size, 7, "no repeats across pages");
  const full = await all(W);
  assert.deepEqual(full.items.map((i) => i.key), seen, "paged order equals the full order");
  assert.ok(full.items.slice(0, 3).every((i) => i.what.startsWith("turned down")), "the newest come first");
  assert.equal(full.nextBefore, undefined, "no next page on the last page");
});

test("H — a mirrored event-bus row is not shown twice", async () => {
  const { W, owner } = await company("h");
  const lead = await repos.lead.createLead({ workspaceId: W, companyName: "Mirror Mills", source: "manual", status: "new", reviewStatus: "pending" } as never);
  await audit(W, "lead.approved", owner, 1, { entityType: "lead", entityId: lead.id });
  await audit(W, "lead.approved", "system", 1, { entityType: "lead", entityId: lead.id, payload: { metadataJson: { source: "backend", eventId: "evt_1" } } });
  const { items } = await all(W);
  assert.deepEqual(items.map((i) => i.sentence), ["Meena Shah approved Mirror Mills."]);
});

test("I — the route exists and is owner/admin only", async () => {
  assert.ok(ADMIN_REQUIRED_PREFIXES.has("activity"), "activity is an admin-gated prefix (the sensitive-GET gate reads this set)");
  assert.equal(requiredRoleForPath(["activity"], "GET"), "admin");
  const route = readSource("src/app/api/[[...path]]/route.ts");
  assert.match(route, /match\(path, \["activity"\]\)[\s\S]{0,400}listActivity\(workspaceId, repos/, "GET /activity calls listActivity with the session company");
});

test("J — the same line, one after another, on the same day, is one line with a count (walk-through A1)", async () => {
  const row = (key: string, at: string, what: string, who = "Owner") => ({ key, at, when: at, who, what });
  const grouped = groupRepeats([
    row("1", "2026-09-27T10:00:00Z", "read a document"),
    row("2", "2026-09-27T09:00:00Z", "read a document"),
    row("3", "2026-09-27T08:00:00Z", "read a document"),
    row("4", "2026-09-27T07:00:00Z", "allowed the website to be read"),
    row("5", "2026-09-27T06:00:00Z", "read a document"),
    row("6", "2026-09-26T10:00:00Z", "read a document"),
    row("7", "2026-09-26T09:00:00Z", "read a document", "Priya"),
  ]);
  assert.deepEqual(grouped.map((g) => [g.key, g.times]), [["1", 3], ["4", 1], ["5", 1], ["6", 1], ["7", 1]],
    "only consecutive repeats by the same person on the same day fold; order is kept");
  assert.equal(grouped[0].earliestWhen, "2026-09-27T08:00:00Z", "the folded line says since when");
  assert.deepEqual(groupRepeats([]), []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}\n  ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
