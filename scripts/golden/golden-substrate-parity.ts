/**
 * Golden test — SUBSTRATE PARITY (2026-08-05, audit finding F-1).
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * The independent audit of 2026-08-05 found the single largest structural risk
 * in this codebase:
 *
 *   Production runs `PERSISTENCE_PROVIDER=prisma`.
 *   `scripts/run-all-goldens.ts` force-pins 130 of 134 goldens to JSON.
 *   Only 4 goldens carry the PRISMA-golden opt-in marker (each requires a
 *   real Postgres connection for its whole run; this file is different — it
 *   drives one substrate at a time and only needs Postgres for its second
 *   half, hence its own HYBRID marker rather than that one).
 *
 * So every business rule this project has proven — scoring math, SLA math,
 * partial-cancel math, DNC state machine, knowledge priority — was proven
 * against `src/repositories/json/index.ts` (3,622 lines), while the code that
 * actually runs for a paying customer is `src/repositories/prisma/index.ts`
 * (3,835 lines). Two different files. The suite only ever exercised one.
 *
 * This is not theoretical. Audit finding A (2026-08-04) was: "Copilot was
 * completely broken in the configured Prisma runtime — every /copilot/* call
 * threw 500." That class of bug reached the operator as a P0 blocker instead
 * of as a red test, precisely because of this gap.
 *
 * ─── WHY NOT JUST RUN ALL 130 GOLDENS ON PRISMA ────────────────────────────
 *
 * Because that would fail for the WRONG reason and teach us nothing. A logic
 * golden asserts business arithmetic on a deterministic substrate; pointing it
 * at Neon makes it a network test that trips on foreign-key violations from
 * unseeded workspaces. `_helpers/provider.ts` documents that history at length
 * and its reasoning is correct.
 *
 * The real question is narrower and answerable:
 *
 *   >>> Do the two repository implementations behave IDENTICALLY for the same
 *   >>> sequence of operations?
 *
 * If yes, then a rule proven on JSON is proven on Prisma, and the existing
 * 130 logic goldens become transitively valid for production. If no, this test
 * names the exact method that diverges.
 *
 * That is what this file does: ONE operation script, run TWICE (once per
 * substrate), results normalised and deep-compared. It converts an unbounded
 * unknown ("does 3,835 lines of Prisma code work?") into a bounded, countable,
 * shrinking number.
 *
 * ─── WHAT IS NORMALISED (and why that is honest) ───────────────────────────
 *
 * Some differences between the substrates are legitimate and must not fail:
 *   - `createdAt`/`updatedAt` are wall-clock and differ between the two runs.
 *   - Prisma returns `Decimal` for `@db.Decimal` columns; JSON returns `number`.
 *     Both must COMPARE EQUAL NUMERICALLY — a Decimal that does not equal the
 *     JSON number is a real failure and is reported.
 *   - Field ORDER in an object is not semantic.
 *
 * Everything else — values, presence/absence of a key, array length, array
 * ORDER, undefined-vs-null, string-vs-number types — is compared strictly.
 * Ordering is deliberately NOT normalised: "listByWorkspace returns rows in a
 * different order" is exactly the kind of drift that silently breaks a UI.
 *
 * ─── HOW TO RUN ────────────────────────────────────────────────────────────
 *
 *   npm run golden:substrate-parity
 *
 * That script runs this file with `--import
 * ./scripts/golden/_helpers/isolate-json-data.ts` — see that file's header
 * for why the JSON-substrate isolation MUST be a preload rather than code in
 * this file (a real bug this file shipped with and fixed, not a style
 * preference).
 *
 * Requires a reachable Postgres `DATABASE_URL`. If the database is unreachable
 * the test exits NON-ZERO with a clear message. It never prints green for a run
 * it did not actually perform — that is the F-4 test-honesty rule applied to
 * this file. To acknowledge an offline DB deliberately (local dev without
 * Neon), pass `--allow-skip`, which exits 0 but prints a loud SKIPPED banner
 * and the word SKIPPED in the summary line.
 *
 * // HYBRID_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. This
 * golden manages BOTH substrates itself: it must NOT be force-pinned to JSON
 * (that would fight its own explicit createRepositories("prisma") call), but
 * DOES need JSON-side data isolation via _helpers/isolate-json-data.ts (see
 * that file's header — this golden shipped with a real bug where isolation
 * was attempted too late to take effect and polluted the shared demo file).
 *
 * Cleanup: every row is created under a unique `sp-<timestamp>` workspace and
 * removed in a `finally` block on both substrates.
 *
 * That sentence was FALSE until 2026-08-18 (N-DATA-2) and is worth keeping as
 * a warning. The finally block removed the leads but could not remove the
 * workspace itself — `WorkspaceRepository` had no `delete` method — so every
 * Prisma run left an `sp-*-ws` shell behind in the ship database. 15 had
 * accumulated before anyone measured it. A cleanup comment is a claim, and
 * this file's own test-honesty rule (F-4) applies to its comments too.
 */
import { createRepositories } from "../../src/repositories";
import type { RepositoryBundle } from "../../src/repositories/interfaces";

// ─── Harness ───────────────────────────────────────────────────────────────

type Substrate = "json" | "prisma";

/** One recorded observation: a labelled value captured from a repo call. */
type Observation = { step: string; value: unknown };

const ALLOW_SKIP = process.argv.includes("--allow-skip");

/**
 * Volatile keys that legitimately differ between two runs at two different
 * wall-clock instants. Dropped before comparison. Deliberately SHORT — every
 * entry here is a hole in the proof, so each one is justified inline.
 */
const VOLATILE_KEYS = new Set([
  "createdAt",   // wall clock
  "updatedAt",   // wall clock
  "lastSeenAt",  // wall clock
  "approvedAt",  // wall clock
  "resolvedAt",  // wall clock
  "firstResponseAt", // wall clock
]);

/**
 * Normalise a value so the two substrates are compared on SEMANTICS, not on
 * representation. See the header for the (short) list of what this forgives.
 */
function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null; // null/undefined unified: both mean "absent"
  if (typeof value === "bigint") return Number(value);
  // Prisma Decimal (and any object exposing toNumber/toFixed) → plain number.
  if (typeof value === "object" && value !== null) {
    const maybeDecimal = value as { toNumber?: () => number; constructor?: { name?: string } };
    if (typeof maybeDecimal.toNumber === "function" && maybeDecimal.constructor?.name === "Decimal") {
      return maybeDecimal.toNumber();
    }
    if (value instanceof Date) return "<date>"; // instant differs between runs by design
  }
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    // Sort keys so object key ORDER (not semantic) never causes a diff.
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const v = (value as Record<string, unknown>)[key];
      // An ISO timestamp string is as volatile as a Date object.
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        out[key] = "<date>";
        continue;
      }
      out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialise for comparison, with the substrate's own run id scrubbed out.
 *
 * Each substrate runs under a distinct run id (`sp-<ts>-json` vs
 * `sp-<ts>-prisma`) so the two never share rows. That id is embedded in the
 * ids we hand-assign (line-item ids, ticket ids), so it would otherwise show
 * up as a false divergence on every value that echoes an id back. Scrubbing it
 * compares the SHAPE and the SEMANTICS of the id (does the right id come back
 * in the right place?) without comparing the literal run-specific text.
 */
function stable(value: unknown, runId: string): string {
  return JSON.stringify(normalise(value)).split(runId).join("<run>");
}

// ─── The operation script (runs identically on both substrates) ────────────

/**
 * Drives one substrate through a fixed sequence of repository operations and
 * records an observation after each one. The SAME function runs against JSON
 * and against Prisma; any behavioural difference shows up as a diff.
 *
 * Coverage is deliberately concentrated on the repos the product actually
 * depends on in the revenue path: workspace → lead → quote → order → ticket →
 * reply, plus the erasure cascade (which is a compliance obligation).
 */
async function runScript(repos: RepositoryBundle, runId: string, obs: Observation[]): Promise<Observation[]> {
  // `obs` is passed IN (not created here) so that when a substrate throws
  // mid-script the caller still holds every observation recorded up to that
  // point — otherwise the failure report says "0 observations" and hides the
  // one thing worth knowing: how far it got before breaking.
  const record = (step: string, value: unknown) => obs.push({ step, value });

  // A THROW IS AN OBSERVATION, NOT AN ABORT.
  //
  // First version of this file let the first failing call kill the run, which
  // meant one broken method hid every method after it — the same "one defect
  // masks the rest" problem the audit criticised elsewhere. Now every call is
  // probed: if it throws, the error is recorded as that step's value and the
  // script continues. A method that throws on Prisma but returns on JSON is
  // then reported as an ordinary divergence, in context, alongside all the
  // others. One run now yields the COMPLETE defect list.
  const brief = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    // Prisma messages are long and echo the whole payload (including our
    // run-specific ids). Keep the diagnostic line only, so the comparison is
    // about WHETHER and WHY it threw, not about incidental formatting.
    const unknownArg = raw.match(/Unknown argument `(\w+)`/);
    if (unknownArg) return `threw: unknown field '${unknownArg[1]}'`;
    const missingArg = raw.match(/Argument `(\w+)` is missing/);
    if (missingArg) return `threw: missing required field '${missingArg[1]}'`;
    const constraint = raw.match(/Foreign key constraint|Unique constraint/i);
    if (constraint) return `threw: ${constraint[0]}`;
    return `threw: ${raw.split("\n")[0].trim().slice(0, 120)}`;
  };
  /** Run a repo call, recording either its value or the way it failed. */
  const probe = async (step: string, fn: () => unknown): Promise<void> => {
    try { record(step, await fn()); } catch (e) { record(step, brief(e)); }
  };
  /** Run a setup call whose return value we don't assert, without aborting. */
  const setup = async <T>(step: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e) { record(`${step}[setup]`, brief(e)); return undefined; }
  };
  void setup;

  const WS = `${runId}-ws`;
  const LEAD_A = `${runId}-lead-a`;
  const LEAD_B = `${runId}-lead-b`;
  const PROFILE = `${runId}-profile`;
  const CAMPAIGN = `${runId}-campaign`;
  const TICKET = `${runId}-ticket`;
  const now = new Date().toISOString();

  // N-TEST-10 (2026-08-26, S30). Every fixture below this line used to end in
  // `as never` — 22 of them. The board expected these to be deliberate stand-ins
  // that needed NARROWING; the compiler says otherwise. All 22 were stripped in
  // one pass and `tsc --noEmit` reported ZERO errors, so not one of them was
  // silencing anything: they were cargo-cult, copied site to site, and the three
  // real fixture lies they were nominally covering had already been fixed in
  // S24-18. They are gone.
  //
  // What that buys, concretely: `as never` suppresses excess-property checking,
  // so a typo'd or invented key was accepted silently. Receipt m39 — adding
  // `nmae: "typo"` to the workspace.update fixture below now raises
  // `TS2353: 'nmae' does not exist`; the identical typo on the pre-strip file
  // produced ZERO errors in the file.
  //
  // What it does NOT buy, and this is the honest limit: these repository methods
  // take `Partial<T>`, so a fixture that OMITS a required field still compiles
  // (L30, and S22-5 is what that costs). The reason that gap is closed HERE and
  // not elsewhere is that this golden genuinely runs both passes — the Prisma
  // pass is real, against real Postgres, so a NOT NULL column left unset fails
  // the run rather than hiding. In a JSON-only golden the same omission would be
  // invisible. Do not copy these fixtures into one.

  // ── Workspace ────────────────────────────────────────────────────────────
  await setup("workspace.create", () => repos.workspace.create({
    id: WS, name: "Substrate Parity WS", industry: "Testing",
    createdAt: now, updatedAt: now,
  }));
  await probe("workspace.getById.name", async () => (await repos.workspace.getById(WS))?.name);
  await probe("workspace.getById.industry", async () => (await repos.workspace.getById(WS))?.industry);
  await probe("workspace.getById.status", async () => (await repos.workspace.getById(WS))?.status);
  await probe("workspace.update.name", async () => {
    await repos.workspace.update(WS, { name: "Renamed WS" });
    return (await repos.workspace.getById(WS))?.name;
  });

  // ── Leads ────────────────────────────────────────────────────────────────
  // Hand-set values so any silent default-substitution by either substrate
  // shows up immediately.
  // N-SAFETY-3 (2026-08-18): these numbers used to be `+91 98765 43210` and
  // `+919812345678` — structurally valid Indian mobiles. Unlike every other
  // golden that holds a realistic number as a pure test input, THIS one writes
  // through `createRepositories("prisma")` into the database we ship on, so for
  // the length of each run those rows were live contact data in the real DB.
  // Now `+91 00000 000NN`: an Indian mobile never has 0 as its first subscriber
  // digit, so these are unroutable BY CONSTRUCTION (N-SAFETY-1) and no send test
  // that ever raced a golden run could reach a human. Safe to change because
  // phone matching is a pure digit-strip (`findLeadByPhone`) — no country-code
  // insertion, no leading-zero handling — so the spellings below still exercise
  // exactly what they exercised before.
  for (const [id, company, phone] of [
    [LEAD_A, "Aarna Bridal Studio", "+91 00000 00010"],
    [LEAD_B, "Meera Ethnic Wear", "+910000000011"],
  ] as const) {
    await setup(`lead.createLead[${company}]`, () => repos.lead.createLead({
      id, workspaceId: WS, companyName: company, source: "golden_test",
      status: "prospected", reviewStatus: "pending", enrichmentStatus: "not_started",
      confidenceScore: 0.5, qualificationStatus: "mql", leadScore: 0, fitScore: 0,
      phone, whatsappNumber: phone, city: "Surat", industry: "Textiles",
      createdAt: now, updatedAt: now,
    }));
  }

  await probe("lead.getLeadById.companyName", async () => (await repos.lead.getLeadById(WS, LEAD_A))?.companyName);
  await probe("lead.getLeadById.city", async () => (await repos.lead.getLeadById(WS, LEAD_A))?.city);
  await probe("lead.getLeadById.confidenceScore", async () => (await repos.lead.getLeadById(WS, LEAD_A))?.confidenceScore);
  await probe("lead.getLeadById.qualificationStatus", async () => (await repos.lead.getLeadById(WS, LEAD_A))?.qualificationStatus);

  // N11 (2026-09-19) — a field NOBODY SET must read the same on both sides.
  //
  // Every lead probe above sets a value first, so none of them can see the
  // failure this one exists for: Postgres turns a NULL JSON column into {},
  // which is truthy, while the JSON substrate leaves the field undefined. Both
  // "have" the field and they disagree about whether it is there — so a screen
  // that asks "do we know anything about this buyer?" answers yes on production
  // and no in demo mode, for the same lead, with no error anywhere.
  await probe("lead.getLeadById.discoveryState[never set]", async () =>
    (await repos.lead.getLeadById(WS, LEAD_A))?.discoveryState ?? null);
  await probe("lead.getLeadById.discoveryState[roundtrip]", async () => {
    await repos.lead.updateLead(WS, LEAD_A, { discoveryState: { volume: { value: "200 kg", answeredAt: "2026-09-19T00:00:00.000Z" } } });
    return (await repos.lead.getLeadById(WS, LEAD_A))?.discoveryState;
  });

  // N12 — lines added to one lead; unset must read as unset on both sides.
  await probe("lead.getLeadById.discoveryExtras[never set]", async () =>
    (await repos.lead.getLeadById(WS, LEAD_A))?.discoveryExtras ?? null);
  await probe("lead.getLeadById.discoveryExtras[roundtrip]", async () => {
    await repos.lead.updateLead(WS, LEAD_A, { discoveryExtras: [{ key: "sample_reached", label: "Did the sample reach?", lookFor: "Did the sample reach?", exampleAsk: "", priority: 1 }] });
    return (await repos.lead.getLeadById(WS, LEAD_A))?.discoveryExtras;
  });

  // 2026-09-23 — reply-log fields. acknowledgementSent was stored by NEITHER
  // substrate since CP-22; aiDraft/ownerEdited are N5's record of a correction.
  await probe("autoReplyLog.acknowledgementSent[roundtrip]", async () => {
    const log = await repos.autoReplyLog.create(WS, { channel: "whatsapp", incomingMessage: "price?", status: "acknowledged", acknowledgementSent: true, canAutoSend: false, needsHumanReview: true });
    return (await repos.autoReplyLog.getById(WS, log.id))?.acknowledgementSent;
  });
  await probe("autoReplyLog.approve.keepsDraft", async () => {
    const log = await repos.autoReplyLog.create(WS, { channel: "manual", incomingMessage: "delivery?", generatedReply: "AI text", status: "held_for_review", canAutoSend: false, needsHumanReview: true });
    await repos.autoReplyLog.approve(WS, log.id, { generatedReply: "Owner text", aiDraft: "AI text", ownerEdited: true });
    const after = await repos.autoReplyLog.getById(WS, log.id);
    return { sent: after?.generatedReply, aiDraft: after?.aiDraft, ownerEdited: after?.ownerEdited, status: after?.status };
  });
  await probe("autoReplyLog.unedited[defaults]", async () => {
    const log = await repos.autoReplyLog.create(WS, { channel: "manual", incomingMessage: "hi", status: "drafted", canAutoSend: false, needsHumanReview: true });
    const after = await repos.autoReplyLog.getById(WS, log.id);
    return { ack: Boolean(after?.acknowledgementSent), aiDraft: after?.aiDraft ?? null, ownerEdited: Boolean(after?.ownerEdited) };
  });

  // 2026-09-24 — the owner's abusive-customer rule has its own field; it must
  // survive a write-back of the whole row on both substrates, like its siblings.
  await probe("communicationSettings.rules[roundtrip]", async () => {
    await repos.communicationSettings.upsertForWorkspace(WS, { complaintReplyRule: "Apologise, then hand over", abusiveMessageRule: "Do not argue; hand to a person" });
    await repos.communicationSettings.upsertForWorkspace(WS, { tone: "warm" });
    const after = await repos.communicationSettings.getByWorkspace(WS);
    return { complaint: after?.complaintReplyRule, abusive: after?.abusiveMessageRule, tone: after?.tone };
  });

  // 2026-09-24 — an opt-out matches the same subscriber however the number is
  // written: Postgres filters with endsWith, JSON compares in code; they must
  // agree on every spelling, including the ones that must NOT match.
  await probe("doNotContact.phoneSpellings", async () => {
    await repos.doNotContact.create({ id: `dnc_sp_${Date.now()}`, workspaceId: WS, normalizedPhone: "910000000061", reason: "stop via WhatsApp", createdAt: new Date().toISOString() });
    await repos.doNotContact.create({ id: `dnc_sp_short_${Date.now()}`, workspaceId: WS, normalizedPhone: "+12345", reason: "short code", createdAt: new Date().toISOString() });
    const hit = async (normalizedPhone: string) => Boolean(await repos.doNotContact.findMatch(WS, { normalizedPhone }));
    return {
      withPlus: await hit("+910000000061"),
      national: await hit("0000000061"),
      trunkZero: await hit("00000000061"),
      differentPerson: await hit("910000000062"),
      shortExact: await hit("12345"),
      shortSuffixOfLong: await hit("33333"),
    };
  });
  await probe("doNotContact.removeMatching[anySpelling]", async () => {
    await repos.doNotContact.create({ id: `dnc_rm_${Date.now()}`, workspaceId: WS, normalizedPhone: "+910000000063", reason: "stop", createdAt: new Date().toISOString() });
    const removed = await repos.doNotContact.removeMatching(WS, { normalizedPhone: "0000000063" });
    return { removed, stillThere: Boolean(await repos.doNotContact.findMatch(WS, { normalizedPhone: "910000000063" })) };
  });

  // N8 (2026-09-23) — the claim that stops a double-click running a paid plan
  // twice. On Postgres it is one conditional UPDATE; on JSON a serialised
  // write. Both must let exactly one claimant through.
  await probe("jobRun.claim[once]", async () => {
    const job = await repos.jobRun.create({ workspaceId: WS, jobType: "orchestration", status: "awaiting_confirmation", payload: { goal: "parity" } as never, attempts: 0, maxAttempts: 1 });
    const results = await Promise.all([
      repos.jobRun.claim(WS, job.id, "awaiting_confirmation", "running"),
      repos.jobRun.claim(WS, job.id, "awaiting_confirmation", "running"),
    ]);
    const after = await repos.jobRun.getById(WS, job.id);
    return { winners: results.filter(Boolean).length, status: after?.status };
  });
  await probe("jobRun.claim[wrong workspace]", async () => {
    const job = await repos.jobRun.create({ workspaceId: WS, jobType: "orchestration", status: "awaiting_confirmation", payload: {} as never, attempts: 0, maxAttempts: 1 });
    return repos.jobRun.claim("workspace_does_not_exist", job.id, "awaiting_confirmation", "running");
  });
  await probe("jobRun.update+getById", async () => {
    const job = await repos.jobRun.create({ workspaceId: WS, jobType: "orchestration", status: "running", payload: {} as never, attempts: 0, maxAttempts: 1 });
    await repos.jobRun.update(WS, job.id, { status: "partial", result: { text: "two of three done" } as never });
    const after = await repos.jobRun.getById(WS, job.id);
    return { status: after?.status, result: after?.result, other: await repos.jobRun.getById("workspace_does_not_exist", job.id) ?? null };
  });

  // 2026-09-23 — WhatsApp settings that JSON kept and Postgres silently
  // dropped since 2026-08-02 (CP-22, CP-23): no column, and the repository
  // payload never named them. No probe touched this record, so nothing could
  // see an owner's "acknowledge sensitive questions: ON" reload as OFF on the
  // substrate we ship on. The N12 checklist rides on the same record.
  await probe("whatsAppAgentSettings.lostFields[never set]", async () => {
    const settings = await repos.whatsAppAgentSettings.upsertForWorkspace(WS, { enabled: false, mode: "draft_only" });
    return {
      autoAcknowledgeSensitive: Boolean(settings.autoAcknowledgeSensitive),
      messageBatchingEnabled: Boolean(settings.messageBatchingEnabled),
      autoReplyTopics: settings.autoReplyTopics ?? [],
      acknowledgementTemplate: settings.acknowledgementTemplate || null,
      discoveryChecklist: settings.discoveryChecklist ?? null,
    };
  });
  await probe("whatsAppAgentSettings.lostFields[roundtrip]", async () => {
    await repos.whatsAppAgentSettings.upsertForWorkspace(WS, {
      autoAcknowledgeSensitive: true,
      acknowledgementTemplate: "Thank you — the owner will confirm this personally.",
      messageBatchingEnabled: true,
      autoReplyTopics: ["greeting", "moq_request"],
      discoveryChecklist: { spine: [{ key: "do_they_export", label: "Do they export?", lookFor: "Do they export?", exampleAsk: "", priority: 1 }], segments: {}, decidedAt: "2026-09-23T00:00:00.000Z" },
    });
    const settings = await repos.whatsAppAgentSettings.getByWorkspace(WS);
    return {
      autoAcknowledgeSensitive: settings?.autoAcknowledgeSensitive,
      acknowledgementTemplate: settings?.acknowledgementTemplate,
      messageBatchingEnabled: settings?.messageBatchingEnabled,
      autoReplyTopics: settings?.autoReplyTopics,
      discoveryChecklist: settings?.discoveryChecklist,
    };
  });

  // Cross-workspace isolation: a foreign workspace id must never resolve.
  await probe("lead.getLeadById.wrongWorkspace", () => repos.lead.getLeadById("workspace_does_not_exist", LEAD_A));

  await probe("lead.listLeads.count", async () => (await repos.lead.listLeads(WS)).length);
  await probe("lead.listLeads.order", async () => (await repos.lead.listLeads(WS)).map((l) => l.companyName));

  // Phone normalisation is a documented chokepoint (golden:find-lead-by-phone).
  // All spellings of the same number must resolve to the same lead on BOTH
  // substrates — this is the path an inbound WhatsApp webhook takes.
  // Same four spellings as before, renumbered under N-SAFETY-3: spaced-with-
  // plus, bare digits with country code, compact with plus, and the bare
  // 10-digit local form — which does NOT resolve, because matching is a pure
  // digit-strip with no country-code insertion. That miss is part of what the
  // parity check pins: both substrates must miss it identically.
  for (const spelling of ["+91 00000 00010", "910000000010", "+910000000010", "00000 00010"]) {
    await probe(`lead.findLeadByPhone[${spelling}]`, async () => (await repos.lead.findLeadByPhone(WS, spelling))?.companyName ?? null);
  }
  // A number no lead holds — must resolve to null on both substrates. Kept
  // inside the same unroutable +91 00000 000NN range (N-SAFETY-3) rather than
  // the old `+10000000000`, so this file has exactly ONE allowed phone shape
  // and no reader has to decide whether a second shape is safe. 99 is outside
  // the 10/11/12 the leads above use, so it is still guaranteed not to match.
  await probe("lead.findLeadByPhone[unknown]", async () => (await repos.lead.findLeadByPhone(WS, "+910000000099"))?.companyName ?? null);

  await probe("lead.updateLeadScore.leadScore", async () => {
    await repos.lead.updateLeadScore(WS, LEAD_A, { leadScore: 17, fitScore: 8 });
    return (await repos.lead.getLeadById(WS, LEAD_A))?.leadScore;
  });
  await probe("lead.updateLeadScore.fitScore", async () => (await repos.lead.getLeadById(WS, LEAD_A))?.fitScore);

  await probe("lead.approveLead.reviewStatus", async () => (await repos.lead.approveLead(WS, LEAD_A)).reviewStatus);
  await probe("lead.rejectLead.reviewStatus", async () => (await repos.lead.rejectLead(WS, LEAD_B)).reviewStatus);
  await probe("lead.listLeads[approved].count", async () => (await repos.lead.listLeads(WS, { reviewStatus: "approved" })).length);

  // Multi-number support (6C-1). Idempotent add must not duplicate.
  await probe("lead.addLeadPhoneNumber.number", async () => (await repos.lead.addLeadPhoneNumber(WS, LEAD_A, { number: "+910000000012", type: "whatsapp" })).number);
  await probe("lead.addLeadPhoneNumber.idempotentCount", async () => {
    await repos.lead.addLeadPhoneNumber(WS, LEAD_A, { number: "+910000000012", type: "whatsapp" });
    return (await repos.lead.listLeadPhoneNumbers(WS, LEAD_A)).length;
  });

  // ── Business profile / ICP / campaign (the onboarding spine) ─────────────
  await setup("businessProfile.create", () => repos.businessProfile.create({
    id: PROFILE, workspaceId: WS, companyName: "Balaji Zari Udyog",
    industry: "Textile manufacturing", businessType: "Manufacturer",
    products: ["Zari lace", "Decorative borders"], city: "Surat",
    createdAt: now, updatedAt: now,
  }));
  await probe("businessProfile.getByWorkspace.companyName", async () => (await repos.businessProfile.getByWorkspace(WS))?.companyName);
  await probe("businessProfile.getByWorkspace.products", async () => (await repos.businessProfile.getByWorkspace(WS))?.products);
  await probe("businessProfile.getByWorkspace.industry", async () => (await repos.businessProfile.getByWorkspace(WS))?.industry);
  await probe("businessProfile.getByWorkspace.city", async () => (await repos.businessProfile.getByWorkspace(WS))?.city);
  await probe("businessProfile.update.businessType", async () => {
    await repos.businessProfile.update(WS, PROFILE, { businessType: "Exporter" });
    return (await repos.businessProfile.getByWorkspace(WS))?.businessType;
  });
  await probe("businessProfile.approve.status", async () => (await repos.businessProfile.approve(WS, PROFILE)).status);
  // N13 (2026-09-25): the owner's checklist choice must round-trip on both
  // substrates. persistSnapshot does NOT write businessProfiles, so this goes
  // through the repository — the only path that saves it.
  await probe("businessProfile.update.checklist", async () => {
    await repos.businessProfile.update(WS, PROFILE, { checklistKinds: ["manufacturer", "trader"], checklistExports: true, checklistConfirmedAt: "2026-09-25T10:00:00.000Z" });
    const saved = await repos.businessProfile.getByWorkspace(WS);
    return { kinds: saved?.checklistKinds, exports: saved?.checklistExports, confirmedAt: saved?.checklistConfirmedAt };
  });

  // RULE A (docs/LOGIC.md): replacing a list ARCHIVES the old rows rather than
  // deleting them, and the normal list query filters archives out. Round 1 has
  // 2 ICPs, round 2 has 3 → the list must return 3, never 5.
  await setup("icp.createMany", () => repos.icp.createMany([
    { id: `${runId}-icp-1`, workspaceId: WS, businessProfileId: PROFILE, name: "Bridal boutiques", createdAt: now, updatedAt: now },
    { id: `${runId}-icp-2`, workspaceId: WS, businessProfileId: PROFILE, name: "Saree wholesalers", createdAt: now, updatedAt: now },
  ]));
  await probe("icp.createMany.listCount", async () => (await repos.icp.listByWorkspace(WS)).length);
  await setup("icp.replaceForBusinessProfile", () => repos.icp.replaceForBusinessProfile(WS, PROFILE, [
    { id: `${runId}-icp-3`, workspaceId: WS, businessProfileId: PROFILE, name: "Export houses", createdAt: now, updatedAt: now },
    { id: `${runId}-icp-4`, workspaceId: WS, businessProfileId: PROFILE, name: "Garment makers", createdAt: now, updatedAt: now },
    { id: `${runId}-icp-5`, workspaceId: WS, businessProfileId: PROFILE, name: "Trim retailers", createdAt: now, updatedAt: now },
  ]));
  await probe("icp.replaceForBusinessProfile.listCount", async () => (await repos.icp.listByWorkspace(WS)).length); // RULE A: 3, not 5
  await probe("icp.replaceForBusinessProfile.names", async () => (await repos.icp.listByWorkspace(WS)).map((i) => i.name));
  await probe("icp.select.status", async () => (await repos.icp.select(WS, `${runId}-icp-3`)).status);
  await probe("icp.reject.status", async () => (await repos.icp.reject(WS, `${runId}-icp-4`)).status);
  // 2026-09-25 — an ICP created with "not for" rules keeps them. JSON dropped
  // them on create (Postgres kept them), so a restored backup lost them. Read
  // back by id, after every list-count probe above, so it moves no count.
  await probe("icp.createMany.exclusions[roundtrip]", async () => {
    await repos.icp.createMany([{ id: `${runId}-icp-x`, workspaceId: WS, businessProfileId: PROFILE, name: "Parity ICP", exclusions: ["manufactures zari themselves"], createdAt: now, updatedAt: now }]);
    return (await repos.icp.getById(WS, `${runId}-icp-x`))?.exclusions;
  });

  await setup("campaign.create", () => repos.campaign.create({
    id: CAMPAIGN, workspaceId: WS,
    businessProfileId: PROFILE, icpId: `${runId}-icp-3`,
    name: "Surat bridal Q3", status: "draft", targetRegion: ["Surat", "Mumbai"],
    productFocus: ["Gold border"], dailyOutreachLimit: 20, leadGoal: 50,
    createdAt: now, updatedAt: now,
  }));
  await probe("campaign.getById.name", async () => (await repos.campaign.getById(WS, CAMPAIGN))?.name);
  await probe("campaign.getById.targetRegion", async () => (await repos.campaign.getById(WS, CAMPAIGN))?.targetRegion);
  await probe("campaign.getById.dailyOutreachLimit", async () => (await repos.campaign.getById(WS, CAMPAIGN))?.dailyOutreachLimit);
  await probe("campaign.approve.status", async () => (await repos.campaign.approve(WS, CAMPAIGN)).approvalStatus);
  await probe("campaign.listByWorkspace.count", async () => (await repos.campaign.listByWorkspace(WS)).length);

  // ── Message templates / outreach activity ────────────────────────────────
  await setup("messageTemplate.create", () => repos.messageTemplate.create({
    id: `${runId}-tmpl`, workspaceId: WS, campaignId: CAMPAIGN,
    channel: "whatsapp", body: "Namaste {{name}}, gold border sample?",
    status: "draft", createdAt: now, updatedAt: now,
  }));
  await probe("messageTemplate.getById.body", async () => (await repos.messageTemplate.getById(WS, `${runId}-tmpl`))?.body);
  await probe("messageTemplate.getById.channel", async () => (await repos.messageTemplate.getById(WS, `${runId}-tmpl`))?.channel);
  await probe("messageTemplate.update.status", async () => {
    await repos.messageTemplate.update(WS, `${runId}-tmpl`, { status: "approved" });
    return (await repos.messageTemplate.getById(WS, `${runId}-tmpl`))?.status;
  });
  await probe("messageTemplate.listByWorkspace.count", async () => (await repos.messageTemplate.listByWorkspace(WS)).length);

  await setup("outreachActivity.create", () => repos.outreachActivity.create({
    id: `${runId}-outreach`, workspaceId: WS, leadId: LEAD_A, campaignId: CAMPAIGN,
    channel: "whatsapp", direction: "outbound", status: "drafted", sentManually: false,
    body: "Namaste, sharing our gold border catalogue.", activityAt: now,
    createdAt: now, updatedAt: now,
  }));
  await probe("outreachActivity.listByLead.count", async () => (await repos.outreachActivity.listByLead(WS, LEAD_A)).length);
  await probe("outreachActivity.listByLead.status", async () => (await repos.outreachActivity.listByLead(WS, LEAD_A))[0]?.status);
  await probe("outreachActivity.listByWorkspace.count", async () => (await repos.outreachActivity.listByWorkspace(WS)).length);

  // ── Quotes: sequential numbering + money ─────────────────────────────────
  // Hand-computed: 250 units x Rs.38 = Rs.9,500. Same arithmetic as the Copilot
  // quote golden, so a divergence here is visible in the revenue path.
  const quoteLine = {
    id: `${runId}-qline`, productName: "Gold Border 75mm", quantity: 250,
    unit: "m", unitPrice: 38, currencyCode: "INR", lineTotal: 9500,
  };
  for (let i = 0; i < 2; i++) {
    await probe(`quote.nextQuoteNumber[${i}]`, async () => {
      const n = await repos.quote.nextQuoteNumber(WS);
      await repos.quote.create({
        id: `${runId}-quote-${i}`, workspaceId: WS, leadId: LEAD_A, quoteNumber: n,
        status: "draft", lineItems: [quoteLine], grandTotal: 9500, currencyCode: "INR",
        createdAt: now, updatedAt: now,
      });
      return n;
    });
  }
  await probe("quote.getById.grandTotal", async () => (await repos.quote.getById(WS, `${runId}-quote-0`))?.grandTotal);
  await probe("quote.getById.currencyCode", async () => (await repos.quote.getById(WS, `${runId}-quote-0`))?.currencyCode);
  await probe("quote.getById.lineItems", async () => (await repos.quote.getById(WS, `${runId}-quote-0`))?.lineItems);
  await probe("quote.listByLead.count", async () => (await repos.quote.listByLead(WS, LEAD_A)).length);
  await probe("quote.listByWorkspace[draft].count", async () => (await repos.quote.listByWorkspace(WS, { status: "draft" })).length);

  // ── Orders: sequential numbering + partial-cancel persistence ────────────
  // Hand-computed: 12 units x Rs.450 = Rs.5,400.
  const orderLine = {
    id: `${runId}-oline`, productName: "Zari Thread", quantity: 12,
    unit: "kg", unitPrice: 450, currencyCode: "INR", lineTotal: 5400,
  };
  for (let i = 0; i < 2; i++) {
    await probe(`order.nextOrderNumber[${i}]`, async () => {
      const n = await repos.order.nextOrderNumber(WS);
      await repos.order.create({
        id: `${runId}-order-${i}`, workspaceId: WS, leadId: LEAD_A, orderNumber: n,
        status: "draft", lineItems: [orderLine], grandTotal: 5400, currencyCode: "INR",
        origin: "direct", createdAt: now, updatedAt: now,
      });
      return n;
    });
  }
  await probe("order.getById.grandTotal", async () => (await repos.order.getById(WS, `${runId}-order-0`))?.grandTotal);
  await probe("order.getById.origin", async () => (await repos.order.getById(WS, `${runId}-order-0`))?.origin);
  await probe("order.getById.lineItems", async () => (await repos.order.getById(WS, `${runId}-order-0`))?.lineItems);

  // cancelledQuantityByLine was a real schema-drift bug once (JSON had it,
  // Prisma did not). Pin the round-trip on both so it cannot regress.
  // N-TEST-10 (2026-08-26, S28). This said `status: "partially_cancelled"`,
  // which is not an OrderStatus — the real value is "partial_cancelled"
  // (src/lib/types.ts, and the transition table in src/lib/status-transitions.ts
  // is keyed on it). `as never` on the payload is what let it through. Because
  // orders.status is a plain String column on Postgres, BOTH substrates stored
  // the invented word and the probe went green, so this line certified a
  // round-trip of a status the product can never produce. The cast is gone from
  // this site on purpose: it is the only thing standing between a typo and a
  // green parity run.
  await probe("order.update.status", async () => (await repos.order.update(WS, `${runId}-order-0`, {
    status: "partial_cancelled",
    cancelledQuantityByLine: { [orderLine.id]: 4 },
  })).status);
  await probe("order.update.cancelledQuantityByLine", async () => (await repos.order.getById(WS, `${runId}-order-0`))?.cancelledQuantityByLine);
  await probe("order.listByLead.count", async () => (await repos.order.listByLead(WS, LEAD_A)).length);

  // ── Tickets: numbering + filtered listing ────────────────────────────────
  await probe("ticket.nextTicketNumber", async () => {
    const n = await repos.ticket.nextTicketNumber(WS);
    await repos.ticket.create({
      id: TICKET, workspaceId: WS, leadId: LEAD_A, ticketNumber: n,
      type: "complaint", priority: "high", subject: "Border shade mismatch",
      description: "Customer says the gold is duller than the sample.",
      sourceChannel: "whatsapp", status: "open", createdAt: now, updatedAt: now,
    });
    return n;
  });
  await probe("ticket.getById.type", async () => (await repos.ticket.getById(WS, TICKET))?.type);
  await probe("ticket.getById.priority", async () => (await repos.ticket.getById(WS, TICKET))?.priority);
  await probe("ticket.getById.status", async () => (await repos.ticket.getById(WS, TICKET))?.status);
  await probe("ticket.getById.subject", async () => (await repos.ticket.getById(WS, TICKET))?.subject);
  await probe("ticket.getByTicketNumber.id", async () => {
    const t = await repos.ticket.getById(WS, TICKET);
    return t ? (await repos.ticket.getByTicketNumber(WS, t.ticketNumber))?.id : null;
  });
  await probe("ticket.listOpenTickets.count", async () => (await repos.ticket.listOpenTickets(WS)).length);
  await probe("ticket.listByWorkspace[open].count", async () => (await repos.ticket.listByWorkspace(WS, { status: "open" })).length);
  await probe("ticket.listByWorkspace[resolved].count", async () => (await repos.ticket.listByWorkspace(WS, { status: "resolved" })).length);

  // ── Ticket events + SLA settings (were Prisma stubs once; keep them pinned) ─
  // N-TEST-10 (2026-08-26, S28). `updatedAt` was in this payload and TicketEvent
  // has no such field — not in src/lib/types.ts and not in the ticket_events
  // table. The Prisma repository picks its columns explicitly so it dropped the
  // key; the JSON repository spreads, so it kept it. This fixture was quietly
  // manufacturing the exact substrate divergence the file exists to detect, on a
  // field no probe below ever reads. Removed, cast removed with it.
  await setup("ticketEvent.create", () => repos.ticketEvent.create({
    id: `${runId}-tevent`, workspaceId: WS, ticketId: TICKET,
    eventType: "created", actorType: "system", note: "Auto-created from WhatsApp.",
    createdAt: now,
  }));
  await probe("ticketEvent.listByTicket.count", async () => (await repos.ticketEvent.listByTicket(WS, TICKET)).length);
  await probe("ticketEvent.listByTicket.eventType", async () => (await repos.ticketEvent.listByTicket(WS, TICKET))[0]?.eventType);
  await probe("ticketEvent.listByTicket.actorType", async () => (await repos.ticketEvent.listByTicket(WS, TICKET))[0]?.actorType);

  await probe("ticketSlaSettings.upsert.urgentSlaMinutes", async () => (await repos.ticketSlaSettings.upsertForWorkspace(WS, {
    urgentSlaMinutes: 240, highSlaMinutes: 480, clockMode: "business_hours",
    businessHoursStart: "09:00", businessHoursEnd: "18:00", businessDays: [1, 2, 3, 4, 5, 6],
  })).urgentSlaMinutes);
  await probe("ticketSlaSettings.upsert.highSlaMinutes", async () => (await repos.ticketSlaSettings.getByWorkspace(WS))?.highSlaMinutes);
  await probe("ticketSlaSettings.upsert.businessDays", async () => (await repos.ticketSlaSettings.getByWorkspace(WS))?.businessDays);
  await probe("ticketSlaSettings.upsert.clockMode", async () => (await repos.ticketSlaSettings.getByWorkspace(WS))?.clockMode);
  // Upsert twice — the second call must OVERWRITE, not create a duplicate.
  await probe("ticketSlaSettings.upsertTwice.urgentSlaMinutes", async () => {
    await repos.ticketSlaSettings.upsertForWorkspace(WS, { urgentSlaMinutes: 60 });
    return (await repos.ticketSlaSettings.getByWorkspace(WS))?.urgentSlaMinutes;
  });

  // ── Replies ──────────────────────────────────────────────────────────────
  // Field names follow the `Reply` type in src/lib/types.ts exactly (rawText,
  // not "content").
  await setup("reply.create", () => repos.reply.create({
    id: `${runId}-reply`, workspaceId: WS, leadId: LEAD_A,
    channel: "whatsapp", rawText: "Bhai rate kya hai 500m ka?",
    classification: "pricing_question", confidenceScore: 0.82,
    summary: "Customer asking for a 500m rate.",
    suggestedNextAction: "send_quote",
    createdAt: now, updatedAt: now,
  }));
  await probe("reply.getById.rawText", async () => (await repos.reply.getById(WS, `${runId}-reply`))?.rawText);
  await probe("reply.getById.classification", async () => (await repos.reply.getById(WS, `${runId}-reply`))?.classification);
  await probe("reply.getById.confidenceScore", async () => (await repos.reply.getById(WS, `${runId}-reply`))?.confidenceScore);
  await probe("reply.getById.suggestedNextAction", async () => (await repos.reply.getById(WS, `${runId}-reply`))?.suggestedNextAction);
  await probe("reply.listByWorkspace.count", async () => (await repos.reply.listByWorkspace(WS)).length);
  await probe("reply.update.classification", async () => {
    await repos.reply.update(WS, `${runId}-reply`, { classification: "hot_lead" });
    return (await repos.reply.getById(WS, `${runId}-reply`))?.classification;
  });

  // ── Auto-reply log / unknown question (the human-review queues) ──────────
  // N-TEST-10 (2026-08-26, S28). This said `status: "pending_review"`, which is
  // PendingSettingsDraft's status word, not AutoReplyLog's. AutoReplyLog's union
  // (src/lib/types.ts:1494) is drafted | auto_sent | held_for_review | blocked |
  // failed | approved | rejected | acknowledged, and "held_for_review" is what
  // WhatsAppConversationEngine actually writes when a reply needs a human. So
  // the seeded row, and the [pending] filter probe below it, were exercising the
  // review queue with a status the product never emits — on a plain String
  // column, so both substrates agreed and the probe stayed green. Fixed to the
  // real value; the cast is gone from this site so it cannot drift again.
  await setup("autoReplyLog.create", () => repos.autoReplyLog.create(WS, {
    id: `${runId}-arl`, workspaceId: WS, leadId: LEAD_A, channel: "whatsapp",
    incomingMessage: "Kya rate hai?", generatedReply: "Let me confirm the rate.",
    retrievedContext: {}, canAutoSend: false, needsHumanReview: true,
    status: "held_for_review", classification: "pricing_question",
    confidenceScore: 0.44, modelMode: "mock",
    createdAt: now, updatedAt: now,
  }));
  await probe("autoReplyLog.getById.status", async () => (await repos.autoReplyLog.getById(WS, `${runId}-arl`))?.status);
  await probe("autoReplyLog.getById.generatedReply", async () => (await repos.autoReplyLog.getById(WS, `${runId}-arl`))?.generatedReply);
  await probe("autoReplyLog.getById.canAutoSend", async () => (await repos.autoReplyLog.getById(WS, `${runId}-arl`))?.canAutoSend);
  await probe("autoReplyLog.getById.needsHumanReview", async () => (await repos.autoReplyLog.getById(WS, `${runId}-arl`))?.needsHumanReview);
  await probe("autoReplyLog.getById.confidenceScore", async () => (await repos.autoReplyLog.getById(WS, `${runId}-arl`))?.confidenceScore);
  await probe("autoReplyLog.getById.modelMode", async () => (await repos.autoReplyLog.getById(WS, `${runId}-arl`))?.modelMode);
  await probe("autoReplyLog.listByWorkspace[held].count", async () => (await repos.autoReplyLog.listByWorkspace(WS, { status: "held_for_review" })).length);
  await probe("autoReplyLog.approve.status", async () => (await repos.autoReplyLog.approve(WS, `${runId}-arl`)).status);
  // UX Fix 1 (2026-08-05). This is the step that first exposed the missing
  // `internal_note` migration — it returned the note on JSON and threw
  // "unknown field 'internalNote'" on Prisma.
  await probe("autoReplyLog.updateNote.internalNote", async () => (await repos.autoReplyLog.updateNote(WS, `${runId}-arl`, "Called the customer.")).internalNote);

  await setup("unknownQuestion.create", () => repos.unknownQuestion.create(WS, {
    id: `${runId}-uq`, workspaceId: WS, leadId: LEAD_A, channel: "whatsapp",
    questionText: "Do you export to Dubai?", status: "open",
    generatedBy: "whatsapp_unknown",
    createdAt: now, updatedAt: now,
  }));
  await probe("unknownQuestion.getById.questionText", async () => (await repos.unknownQuestion.getById(WS, `${runId}-uq`))?.questionText);
  await probe("unknownQuestion.getById.generatedBy", async () => (await repos.unknownQuestion.getById(WS, `${runId}-uq`))?.generatedBy);
  await probe("unknownQuestion.markAnswered.status", async () => (await repos.unknownQuestion.markAnswered(WS, `${runId}-uq`, "Yes, via Mundra port.")).status);
  await probe("unknownQuestion.markAnswered.finalAnswer", async () => (await repos.unknownQuestion.getById(WS, `${runId}-uq`))?.finalAnswer);
  await probe("unknownQuestion.listByWorkspace.count", async () => (await repos.unknownQuestion.listByWorkspace(WS)).length);
  await probe("unknownQuestion.listByWorkspace[open].count", async () => (await repos.unknownQuestion.listByWorkspace(WS, { status: "open" })).length);

  // ── WhatsApp templates (CP-25) ───────────────────────────────────────────
  await setup("whatsAppTemplate.create", () => repos.whatsAppTemplate.create(WS, {
    id: `${runId}-watmpl`, workspaceId: WS, name: "sample_followup",
    language: "en_US", category: "MARKETING", status: "approved",
    body: "Hello {{1}}, following up on your sample request.",
    createdAt: now, updatedAt: now,
  }));
  await probe("whatsAppTemplate.getById.name", async () => (await repos.whatsAppTemplate.getById(WS, `${runId}-watmpl`))?.name);
  await probe("whatsAppTemplate.getById.status", async () => (await repos.whatsAppTemplate.getById(WS, `${runId}-watmpl`))?.status);
  await probe("whatsAppTemplate.getById.body", async () => (await repos.whatsAppTemplate.getById(WS, `${runId}-watmpl`))?.body);
  await probe("whatsAppTemplate.getById.language", async () => (await repos.whatsAppTemplate.getById(WS, `${runId}-watmpl`))?.language);
  await probe("whatsAppTemplate.listByWorkspace.count", async () => (await repos.whatsAppTemplate.listByWorkspace(WS)).length);
  await probe("whatsAppTemplate.deleteById.name", async () => (await repos.whatsAppTemplate.deleteById(WS, `${runId}-watmpl`)).name);
  await probe("whatsAppTemplate.listAfterDelete.count", async () => (await repos.whatsAppTemplate.listByWorkspace(WS)).length);

  // ── Erasure cascade (DPDPA compliance obligation, LOGIC.md Q18) ──────────
  // The counts returned here drive an audit record. If the two substrates
  // disagree on the count, the compliance log is wrong on production.
  await probe("quote.deleteByLead.count", () => repos.quote.deleteByLead(WS, LEAD_A));
  await probe("order.deleteByLead.count", () => repos.order.deleteByLead(WS, LEAD_A));
  await probe("ticket.deleteByLead.count", () => repos.ticket.deleteByLead(WS, LEAD_A));
  await probe("reply.deleteByLead.count", () => repos.reply.deleteByLead(WS, LEAD_A));
  await probe("outreachActivity.deleteByLead.count", () => repos.outreachActivity.deleteByLead(WS, LEAD_A));
  await probe("autoReplyLog.deleteByLead.count", () => repos.autoReplyLog.deleteByLead(WS, LEAD_A));
  await probe("unknownQuestion.deleteByLead.count", () => repos.unknownQuestion.deleteByLead(WS, LEAD_A));
  await probe("quote.listByLead.afterErasure", async () => (await repos.quote.listByLead(WS, LEAD_A)).length);
  await probe("order.listByLead.afterErasure", async () => (await repos.order.listByLead(WS, LEAD_A)).length);

  // Erasure must be scoped: LEAD_B's data must survive LEAD_A's erasure.
  await probe("lead.getLeadById.survivor", async () => (await repos.lead.getLeadById(WS, LEAD_B))?.companyName);

  await probe("lead.deleteById.count", () => repos.lead.deleteById(WS, LEAD_A));
  await probe("lead.getLeadById.afterDelete", () => repos.lead.getLeadById(WS, LEAD_A));

  // ── Workspace deletion cascade (N-DATA-2, 2026-08-18) ────────────────────
  // Postgres cascades in the database (68 of 68 child relations declare
  // onDelete: Cascade); JSON has no cascade and sweeps the collections by
  // hand. Two completely different mechanisms, so they get compared here —
  // this is exactly the class of divergence this golden exists to catch.
  //
  // The "before" probes are deliberate controls: without them, "row is gone
  // after the delete" would also pass if the row had never been created, and
  // the cascade check would prove nothing.
  await probe("workspace.delete.before.leadB", async () => (await repos.lead.getLeadById(WS, LEAD_B))?.companyName);
  await probe("workspace.delete.before.campaign", async () => (await repos.campaign.getById(WS, CAMPAIGN))?.name);
  await probe("workspace.delete.deleted", async () => (await repos.workspace.delete(WS)).deleted);
  await probe("workspace.delete.workspaceGone", async () => (await repos.workspace.getById(WS)) === undefined);
  await probe("workspace.delete.cascade.leadB", async () => (await repos.lead.getLeadById(WS, LEAD_B)) === undefined);
  await probe("workspace.delete.cascade.campaign", async () => (await repos.campaign.getById(WS, CAMPAIGN)) === undefined);
  // Deleting an absent workspace must be a quiet no-op on both substrates —
  // cleanup() runs unconditionally in a finally block and must never turn a
  // real failure into a cleanup crash.
  await probe("workspace.delete.absent.deleted", async () => (await repos.workspace.delete(WS)).deleted);

  return obs;
}

/**
 * Remove everything this run created, on whichever substrate. Best-effort.
 *
 * N-DATA-2 (2026-08-18): this used to delete the two leads and stop, because
 * `WorkspaceRepository` had no `delete` method — so the `sp-*-ws` workspace
 * shell survived every run. On JSON that was invisible (isolated temp store,
 * thrown away); on Prisma it wrote into the SHIP database, and 15 orphan
 * workspaces had piled up by the time it was measured. The workspace delete
 * now cascades, which covers the leads too, but they are still deleted first
 * so that cleanup degrades gracefully if the workspace delete throws.
 */
async function cleanup(repos: RepositoryBundle, runId: string): Promise<void> {
  const WS = `${runId}-ws`;
  for (const leadId of [`${runId}-lead-a`, `${runId}-lead-b`]) {
    try { await repos.lead.deleteById(WS, leadId); } catch { /* already gone */ }
  }
  try { await repos.workspace.delete(WS); } catch { /* already gone */ }
}

// ─── Comparison ────────────────────────────────────────────────────────────

type Divergence = { step: string; json: string; prisma: string };

function compare(
  jsonObs: Observation[], jsonRunId: string,
  prismaObs: Observation[], prismaRunId: string,
): Divergence[] {
  const divergences: Divergence[] = [];
  const jsonByStep = new Map(jsonObs.map((o) => [o.step, o.value]));
  const prismaByStep = new Map(prismaObs.map((o) => [o.step, o.value]));

  // A step recorded on one substrate but not the other is itself a divergence
  // (it means the script aborted early on one side).
  const allSteps = [...new Set([...jsonByStep.keys(), ...prismaByStep.keys()])];
  for (const step of allSteps) {
    const inJson = jsonByStep.has(step);
    const inPrisma = prismaByStep.has(step);
    if (!inJson || !inPrisma) {
      divergences.push({
        step,
        json: inJson ? stable(jsonByStep.get(step), jsonRunId) : "<step never reached>",
        prisma: inPrisma ? stable(prismaByStep.get(step), prismaRunId) : "<step never reached>",
      });
      continue;
    }
    const j = stable(jsonByStep.get(step), jsonRunId);
    const p = stable(prismaByStep.get(step), prismaRunId);
    if (j !== p) divergences.push({ step, json: j, prisma: p });
  }
  return divergences;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("GOLDEN: substrate parity (JSON vs Prisma) — audit finding F-1");
  console.log("");

  // Three distinct situations, treated differently on purpose:
  //
  //   1. No DATABASE_URL at all  → legitimate SKIP. This is CI and any
  //      demo/JSON-only checkout. There is no Postgres to compare against, and
  //      demanding one would make the suite unrunnable for contributors.
  //   2. DATABASE_URL set but unreachable → FAIL. Somebody configured a
  //      database and it is down; silently passing would be the exact
  //      test-honesty bug this audit flagged (F-4).
  //   3. DATABASE_URL reachable → run the real comparison.
  if (!process.env.DATABASE_URL) {
    console.log("  ════════════════════════════════════════════════════════");
    console.log("   SKIPPED — no DATABASE_URL configured.");
    console.log("   JSON-vs-Prisma parity was NOT checked in this run.");
    console.log("  ════════════════════════════════════════════════════════");
    console.log("");
    console.log("=== SUBSTRATE PARITY: SKIPPED (no database configured) ===");
    process.exit(0);
  }

  // Run each substrate under its OWN run id so the two never share rows.
  const stamp = Date.now();
  const jsonRunId = `sp-${stamp}-json`;
  const prismaRunId = `sp-${stamp}-prisma`;

  // ── JSON pass ────────────────────────────────────────────────────────────
  // JSON data-file isolation happens in a PRELOAD
  // (_helpers/isolate-json-data.ts — see the npm script), not here.
  //
  // 2026-08-05 postmortem: this used to set `process.env.LEADGEN_DATA_DIR`
  // right here, inline. It had NO EFFECT — `src/lib/db.ts` reads that env var
  // into a module-level `const` the moment it's first imported, and this
  // file's own top-level `import { createRepositories } from "../../src/
  // repositories"` (hoisted, runs before any of main()'s body) had already
  // imported db.ts by the time this line executed. Every run silently wrote
  // into the SHARED demo file instead of an isolated one — 50 junk rows
  // (`sp-<timestamp>-*` workspaces/profiles/campaigns/tickets/templates)
  // landed in `.leadgen-data/app-data.json` before this was caught, none of
  // which `cleanup()` below removed (it only calls `repos.lead.deleteById`,
  // relying on a cascade the JSON substrate doesn't implement). Restored from
  // git and fixed by moving the isolation to a real preload, which is the
  // ONLY point early enough for a module-level `const` to see it — this is
  // the identical trap `_helpers/force-json-provider.ts`'s own docblock
  // already warned about; this file just didn't apply that lesson to itself.
  const jsonRepos = createRepositories("json");
  const jsonObs: Observation[] = [];
  try {
    await runScript(jsonRepos, jsonRunId, jsonObs);
    console.log(`  JSON pass:   ${jsonObs.length} observations recorded`);
  } catch (error) {
    console.error("  JSON pass FAILED — the reference substrate itself is broken:");
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    await cleanup(jsonRepos, jsonRunId);
  }

  // ── Prisma pass ──────────────────────────────────────────────────────────
  const prismaRepos = createRepositories("prisma");
  const prismaObs: Observation[] = [];
  let prismaError: Error | undefined;
  try {
    await runScript(prismaRepos, prismaRunId, prismaObs);
    console.log(`  Prisma pass: ${prismaObs.length} observations recorded`);
  } catch (error) {
    prismaError = error instanceof Error ? error : new Error(String(error));
  } finally {
    await cleanup(prismaRepos, prismaRunId);
  }

  if (prismaError) {
    const message = prismaError.message;
    const unreachable = /Can't reach database server|ECONNREFUSED|ENOTFOUND|getaddrinfo|Timed out fetching|terminating connection/i.test(message);
    if (unreachable) {
      // Test-honesty rule (audit F-4): a skipped run is NEVER reported green
      // unless the operator explicitly asked to allow it.
      console.log("");
      console.log("  ════════════════════════════════════════════════════════");
      console.log("   SKIPPED — Postgres unreachable, parity was NOT verified");
      console.log(`   ${message.split("\n")[0]}`);
      console.log("  ════════════════════════════════════════════════════════");
      if (ALLOW_SKIP) {
        console.log("");
        console.log("=== SUBSTRATE PARITY: SKIPPED (--allow-skip) — NOT a pass ===");
        process.exit(0);
      }
      console.log("");
      console.log("  Re-run with a reachable DATABASE_URL, or pass --allow-skip to");
      console.log("  acknowledge an offline database deliberately.");
      console.log("");
      console.log("=== SUBSTRATE PARITY: NOT VERIFIED ===");
      process.exit(1);
    }
    // A real error inside the Prisma repo IS the finding. Report it as one.
    console.log("");
    console.log(`  Prisma pass threw after ${prismaObs.length} observations:`);
    // Print the WHOLE Prisma message. Prisma puts the actionable part (which
    // field is unknown / which constraint failed) several lines down, so
    // truncating to the first few lines hides the only useful content.
    console.log(message.split("\n").map((l) => `    ${l}`).join("\n"));
    console.log("");
    console.log("  This is a genuine Prisma-repository defect, not a connectivity");
    console.log("  problem. The last observation reached was:");
    console.log(`    ${prismaObs.length > 0 ? prismaObs[prismaObs.length - 1].step : "<none — failed on the first call>"}`);
    console.log("");
    console.log("=== SUBSTRATE PARITY: FAIL ===");
    process.exit(1);
  }

  // ── Diff ─────────────────────────────────────────────────────────────────
  const divergences = compare(jsonObs, jsonRunId, prismaObs, prismaRunId);
  const checked = new Set([...jsonObs.map((o) => o.step), ...prismaObs.map((o) => o.step)]).size;

  console.log("");
  if (divergences.length === 0) {
    console.log(`=== SUBSTRATE PARITY: ${checked}/${checked} observations IDENTICAL ✅ ===`);
    console.log("");
    console.log("  Every logic golden that passes on JSON is therefore valid for the");
    console.log("  Prisma runtime across the operations covered here.");
    process.exit(0);
  }

  console.log(`=== SUBSTRATE PARITY: ${divergences.length} DIVERGENCE(S) of ${checked} ❌ ===`);
  console.log("");
  for (const d of divergences) {
    console.log(`  ✗ ${d.step}`);
    console.log(`      json   : ${d.json}`);
    console.log(`      prisma : ${d.prisma}`);
  }
  console.log("");
  console.log("  Each line above is a place where production (Prisma) behaves");
  console.log("  differently from what the golden suite proved (JSON).");
  process.exit(1);
}

main().catch((error) => {
  console.error("GOLDEN CRASHED:", error);
  process.exit(1);
});
