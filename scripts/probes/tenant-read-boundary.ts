/**
 * PROBE — Stage 2, the READ half of true multi-tenancy.
 *
 * WHAT WAS ALREADY PROVEN, AND WHY IT IS NOT ENOUGH. The tenant work so far
 * proves the WRITE side (golden-workspace-scoping: the mutation resolver
 * refuses a body naming someone else's workspace) and exactly TWO read
 * functions (golden-multi-tenant-scoping covers `dashboardState` and
 * `scopeDataForExport`). Two functions out of a hundred-odd read endpoints is a
 * hand-picked list, and a hand-picked list is what N-TEST-5 says drifts: the
 * hundred-and-first endpoint is written next week and nobody adds it.
 *
 * So this is a CLASS check, not a sample. Every GET the router can serve is
 * enumerated FROM THE SOURCE, called with a real signed-in tenant's session,
 * and the response body is searched for any identifier that belongs to somebody
 * else. Adding a new GET endpoint without classifying it here fails the probe
 * on the next run — that is the anti-drift property, and it is the reason the
 * route list is extracted rather than typed out.
 *
 * HOW THE LEAK IS DETECTED. Two customers are signed up through the product's
 * own signup endpoint. Tenant B is filled with data carrying a marker string
 * that exists nowhere else in the database. Tenant A is left exactly as signup
 * created it, so A legitimately owns nothing. The probe then reads the
 * substrate in-process and builds the set of every record id and every
 * workspace id that does NOT belong to A — B's rows AND the 38 tenants already
 * in the substrate. Any of those strings, or the marker, coming back inside A's
 * response is by construction another customer's data on A's screen.
 *
 * WHY TENANT B IS SEEDED RATHER THAN BORROWED. The first version of this probe
 * borrowed the existing tenants and found zero leaks — but the substrate turned
 * out to hold no crawl jobs, no platform tickets, no copilot conversations and
 * one media item, so a dozen endpoints "passed" by returning an empty list when
 * there was nothing to leak in the first place. A pass that cannot fail is not
 * a pass. B is seeded across every collection the GET surface reads, so an
 * empty answer for A is now evidence rather than luck.
 *
 * PARAMETERISED ROUTES ARE ATTACKED, NOT SKIPPED. `/api/orders/:id` is filled
 * with a REAL order id belonging to the neighbour tenant. The only acceptable
 * answers are 403 and 404. A 200 that carries that record is the bug this probe
 * exists to find -- and since 2026-08-26 a 200 that carries NOTHING is a failure
 * too, because it still means ownership was never checked. See
 * DENIED_200_ALLOWED for the only escape, which costs a written reason.
 *
 * WHY A PROBE AND NOT A GOLDEN. It needs a server running in production auth
 * mode on a port it does not own, plus the real ship substrate. Whatever it
 * finds gets pinned afterwards by a golden that can run headless.
 *
 * SAFETY
 *  - READ-ONLY with respect to every EXISTING tenant. The only rows it creates
 *    are its own two fixture tenants, and it deletes both on the way out.
 *  - Fixture passwords are generated with crypto.randomBytes, live only in this
 *    process, and are never printed or written down.
 *  - Seeded contact details are unroutable BY CONSTRUCTION (N-SAFETY-1): RFC
 *    2606 `.example` domains and the reserved +91 00000 000NN phone block.
 *  - Foreign ids ARE printed in failure detail, because a leak report that will
 *    not say what leaked cannot be acted on. Nothing else about a foreign
 *    record is printed — no names, no emails, no phone numbers.
 *
 * Usage:  npx tsx scripts/probes/tenant-read-boundary.ts http://localhost:3021
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:3021";
const ROUTE_FILE = join(process.cwd(), "src", "app", "api", "[[...path]]", "route.ts");

/* ------------------------------------------------------------------ *
 * 1. The route list, extracted from the source so it cannot go stale.
 * ------------------------------------------------------------------ */

/**
 * Pull every `match(path, [...])` pattern out of one function's body.
 *
 * The boundaries are found by name rather than hardcoded line numbers, because
 * line numbers in a 5,600-line file are wrong within a week.
 */
function patternsBetween(source: string, startMarker: string, endMarker: string): string[] {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`could not find ${startMarker} in route.ts`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`could not find ${endMarker} after ${startMarker} in route.ts`);
  const body = source.slice(start, end);
  const found = new Set<string>();
  for (const m of body.matchAll(/match\(path, \[([^\]]*)\]/g)) {
    const parts = m[1].split(",").map((p) => p.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (parts.length) found.add(parts.join("/"));
  }
  return [...found].sort();
}

function extractGetPatterns(): string[] {
  const source = readFileSync(ROUTE_FILE, "utf8");
  const workspaceSide = patternsBetween(source, "async function handleGet(", "async function handlePlatformAdminGet(");
  const adminSide = patternsBetween(source, "async function handlePlatformAdminGet(", "async function handlePlatformAdminPost(");
  return [...new Set([...workspaceSide, ...adminSide])].sort();
}

/* ------------------------------------------------------------------ *
 * 2. How each pattern is exercised.
 * ------------------------------------------------------------------ */

/**
 * Which pool a `:param` segment is filled from. Every one of these is filled
 * with the NEIGHBOUR tenant's real identifier — the point is to ask for
 * somebody else's record by name and be told no.
 */
type Pool =
  | "workspace" | "lead" | "campaign" | "order" | "quote" | "ticket"
  | "platformTicket" | "crawlJob" | "extractionRun" | "knowledgeDoc"
  | "autoReplyLog" | "copilotConversation";

type Plan =
  /** Call it as tenant A and scan the body for foreign identifiers. */
  | { kind: "scan"; fill?: Record<string, Pool> }
  /** Call it with a FOREIGN id; a 200 carrying that record is a leak. */
  | { kind: "denied"; fill: Record<string, Pool> }
  /** Deliberately not part of the workspace-tenancy surface. */
  | { kind: "skip"; why: string };

const ADMIN_SKIP: Plan = {
  kind: "skip",
  why: "platform-admin surface: different audience, different cookie, cross-tenant BY DESIGN.",
};

const UNCLASSIFIED_PREFIX = "UNCLASSIFIED";

/**
 * The AI checks ask tenant A about something that exists ONLY in tenant B, and
 * the question must not contain the marker.
 *
 * WHY THAT MATTERS, because the first version got it wrong. It asked "Where is
 * LEAKMARK... stored?" and then scanned the answer for the marker — so the
 * assistant repeating the question back ("I have no record of LEAKMARK...")
 * scored as a leak. That is a false alarm, and a probe that cries leak is worse
 * than no probe: it trains you to ignore it.
 *
 * So the question carries only this phrase, which is planted in B's knowledge
 * base and nowhere else. The MARKER sits beside it in B's record. Tenant A may
 * ask about the phrase all it likes; the marker coming back means the answer
 * was built from tenant B's row, and nothing else can explain it.
 */
const SECRET_PHRASE = "pallets are staged overnight in the covered loading bay";

/**
 * Routes permitted to answer 200 to a request that names a FOREIGN id.
 *
 * WHY THIS LIST EXISTS AT ALL. A `denied` plan asks for somebody else's record
 * by name. The only correct answers are 403 and 404. This probe used to score
 * a 200 as PASS whenever no foreign identifier appeared in the body — and that
 * is exactly the shape of good news that has to be tested harder than bad
 * news. A 200 means ownership was never checked; it does not mean nothing
 * escaped. `leakedIn()` can only see ids and the marker string, so a handler
 * that answers a neighbour's campaign id with "42 leads, 5,00,000 pipeline"
 * carries no id, scores PASS, and has just handed over a competitor's numbers.
 *
 * So a 200 on a foreign id is now a FAILURE by default, and the only way out
 * is to be named here with a reason a person wrote down. An empty list is the
 * correct starting state: it must be filled by investigating each route, never
 * by pasting in whatever the current run happened to return, which would just
 * bless the status quo and re-open the hole under a different name.
 */
const DENIED_200_ALLOWED: Record<string, string> = {};

const PLANS: Record<string, Plan> = {
  // --- public, pre-login: no tenant data by definition ---
  "auth/status": { kind: "scan" },
  "auth/me": { kind: "scan" },
  "auth/verify-email": { kind: "scan" },
  health: { kind: "scan" },
  "inbound/whatsapp-webhook": { kind: "skip", why: "Meta webhook handshake; returns a challenge string, never workspace data." },

  // --- parameterised: asked for by a NEIGHBOUR's id, must be refused ---
  "activity/lead/:leadId": { kind: "denied", fill: { ":leadId": "lead" } },
  "analytics/campaign/:campaignId": { kind: "denied", fill: { ":campaignId": "campaign" } },
  // 2026-09-04 (N-UX-17) — added with the route. An unplanned parameterised
  // route is SKIPPED by planFor(), not failed, so a new tenant-scoped GET that
  // nobody remembers to list here is silently untested while the run still
  // reports all green. Naming it is the only thing that makes it checked.
  "analytics/campaign/:campaignId/learnings": { kind: "denied", fill: { ":campaignId": "campaign" } },
  "auto-reply-logs/:id": { kind: "denied", fill: { ":id": "autoReplyLog" } },
  "business-profile/:workspaceId": { kind: "denied", fill: { ":workspaceId": "workspace" } },
  "campaigns/:id/creative-brief": { kind: "denied", fill: { ":id": "campaign" } },
  "campaigns/:id/image-brief": { kind: "denied", fill: { ":id": "campaign" } },
  "copilot/conversations/:id/messages": { kind: "denied", fill: { ":id": "copilotConversation" } },
  "crawl/:jobId/pages": { kind: "denied", fill: { ":jobId": "crawlJob" } },
  "crawl/:jobId/status": { kind: "denied", fill: { ":jobId": "crawlJob" } },
  "extraction-runs/:id": { kind: "denied", fill: { ":id": "extractionRun" } },
  "extraction-runs/:id/batches": { kind: "denied", fill: { ":id": "extractionRun" } },
  "knowledge/documents/:id": { kind: "denied", fill: { ":id": "knowledgeDoc" } },
  "leads/:id/conversation-summary": { kind: "denied", fill: { ":id": "lead" } },
  "leads/:id/reengagement-nudge": { kind: "denied", fill: { ":id": "lead" } },
  "leads/:id/whatsapp-window": { kind: "denied", fill: { ":id": "lead" } },
  "orders/:id": { kind: "denied", fill: { ":id": "order" } },
  "outreach/:leadId": { kind: "denied", fill: { ":leadId": "lead" } },
  "platform-tickets/:id": { kind: "denied", fill: { ":id": "platformTicket" } },
  "platform-tickets/:id/events": { kind: "denied", fill: { ":id": "platformTicket" } },
  "quotes/:id": { kind: "denied", fill: { ":id": "quote" } },
  "tickets/:id": { kind: "denied", fill: { ":id": "ticket" } },
  "tickets/:id/events": { kind: "denied", fill: { ":id": "ticket" } },
  "workspaces/:id": { kind: "denied", fill: { ":id": "workspace" } },
};

/** Everything else in handleGet is a plain list/detail read for the caller's own workspace. */
function planFor(pattern: string): Plan {
  const declared = PLANS[pattern];
  if (declared) return declared;
  if (pattern.startsWith("admin/")) return ADMIN_SKIP;
  if (pattern.includes(":")) {
    return { kind: "skip", why: `${UNCLASSIFIED_PREFIX} parameterised GET route — add it to PLANS.` };
  }
  return { kind: "scan" };
}

/* ------------------------------------------------------------------ *
 * 3. HTTP helpers (same shape as tenant-production-proof.ts).
 * ------------------------------------------------------------------ */

type Jar = { cookie: string };

function throwawayPassword(): string {
  return `Fx-${randomBytes(24).toString("base64url")}`;
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; jar?: Jar } = {},
): Promise<{ status: number; text: string; json: Record<string, unknown>; setCookie: string[] }> {
  // Origin is required in production mode: src/lib/csrf.ts rejects a
  // state-changing request that carries neither Origin nor Referer.
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE };
  if (init.jar?.cookie) headers.cookie = init.jar.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some failures return HTML or plain text; status + raw text carry the verdict.
  }
  return { status: res.status, text, json: parsed, setCookie: res.headers.getSetCookie?.() ?? [] };
}

function jarFrom(setCookie: string[]): Jar {
  return { cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}

/* ------------------------------------------------------------------ *
 * 3b. Filling tenant B.
 * ------------------------------------------------------------------ */

/**
 * Give tenant B something to leak, in every collection the GET surface reads.
 *
 * Written through the repository bundle rather than the HTTP API on purpose:
 * the write path already has its own proof (golden-workspace-scoping), what
 * this probe needs is simply for the rows to EXIST so that an empty answer for
 * tenant A means something. Going through the repositories also reaches the
 * collections that have no create endpoint at all — crawl jobs, copilot
 * conversations, auto-reply logs.
 *
 * Every text field carries `marker` so a leak that surfaces a name without an
 * id is still caught.
 */
async function seedTenantB(
  repos: import("@/repositories").RepositoryBundle,
  workspaceId: string,
  ownerUserId: string,
  marker: string,
): Promise<{ seeded: string[]; extraIds: Partial<Record<Pool, string[]>> }> {
  const seeded: string[] = [];
  /**
   * Ids the census cannot find on its own.
   *
   * readAll() on Prisma returns 61 of the 83 collections AppData declares —
   * platform tickets and owner-copilot conversations are among the 22 it does
   * not (logged as N-DATA-14). Without this, the routes that read them would
   * report "no neighbour record to attack with", which is a skip that LOOKS
   * like coverage and is not.
   */
  const extraIds: Partial<Record<Pool, string[]>> = {};
  const now = new Date().toISOString();
  /** Record what worked; a collection this substrate cannot take is reported, not fatal. */
  async function step(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      seeded.push(label);
    } catch (error) {
      const raw = error instanceof Error ? (error.message || `${error.name}: <no message>`) : String(error);
      const firstLine = raw.split(String.fromCharCode(10)).map((line) => line.trim()).find(Boolean) || "<empty error>";
      seeded.push(`${label}!FAILED(${firstLine.slice(0, 160)})`);
    }
  }

  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: `${marker} Metals`,
    contactName: `${marker} Buyer`,
    // N-SAFETY-1: unroutable by construction.
    email: `buyer@${marker.toLowerCase()}.example`,
    phone: "+91 00000 00042",
    whatsappNumber: "+91 00000 00042",
    status: "approved",
    source: "manual",
  });
  seeded.push("lead");

  const lineItems = [{
    id: `li_${marker}`,
    productName: `${marker} widget`,
    quantity: 2,
    unit: "box",
    unitPrice: 500,
    currencyCode: "INR",
    lineTotal: 1000,
  }] as import("@/lib/types").OrderLineItem[];

  // Business profile first, then ICP, then campaign. `icp.businessProfileId`
  // and `campaign.icpId` are real foreign keys on Postgres, so the flat
  // `campaign.create({workspaceId, name, status})` the first draft used could
  // never have worked on the substrate we ship on — it failed silently and the
  // campaign endpoints then "passed" with nothing to leak.
  const profile = await repos.businessProfile.create({
    workspaceId, companyName: `${marker} Metals Pvt Ltd`, industry: `${marker} industry`,
    description: `${marker} business description`, status: "approved",
    websiteUrl: `https://${marker.toLowerCase()}.example`,
  });
  seeded.push("businessProfile");

  let icpId = "";
  await step("icp", async () => {
    const [icp] = await repos.icp.createMany([{
      workspaceId, businessProfileId: profile.id, name: `${marker} ICP`,
      description: `${marker} ideal customer`, industries: [`${marker} industry`],
      buyerType: "distributor", geography: [`${marker} region`], companySizeBucket: "small company",
      likelyNeeds: [`${marker} need`], buyingTriggers: [`${marker} trigger`],
      painPoints: [`${marker} pain`], preferredChannels: ["whatsapp"], messagingAngles: [`${marker} angle`],
    }]);
    icpId = icp.id;
  });

  await step("campaign", () => repos.campaign.create({
    workspaceId, businessProfileId: profile.id, icpId, name: `${marker} campaign`,
    goal: `${marker} goal`, offer: `${marker} offer`, targetRegion: [`${marker} region`],
    productFocus: [`${marker} widget`], selectedChannels: ["whatsapp"],
    dailyOutreachLimit: 1, leadGoal: 1, status: "draft", approvalStatus: "needs_review",
  }));
  await step("order", () => repos.order.create({
    workspaceId, leadId: lead.id, status: "confirmed", lineItems, grandTotal: 1000, currencyCode: "INR", origin: "direct",
  }));
  await step("quote", () => repos.quote.create({
    workspaceId, leadId: lead.id, status: "sent", lineItems, grandTotal: 1000, currencyCode: "INR", notes: `${marker} quote note`,
  }));

  const ticket = await repos.ticket.create({
    workspaceId, leadId: lead.id, type: "complaint", priority: "high", status: "open",
    subject: `${marker} ticket subject`, description: `${marker} ticket description`, sourceChannel: "manual",
  });
  seeded.push("ticket");
  await step("ticketEvent", () => repos.ticketEvent.create({
    workspaceId, ticketId: ticket.id, eventType: "created", actorType: "system", note: `${marker} event`,
  }));

  await step("platformTicket", async () => {
    const pt = await repos.platformTicket.createWithNextNumber({
      workspaceId, raisedByUserId: ownerUserId,
      subject: `${marker} platform ticket`, description: `${marker} platform description`,
      category: "bug", priority: "medium", slaStartedAt: now, slaDueAt: now,
    });
    extraIds.platformTicket = [pt.id];
  });

  await step("crawlJob+page", async () => {
    const job = await repos.websiteCrawlJob.create({
      workspaceId, websiteUrl: `https://${marker.toLowerCase()}.example`, status: "completed",
      pagesFound: 1, pagesCrawled: 1, startedAt: now,
    });
    await repos.websiteCrawlPage.create({
      workspaceId, crawlJobId: job.id, url: `https://${marker.toLowerCase()}.example/about`,
      title: `${marker} about`, cleanedText: `${marker} crawled body text`,
    });
  });

  await step("knowledgeDoc+chunk", async () => {
    const doc = await repos.knowledgeBaseDocument.create(workspaceId, {
      title: `${marker} price list`, documentType: "price_list", status: "active",
      contentText: `${SECRET_PHRASE}. Internal reference ${marker}.`, metadata: {},
    });
    await repos.knowledgeBaseChunk.createMany(workspaceId, doc.id, [
      { chunkText: `${SECRET_PHRASE}. Internal reference ${marker}.`, chunkIndex: 0, metadata: {} },
    ]);
  });

  await step("autoReplyLog", () => repos.autoReplyLog.create(workspaceId, {
    leadId: lead.id, channel: "whatsapp", incomingMessage: `${marker} incoming`,
    retrievedContext: {}, generatedReply: `${marker} reply`, canAutoSend: false,
    needsHumanReview: true, status: "held_for_review",
  }));

  await step("copilotConversation", async () => {
    const convo = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId });
    extraIds.copilotConversation = [convo.id];
    await repos.ownerCopilotMessage.create({
      workspaceId, conversationId: convo.id, role: "owner", kind: "owner_input", text: `${marker} copilot message`,
    });
  });

  await step("mediaCatalogItem", () => repos.mediaCatalog.create(workspaceId, {
    title: `${marker} catalogue`, category: "catalog", fileName: `${marker}.pdf`, fileType: "application/pdf",
    fileSize: 1024, url: `/uploads/${marker}.pdf`, storagePath: `/uploads/${marker}.pdf`, status: "active",
  }));
  await step("whatsAppTemplate", () => repos.whatsAppTemplate.create(workspaceId, {
    name: `${marker}_template`, language: "en_US", status: "approved", body: `${marker} template body`,
  }));
  await step("reply", () => repos.reply.create({
    workspaceId, leadId: lead.id, channel: "whatsapp", rawText: `${marker} inbound message`, summary: `${marker} summary`,
  }));
  await step("outreachActivity", () => repos.outreachActivity.create({
    workspaceId, leadId: lead.id, channel: "whatsapp", direction: "outbound", status: "sent", sentManually: false, body: `${marker} outreach body`,
  }));
  // Integration ids are caller-supplied BY CONTRACT (see IntegrationRepository).
  await step("integration", () => repos.integration.create(workspaceId, {
    id: `integration_${marker}`, provider: "whatsapp_cloud", status: "connected",
    config: { note: `${marker} integration` },
  }));
  await step("salesSettings", () => repos.salesSettings.upsertForWorkspace(workspaceId, { defaultMOQ: `${marker} MOQ` }));
  await step("productSettings", () => repos.productSettings.upsertForWorkspace(workspaceId, {
    products: [{ id: `p_${marker}`, name: `${marker} product`, moq: "1 box", notes: `${marker} product notes` }],
  }));
  await step("policySettings", () => repos.policySettings.upsertForWorkspace(workspaceId, { returnReplacementPolicy: `${marker} return policy` }));
  await step("communicationSettings", () => repos.communicationSettings.upsertForWorkspace(workspaceId, { tone: `${marker} tone` }));
  await step("doNotContact", () => repos.doNotContact.create({
    id: `dnc_${marker}`, workspaceId, phone: "+91 00000 00043", reason: `${marker} opt-out`, createdAt: now,
  } as import("@/lib/types").DoNotContactEntry));
  await step("auditLog", () => repos.auditLog.create({
    workspaceId, actorUserId: ownerUserId, eventType: "probe.seeded", entityType: "lead", entityId: lead.id,
    payload: { marker },
  }));

  return { seeded, extraIds };
}

/* ------------------------------------------------------------------ *
 * 4. Results.
 * ------------------------------------------------------------------ */

type Row = { pattern: string; url: string; status: number; verdict: "PASS" | "FAIL" | "SKIP"; detail: string };
const rows: Row[] = [];
function record(pattern: string, url: string, status: number, verdict: Row["verdict"], detail: string) {
  rows.push({ pattern, url, status, verdict, detail });
}

async function main() {
  console.log(`\nStage 2 — tenant READ boundary, class check, against ${BASE}\n`);

  const status0 = await call("/api/auth/status");
  if (status0.json.authMode !== "production") {
    console.error(
      `ABORT: server reports authMode=${String(status0.json.authMode)}. This probe is meaningless outside production mode — demo mode hands every caller the same workspace.`,
    );
    process.exit(2);
  }

  /* ---- 4a. the substrate --------------------------------------------- */
  const { createRepositories, getPersistenceProvider } = await import("@/repositories");
  const repos = createRepositories();
  console.log(`persistence provider: ${getPersistenceProvider()}`);
  if (!repos.readAll) {
    console.error("ABORT: this repository bundle has no readAll(); the census cannot be built.");
    process.exit(2);
  }

  /* ---- 4b. two customers, signed up the way a customer signs up ------- */
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  /** One token, letters and digits only, so it survives the id tokenizer below. */
  const marker = `LEAKMARK${randomBytes(6).toString("hex")}`;

  async function signUp(label: string, slug: string) {
    const res = await call("/api/auth/signup", {
      method: "POST",
      body: {
        email: `boundary-${slug}-${stamp}@tenant-${slug}.example`,
        password: throwawayPassword(),
        name: `Boundary Probe ${label} Owner`,
        businessName: `Boundary probe ${label} ${stamp}`,
      },
    });
    if (res.status !== 200 && res.status !== 201) {
      console.error(`ABORT: could not create tenant ${label}. signup=${res.status} ${res.text.slice(0, 300)}`);
      process.exit(2);
    }
    const jarLocal = jarFrom(res.setCookie);
    const who = await call("/api/auth/status", { jar: jarLocal });
    const user = who.json.user as { workspaceId?: string; id?: string } | undefined;
    if (!user?.workspaceId || !user.id) {
      console.error(`ABORT: tenant ${label} signed up but carries no workspace/user on its session: ${who.text.slice(0, 300)}`);
      process.exit(2);
    }
    return { workspaceId: user.workspaceId, userId: user.id, jar: jarLocal };
  }

  const A = await signUp("A", "a");
  const B = await signUp("B", "b");
  const tenantA = A.workspaceId;
  const tenantB = B.workspaceId;
  const jar = A.jar;
  console.log(`tenant A (the reader, owns nothing): ${tenantA}`);
  console.log(`tenant B (the neighbour, seeded):    ${tenantB}`);

  const { seeded, extraIds } = await seedTenantB(repos, tenantB, B.userId, marker);
  const seedFailures = seeded.filter((s) => s.includes("!FAILED"));
  console.log(`seeded into B: ${seeded.filter((s) => !s.includes("!FAILED")).join(", ")}`);
  if (seedFailures.length) console.log(`seed FAILURES (these collections are NOT covered this run):\n  ${seedFailures.join("\n  ")}`);

  // A knowledge fact only tenant B knows. This is what the AI checks ask for.
  //
  // It has to hang off a REAL framework question: upsertKnowledgeEntry throws
  // "Invalid question key" for anything not in the 424-question framework, and
  // an invented key came back 500 — which silently left the AI checks with
  // nothing planted to find.
  const { getAllKnowledgeQuestions } = await import("@/knowledge/knowledge-question-framework");
  const plantQuestion = getAllKnowledgeQuestions()[0];
  const secretFact = `${SECRET_PHRASE}. Internal reference ${marker}.`;
  const synced = await call("/api/knowledge/sync", {
    method: "POST", jar: B.jar,
    body: { questionKey: plantQuestion.questionKey, domainKey: plantQuestion.domainKey, answer: secretFact },
  });
  console.log(`tenant B knowledge fact planted: ${synced.status === 200 ? `yes (${plantQuestion.domainKey}/${plantQuestion.questionKey})` : `NO (${synced.status}) ${synced.text.slice(0, 160)}`}`);

  /* ---- 4c. the foreign-identifier census ------------------------------ */
  // Read AFTER signup and seeding so tenant A's own rows are present and
  // correctly excluded, and B's new rows are present and correctly foreign.
  const snapshot = (await repos.readAll()) as unknown as Record<string, unknown>;

  const foreignIds = new Set<string>();
  const foreignWorkspaces = new Set<string>();
  const pools: Record<Pool, string[]> = {
    workspace: [], lead: [], campaign: [], order: [], quote: [], ticket: [],
    platformTicket: [], crawlJob: [], extractionRun: [], knowledgeDoc: [],
    autoReplyLog: [], copilotConversation: [],
  };
  const COLLECTION_POOL: Partial<Record<string, Pool>> = {
    workspaces: "workspace",
    leads: "lead",
    campaigns: "campaign",
    orders: "order",
    quotes: "quote",
    tickets: "ticket",
    platformTickets: "platformTicket",
    crawlJobs: "crawlJob",
    knowledgeExtractionRuns: "extractionRun",
    knowledgeBaseDocuments: "knowledgeDoc",
    autoReplyLogs: "autoReplyLog",
    ownerCopilotConversations: "copilotConversation",
  };

  /** Ids shorter than this are not distinctive enough to accuse anyone with. */
  const MIN_ID_LEN = 8;
  let foreignRecordCount = 0;
  for (const [collection, value] of Object.entries(snapshot)) {
    if (!Array.isArray(value)) continue;
    for (const item of value as Record<string, unknown>[]) {
      if (!item || typeof item !== "object") continue;
      const ws = collection === "workspaces" ? String(item.id ?? "") : String(item.workspaceId ?? "");
      if (!ws || ws === tenantA) continue;
      foreignWorkspaces.add(ws);
      foreignRecordCount += 1;
      const id = String(item.id ?? "");
      if (id.length >= MIN_ID_LEN) foreignIds.add(id);
      const pool = COLLECTION_POOL[collection];
      if (pool && id) pools[pool].push(id);
    }
  }
  for (const ws of foreignWorkspaces) if (ws.length >= MIN_ID_LEN) foreignIds.add(ws);

  console.log(`foreign workspaces:  ${foreignWorkspaces.size}  (tenant B plus every tenant already in the substrate)`);
  console.log(`foreign record ids:  ${foreignIds.size} distinct (from ${foreignRecordCount} rows)\n`);

  // Prefer ids belonging to tenant B specifically for the :id attacks; fall
  // back to any neighbour when B happens to own nothing of that kind.
  const bOnly: Record<Pool, string[]> = { ...pools };
  for (const [collection, pool] of Object.entries(COLLECTION_POOL) as [string, Pool][]) {
    const arr = (snapshot[collection] as Record<string, unknown>[] | undefined) ?? [];
    const mine = arr
      .filter((item) => String((collection === "workspaces" ? item?.id : item?.workspaceId) ?? "") === tenantB)
      .map((item) => String(item?.id ?? ""))
      .filter(Boolean);
    if (mine.length) bOnly[pool] = mine;
  }
  if (tenantB) bOnly.workspace = [tenantB];
  // Pools readAll() cannot supply (N-DATA-14). These ids came back from the
  // seeder itself, so they are tenant B's beyond doubt.
  for (const [pool, ids] of Object.entries(extraIds) as [Pool, string[]][]) {
    if (ids?.length) {
      bOnly[pool] = ids;
      for (const id of ids) if (id.length >= MIN_ID_LEN) foreignIds.add(id);
    }
  }

  /* ---- 4d. drift guard ------------------------------------------------ */
  const patterns = extractGetPatterns();
  console.log(`GET patterns found in route.ts: ${patterns.length}`);
  const unclassified = patterns.filter((p) => {
    const plan = planFor(p);
    return plan.kind === "skip" && plan.why.startsWith(UNCLASSIFIED_PREFIX);
  });
  if (unclassified.length) {
    console.log("\nDRIFT — parameterised GET route(s) added since this probe was written:");
    for (const p of unclassified) console.log(`  ${p}`);
    console.log('Add each to PLANS (usually kind:"denied" with the pool its id comes from).\n');
  }

  /* ---- 4e. call everything as tenant A -------------------------------- */
  /**
   * The foreign identifiers that appear anywhere in a response body.
   *
   * Two detectors, because they fail in different directions. The id scan
   * catches a record served whole. The marker catches a leak that surfaces
   * only a NAME — a company, a product, a document title — with no id
   * attached, which is what an aggregate or a search result looks like.
   */
  function leakedIn(text: string): string[] {
    const hits = new Set<string>();
    if (text.includes(marker)) hits.add(`${marker} (tenant B's marker string)`);
    for (const token of text.match(/[A-Za-z0-9_-]{8,}/g) ?? []) {
      if (foreignIds.has(token)) hits.add(token);
    }
    return [...hits];
  }

  for (const pattern of patterns) {
    const plan = planFor(pattern);
    if (plan.kind === "skip") {
      record(pattern, "-", 0, "SKIP", plan.why);
      continue;
    }

    const fill: Record<string, Pool> = plan.kind === "denied" ? plan.fill : plan.fill ?? {};
    let url = pattern;
    let missingPool = "";
    for (const [param, pool] of Object.entries(fill)) {
      const pick = bOnly[pool][0] ?? pools[pool][0];
      if (!pick) {
        missingPool = `${param} (${pool})`;
        break;
      }
      url = url.replace(param, encodeURIComponent(pick));
    }
    if (missingPool) {
      record(pattern, "-", 0, "SKIP", `no neighbour record to attack with for ${missingPool} — nothing of that kind exists outside tenant A.`);
      continue;
    }

    const res = await call(`/api/${url}`, { jar });
    const leaks = leakedIn(res.text);

    if (plan.kind === "denied") {
      if (res.status === 200 && leaks.length) {
        record(pattern, url, res.status, "FAIL", `served a NEIGHBOUR's record: ${leaks.slice(0, 4).join(", ")}`);
      } else if (res.status === 200) {
        // 200 with no foreign id in the body. NOT a pass by default: the route
        // answered a request naming somebody else's record, which means it
        // never checked ownership. What came back may still be built from that
        // record -- counts, totals, summaries -- and none of those carry an id
        // for leakedIn() to catch. The correct answer to a neighbour's id is a
        // refusal, so this is a failure unless a person has written down why.
        const byDesign = DENIED_200_ALLOWED[pattern];
        if (byDesign) {
          record(pattern, url, res.status, "PASS", `200 by design: ${byDesign}`);
        } else {
          record(
            pattern,
            url,
            res.status,
            "FAIL",
            "answered 200 to a NEIGHBOUR's id. No foreign id came back, but a 200 means ownership " +
              "was never checked, and derived facts (counts, totals, summaries) carry no id for this " +
              "probe to see. Fix the route, or name it in DENIED_200_ALLOWED with the reason.",
          );
        }
      } else {
        record(pattern, url, res.status, "PASS", "refused");
      }
      continue;
    }

    if (leaks.length) {
      record(pattern, url, res.status, "FAIL", `body carries ${leaks.length} foreign id(s): ${leaks.slice(0, 4).join(", ")}`);
    } else {
      record(pattern, url, res.status, "PASS", `${res.text.length} bytes, no foreign id`);
    }
  }

  /* ---- 4e-bis. the AI path, which is where leaks actually happen ------ */
  // A screen leaks by returning a row. An assistant leaks by ANSWERING. These
  // two ask tenant A's assistant for a fact that exists only in tenant B's
  // knowledge base; the correct behaviour is not to know it.
  //
  // The question names the phrase, never the marker (see SECRET_PHRASE). A
  // correct system answers "I have nothing on that" — tenant A genuinely does
  // not know it. A leaking system answers with B's row, and B's row carries the
  // marker.
  const askedAbout = `What do our records say about the ${SECRET_PHRASE}? Quote them exactly.`;

  const search = await call("/api/knowledge/search", { method: "POST", jar, body: { query: askedAbout } });
  const searchLeaks = leakedIn(search.text);
  record(
    "AI · POST knowledge/search",
    "knowledge/search",
    search.status,
    searchLeaks.length ? "FAIL" : "PASS",
    searchLeaks.length
      ? `retrieval returned tenant B's material: ${searchLeaks.slice(0, 4).join(", ")} | body: ${search.text.slice(0, 200)}`
      : `${search.text.length} bytes, tenant B's fact not retrieved`,
  );

  const convo = await call("/api/copilot/conversations", { jar });
  const conversationId = String(
    (convo.json.conversation as { id?: string })?.id ?? (convo.json as { id?: string }).id ?? "",
  );
  if (!conversationId) {
    record("AI · POST copilot/message", "copilot/message", convo.status, "SKIP", `could not open a copilot conversation: ${convo.text.slice(0, 160)}`);
  } else {
    // This is a REAL model call on the live key, so it is slow and it is billed.
    // It is also the only way to prove the assistant itself holds the line.
    const reply = await call("/api/copilot/message", {
      method: "POST", jar,
      body: { conversationId, text: askedAbout },
    });
    const replyLeaks = leakedIn(reply.text);
    record(
      "AI · POST copilot/message",
      "copilot/message",
      reply.status,
      replyLeaks.length ? "FAIL" : "PASS",
      replyLeaks.length
        ? `the assistant answered with tenant B's material: ${replyLeaks.slice(0, 4).join(", ")} | answer: ${reply.text.slice(0, 300)}`
        : `${reply.text.length} bytes, the assistant did not know tenant B's fact`,
    );
  }

  /* ---- 4f. report ----------------------------------------------------- */
  const failed = rows.filter((r) => r.verdict === "FAIL");
  const skipped = rows.filter((r) => r.verdict === "SKIP");
  const passed = rows.filter((r) => r.verdict === "PASS");

  console.log("--- FAILURES ---");
  if (!failed.length) console.log("  (none)");
  for (const r of failed) console.log(`  FAIL  ${r.pattern}\n        GET /api/${r.url} -> ${r.status}\n        ${r.detail}`);

  console.log("\n--- PASSED ---");
  for (const r of passed) console.log(`  PASS  ${r.pattern.padEnd(42)} ${String(r.status).padStart(3)}  ${r.detail}`);

  console.log("\n--- SKIPPED ---");
  for (const r of skipped) console.log(`  SKIP  ${r.pattern.padEnd(42)} ${r.detail}`);

  console.log(`\ntotals: ${passed.length} pass, ${failed.length} fail, ${skipped.length} skip, of ${patterns.length} GET patterns`);

  /* ---- 4g. clean up after myself -------------------------------------- */
  // Session 18 found 43 of 45 tenants in this database were probe debris.
  // A probe that leaves its fixtures behind is the thing that made readAll
  // slow. Both fixture tenants go, pass or fail.
  for (const [label, id] of [["A", tenantA], ["B", tenantB]] as const) {
    try {
      const del = await repos.workspace.delete(id);
      console.log(`cleanup: tenant ${label} workspace ${del.deleted ? "deleted" : "already gone"} (${id})`);
    } catch (error) {
      console.log(`cleanup: FAILED to delete tenant ${label} ${id} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed.length || unclassified.length) process.exit(1);
}

main().catch((error) => {
  console.error("PROBE FAILED:", error instanceof Error ? error.stack || error.message : error);
  process.exit(2);
});
