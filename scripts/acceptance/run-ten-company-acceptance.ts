/**
 * run-ten-company-acceptance.ts — the CEO's A5/A6 acceptance run.
 *
 * WHAT THE CEO ASKED FOR (docs/CEO-LOOP-STATUS.md, "The CEO's definition of
 * DONE", 2026-08-20):
 *
 *   "You have to choose ten different customers or ten different companies and
 *    try to import the data and — you being a customer — check each and
 *    everything, how the system is talking with the customers... And it is not
 *    necessary that always you are going to tell it the right thing. You have to
 *    test it with the wrong things as well. Give the wrong information also, so
 *    that if it will not correct it, or it will say another thing, or if it is
 *    not asking the follow-up question, then it is wrong."
 *
 * WHAT THIS DOES, PER PERSONA (scripts/acceptance/personas.ts):
 *   1. Creates a fresh workspace — its own tenant, nothing shared.
 *   2. Imports the company: business profile -> approve -> sync to knowledge
 *      base, then loads its price list / terms as a knowledge document and
 *      chunks it. This is the "import the data" half of the CEO's sentence, and
 *      it runs through the SAME service functions the product uses; nothing is
 *      hand-fed to the model.
 *   3. Creates the customer as a lead, then sends that customer's messages
 *      through `handleIncomingWhatsAppMessage` — the real production entry
 *      point — on the real DeepSeek key.
 *   4. Grades every reply against deterministic rules and writes the whole
 *      conversation down verbatim so the CEO can read it.
 *   5. Deletes the workspace.
 *
 * THE SIX GRADERS. A reply passes a turn only if all of these hold:
 *   G1 REAL      — llm.mode === "real". A mock reply proves nothing; if the key
 *                  or the routing breaks, the run must say so loudly rather than
 *                  quietly grade a canned string.
 *   G2 GROUNDED  — every `mustMention` fact appears. The company's own numbers,
 *                  not a friendly non-answer.
 *   G3 NOT ECHOED— no `mustNotMention` claim appears. The adversarial turns
 *                  assert things the company never said; agreeing is the exact
 *                  failure named above.
 *   G4 ASKS      — when `mustAskFollowUp`, the reply actually asks a question.
 *                  "If it is not asking the follow-up question, then it is wrong."
 *   G5 HELD      — when `mustHoldForHuman`, the message is not auto-sendable.
 *                  An impossible order must reach a person.
 *   G6 NO INVENTED NUMBERS — every commercial figure in the reply traces back to
 *                  something this company actually said (its profile, its
 *                  knowledge, or the customer's own message). This is the
 *                  hallucination check, and it is per-tenant on purpose.
 *   G7 NO TENANT LEAK — the reply must not name any of the other nine companies,
 *                  nor the demo tenant the empty data directory bootstraps with.
 *                  Ten tenants in one process is the cheapest cross-tenant test
 *                  there is, so it may as well be asserted.
 *
 * SAFETY. Runs on an isolated, EMPTY scratch data directory
 * (_helpers/isolate-scratch-data.ts) with PERSISTENCE_PROVIDER forced to json,
 * so it can never reach the ship database. Every company, phone number and
 * domain in personas.ts is unroutable by construction (N-SAFETY-1), and no send
 * path is enabled — `allowRealSend` is left at its default false.
 *
 * COST. Real API calls: 10 personas x 6 turns = 60 DeepSeek completions plus
 * retrieval. Small, but real money. Not a golden; do not run in CI.
 *
 * RUN:
 *   npx tsx --import ./scripts/acceptance/_helpers/isolate-scratch-data.ts scripts/acceptance/run-ten-company-acceptance.ts
 *
 * FLAGS:
 *   --only=coffee,dental   run just those personas (smoke test)
 *   --turns=2              first N turns of each persona only
 */
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { PERSONAS, type Persona, type AcceptanceTurn } from "./personas";
import fs from "node:fs";
import path from "node:path";

type TurnResult = {
  personaId: string;
  turnId: string;
  kind: AcceptanceTurn["kind"];
  ask: string;
  reply: string;
  why: string;
  mode: string;
  provider: string;
  modelName?: string;
  fallbackUsed: boolean;
  validationStatus: string;
  classification?: string;
  canAutoSend: boolean;
  needsHumanReview: boolean;
  unknownQuestionCreated: boolean;
  failures: string[];
  pass: boolean;
};

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : undefined;
const turnLimit = Number(args.find((a) => a.startsWith("--turns="))?.slice("--turns=".length) ?? "0") || undefined;

/**
 * Every company name in the run, plus the identity the empty data directory
 * bootstraps itself with (src/lib/db.ts seedData). If any of these appears in a
 * reply written for a DIFFERENT company, knowledge has crossed a tenant line.
 */
const ALL_COMPANY_TERMS = [
  ...PERSONAS.map((p) => p.company.companyName),
  "Meghdoot",
  "zari",
];

/**
 * Numbers a reply is allowed to contain: everything this company has ever
 * stated, plus whatever the customer just said. Built from the raw corpus
 * rather than from a hand-kept list, because a hand-kept list is one more thing
 * that drifts — and the point of the check is to catch figures that came from
 * the model rather than from the business.
 */
function allowedNumbers(persona: Persona, customerMessage: string): Set<string> {
  const corpus = [
    JSON.stringify(persona.company),
    ...persona.knowledge.map((k) => `${k.title}\n${k.text}`),
    persona.knownNumbers.join(" "),
    customerMessage,
  ].join("\n");
  return new Set(extractNumbers(corpus));
}

/**
 * Commercial figures only. Deliberately ignores anything under three digits:
 * "2 to 3 weeks", "50 percent", "4 visits" are ordinary prose, and flagging
 * them would bury the one thing this check exists to find — a price, a
 * quantity or a lead time the company never quoted.
 */
function extractNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /\d[\d\s,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalized = m[0].replace(/[\s,]/g, "").replace(/\.$/, "");
    if (!normalized) continue;
    const digitsOnly = normalized.replace(".", "");
    if (digitsOnly.length < 3) continue;
    out.push(normalized);
    // A decimal price may legitimately be written back without its trailing
    // zero ("3.4" for "3.40"), and an integer may be written with a decimal
    // point ("165000.00"). Register both shapes so the check tests substance.
    if (normalized.includes(".")) {
      out.push(String(Number(normalized)));
      out.push(normalized.replace(/\.0+$/, ""));
    }
  }
  return out;
}

/** Does the reply actually ask the customer something? */
function asksAQuestion(reply: string): boolean {
  return /\?/.test(reply);
}

/**
 * Is the match at `index` inside a clause that DENIES it?
 *
 * G3 asks "did the agent echo the customer's false claim back as true". The
 * first version asked only "does the phrase appear", and it graded a correct
 * refusal as a failure: NordFrost replied
 *
 *   "We do not carry live animals, so I'm not sure we can handle live crabs."
 *
 * and the pattern /we (can|will|could) (carry|move|transport|handle) live/
 * matched "we can handle live" inside a sentence whose whole point was the
 * refusal. The product was right and the grader was wrong — the second time
 * this run has produced that verdict, so it is worth stating the rule plainly:
 * a detector that cannot read a negation is measuring word presence, not
 * behaviour.
 *
 * Scope of the check is the clause, not the reply: negation is looked for
 * between the start of the containing sentence (or the last "but"/"however",
 * which flips a clause back) and the match itself. So this correctly excuses
 * "I'm not sure we can handle live crabs" and correctly still FAILS
 * "we don't normally carry livestock, but we can handle live crabs".
 */
function isNegated(reply: string, index: number): boolean {
  const before = reply.slice(0, index);
  const clauseStart = Math.max(
    before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
    before.toLowerCase().lastIndexOf(" but "),
    before.toLowerCase().lastIndexOf(" however"),
  );
  const clause = before.slice(clauseStart + 1).toLowerCase();
  return /\b(not|no|never|cannot|can't|don't|doesn't|won't|unable|afraid|sorry)\b/.test(clause);
}

function gradeTurn(persona: Persona, turn: AcceptanceTurn, result: {
  suggestedReply: string;
  canAutoSend: boolean;
  needsHumanReview: boolean;
  llm: { mode: string; fallbackUsed: boolean };
}): string[] {
  const failures: string[] = [];
  const reply = result.suggestedReply || "";

  // G1 — a mock reply grades nothing.
  if (result.llm.mode !== "real" || result.llm.fallbackUsed) {
    failures.push(`G1 not a real model call (mode=${result.llm.mode}, fallbackUsed=${result.llm.fallbackUsed})`);
  }

  // G2 — grounded in this company's own facts.
  for (const rx of turn.mustMention ?? []) {
    if (!rx.test(reply)) failures.push(`G2 missing required fact ${rx}`);
  }

  // G3 — did not echo the customer's false claim back as true.
  for (const rx of turn.mustNotMention ?? []) {
    const m = rx.exec(reply);
    if (!m) continue;
    if (isNegated(reply, m.index)) continue; // denying the claim is the correct behaviour
    failures.push(`G3 echoed a claim the company never made ${rx}`);
  }

  // G4 — asked instead of guessing.
  if (turn.mustAskFollowUp && !asksAQuestion(reply)) {
    failures.push("G4 no follow-up question asked");
  }

  // G5 — held for a human.
  if (turn.mustHoldForHuman && result.canAutoSend && !result.needsHumanReview) {
    failures.push("G5 auto-sendable when it should have been held for a human");
  }

  // G6 — no invented commercial figures.
  const allowed = allowedNumbers(persona, turn.ask);
  const invented = [...new Set(extractNumbers(reply))].filter((n) => !allowed.has(n));
  if (invented.length) {
    failures.push(`G6 invented number(s) not in this company's data: ${invented.join(", ")}`);
  }

  // G7 — no cross-tenant contamination.
  const leaks = ALL_COMPANY_TERMS.filter(
    (term) => term !== persona.company.companyName && new RegExp(escapeRegExp(term), "i").test(reply),
  );
  if (leaks.length) failures.push(`G7 mentions another tenant: ${leaks.join(", ")}`);

  return failures;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Point this workspace's model routing at the real DeepSeek key.
 *
 * Copied in shape from scripts/probes/real-ai-proof-pass.ts, with one
 * deliberate difference: `enableMockFallback` is FALSE. In the proof pass a
 * silent mock fallback merely weakened a probe; here it would mean grading a
 * canned string as if it were the product's answer to a customer. If the key is
 * dead, this run must fail loudly.
 */
async function setRealRouting(repos: RepositoryBundle, workspaceId: string) {
  const now = new Date().toISOString();
  const slot = (taskName: string, modelName: string, modelTier: string) => ({
    id: `acc_route_${workspaceId}_${taskName}`,
    workspaceId,
    taskName,
    provider: "deepseek",
    modelName,
    modelTier,
    isEnabled: true,
    config: { enableMockFallback: false, note: "ten-company acceptance run — isolated scratch data only" },
    createdAt: now,
    updatedAt: now,
  });
  await repos.llmModelRouting.replaceForWorkspace(workspaceId, [
    slot("fast_customer_reply", "deepseek-chat", "balanced"),
    slot("daily_workhorse", "deepseek-chat", "balanced"),
    slot("deep_reasoning", "deepseek-reasoner", "reasoning"),
    slot("research_search", "deepseek-chat", "balanced"),
    slot("creative_image", "deepseek-chat", "balanced"),
    slot("embedding_advanced", "deepseek-chat", "balanced"),
  ]);
  // Same reasoning as the proof pass: the default cap is sized for customer
  // traffic, not for a scripted run of long KB-grounded prompts. Raised on the
  // scratch copy only, so this measures answer quality rather than the usage
  // cap feature (which has its own golden: golden:ai-usage).
  await repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
    dailyTokenLimit: 2_000_000,
    monthlyTokenLimit: 20_000_000,
    dailyCostLimit: 50,
    monthlyCostLimit: 500,
  });
}

/** Build one company from nothing, through the product's own services. */
async function importCompany(repos: RepositoryBundle, persona: Persona) {
  const { syncBusinessProfileToKnowledgeBase, createKnowledgeDocument, chunkKnowledgeDocument } =
    await import("@/services/KnowledgeBaseService");

  const workspace = await repos.workspace.create({
    id: `acc_ws_${persona.id}`,
    name: persona.company.companyName,
    businessName: persona.company.companyName,
    industry: persona.company.industry,
    status: "active",
  });

  const profile = await repos.businessProfile.create({
    workspaceId: workspace.id,
    ...persona.company,
    status: "draft",
  });
  // Approved on purpose: an unapproved profile is a half-imported company, and
  // the CEO's scenario is a customer talking to a business that is live.
  await repos.businessProfile.approve(workspace.id, profile.id);
  await syncBusinessProfileToKnowledgeBase(workspace.id, repos);

  for (const doc of persona.knowledge) {
    const created = await createKnowledgeDocument({
      workspaceId: workspace.id,
      title: doc.title,
      contentText: doc.text,
      documentType: "pricing",
      // "manual" means owner-entered and therefore VERIFIED. Anything sourced
      // as "uploaded_document" is stamped extractionUnverified and gets the
      // "do not quote as fact" prefix at retrieval (KnowledgeBaseService), which
      // would make every price question unanswerable by design rather than by
      // defect — the wrong thing to measure here.
      source: "manual",
      status: "active",
    }, repos);
    await chunkKnowledgeDocument(workspace.id, created.id, repos);
  }

  await setRealRouting(repos, workspace.id);

  const lead = await repos.lead.createLead({
    workspaceId: workspace.id,
    companyName: `Acceptance customer for ${persona.company.companyName}`,
    contactName: "Prospective customer",
    // Unroutable by construction (N-SAFETY-1), and distinct from the company's
    // own number so lead resolution cannot accidentally match the business.
    phone: "+91 00000 00099",
    whatsappNumber: "+910000000099",
    // "talking" not "prospected": this customer has written in, which is what
    // every turn below simulates.
    status: "talking",
    source: "whatsapp",
  });

  return { workspace, lead };
}

async function main() {
  const startedAt = Date.now();
  console.log(`Isolated scratch dir: ${process.env.ACCEPTANCE_ISOLATED_DIR}`);
  console.log(`PERSISTENCE_PROVIDER: ${process.env.PERSISTENCE_PROVIDER}`);
  const keyPresent = Boolean(process.env.PLATFORM_DEEPSEEK_API_KEY);
  console.log(`DeepSeek key present: ${keyPresent}`);
  if (!keyPresent) {
    throw new Error(
      "PLATFORM_DEEPSEEK_API_KEY is not set. This run grades real model answers; " +
      "without the key every reply would be a mock and every grade would be meaningless.",
    );
  }

  const repos = createRepositories();
  const { handleIncomingWhatsAppMessage } = await import("@/services/WhatsAppConversationEngine");

  const personas = PERSONAS.filter((p) => !only || only.has(p.id));
  const results: TurnResult[] = [];

  for (const persona of personas) {
    console.log(`\n=== ${persona.company.companyName} (${persona.industry}) ===`);
    let workspaceId = "";
    try {
      const { workspace, lead } = await importCompany(repos, persona);
      workspaceId = workspace.id;
      console.log(`  imported: workspace=${workspace.id} profile+knowledge synced`);

      const turns = turnLimit ? persona.turns.slice(0, turnLimit) : persona.turns;
      for (const turn of turns) {
        const label = `${persona.id}/${turn.id} [${turn.kind}]`;
        try {
          const result = await handleIncomingWhatsAppMessage({
            workspaceId: workspace.id,
            leadId: lead.id,
            rawText: turn.ask,
            providerMessageId: `acc-${persona.id}-${turn.id}-${Date.now()}`,
          }, repos);

          const failures = gradeTurn(persona, turn, result);
          results.push({
            personaId: persona.id,
            turnId: turn.id,
            kind: turn.kind,
            ask: turn.ask,
            reply: result.suggestedReply || "",
            why: turn.why,
            mode: result.llm.mode,
            provider: result.llm.provider,
            modelName: result.llm.modelName,
            fallbackUsed: result.llm.fallbackUsed,
            validationStatus: result.llm.validationStatus,
            classification: result.classification?.category,
            canAutoSend: result.canAutoSend,
            needsHumanReview: result.needsHumanReview,
            unknownQuestionCreated: result.unknownQuestionCreated,
            failures,
            pass: failures.length === 0,
          });
          console.log(`  ${failures.length ? "FAIL" : "OK  "} ${label} ${failures.length ? failures.join(" | ") : ""}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            personaId: persona.id, turnId: turn.id, kind: turn.kind, ask: turn.ask,
            reply: "", why: turn.why, mode: "error", provider: "n/a", fallbackUsed: false,
            validationStatus: "not_run", canAutoSend: false, needsHumanReview: false,
            unknownQuestionCreated: false, failures: [`threw: ${message}`], pass: false,
          });
          console.log(`  FAIL ${label} threw: ${message.slice(0, 200)}`);
        }
      }
    } finally {
      // Ten tenants must not accumulate even in scratch: the run is meant to be
      // repeatable, and a leftover workspace would let the next run's retrieval
      // see the last run's knowledge.
      if (workspaceId) await repos.workspace.delete(workspaceId).catch(() => undefined);
    }
  }

  writeReport(results, personas, Date.now() - startedAt);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} turns passed.`);
  if (failed.length) {
    console.log("Failing turns:");
    for (const f of failed) console.log(`  ${f.personaId}/${f.turnId}: ${f.failures.join(" | ")}`);
    process.exitCode = 1;
  }
}

/**
 * The CEO reads this, not the console. Plain English, every question and every
 * answer verbatim, and the reason each turn existed — a transcript nobody can
 * read is not evidence.
 */
function writeReport(results: TurnResult[], personas: Persona[], elapsedMs: number) {
  const outDir = path.join(process.cwd(), "docs", "acceptance");
  fs.mkdirSync(outDir, { recursive: true });

  const passed = results.filter((r) => r.pass).length;
  const lines: string[] = [];
  lines.push("# Ten-company acceptance run");
  lines.push("");
  lines.push(`Run at ${new Date().toISOString()} — ${Math.round(elapsedMs / 1000)}s — **${passed}/${results.length} turns passed**.`);
  lines.push("");
  lines.push("Every company below is invented. Each one was created as its own workspace, its");
  lines.push("profile and price list were imported through the product's own screens' service");
  lines.push("layer, and then a customer talked to it on the real model. Half the questions are");
  lines.push("honest; half are wrong on purpose.");
  lines.push("");
  lines.push("| Company | Industry | Honest questions | Trick questions | Passed |");
  lines.push("|---|---|---|---|---|");
  for (const p of personas) {
    const mine = results.filter((r) => r.personaId === p.id);
    const truthful = mine.filter((r) => r.kind === "truthful");
    const adversarial = mine.filter((r) => r.kind === "adversarial");
    lines.push(`| ${p.company.companyName} | ${p.industry} | ${truthful.length} | ${adversarial.length} | ${mine.filter((r) => r.pass).length}/${mine.length} |`);
  }
  lines.push("");

  for (const p of personas) {
    const mine = results.filter((r) => r.personaId === p.id);
    if (!mine.length) continue;
    lines.push(`## ${p.company.companyName}`);
    lines.push("");
    lines.push(`${p.company.description}`);
    lines.push("");
    for (const r of mine) {
      lines.push(`### ${r.turnId} — ${r.kind === "truthful" ? "honest question" : "trick question"} — ${r.pass ? "PASS" : "FAIL"}`);
      lines.push("");
      lines.push(`**Why this was asked:** ${r.why}`);
      lines.push("");
      lines.push(`**Customer:** ${r.ask}`);
      lines.push("");
      lines.push(`**System:** ${r.reply || "(no reply produced)"}`);
      lines.push("");
      lines.push(`Model: ${r.provider}/${r.modelName ?? "?"} (${r.mode}${r.fallbackUsed ? ", fell back" : ""}) · classified as ${r.classification ?? "?"} · needs a person: ${r.needsHumanReview} · can send by itself: ${r.canAutoSend}`);
      if (!r.pass) {
        lines.push("");
        lines.push("**What went wrong:**");
        for (const f of r.failures) lines.push(`- ${f}`);
      }
      lines.push("");
    }
  }

  const mdPath = path.join(outDir, "TEN-COMPANY-RUN.md");
  fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
  const jsonPath = path.join(outDir, "ten-company-run.json");
  const generatedAt = new Date().toISOString();
  const raw = JSON.stringify({ generatedAt, elapsedMs, results }, null, 2);
  fs.writeFileSync(jsonPath, raw, "utf8");

  // N-TEST-8(a): the two files above are fixed paths, so each run overwrites the
  // one before it. That makes the only question worth asking of a REPEATED
  // acceptance run - "did the answers change?" - unanswerable, because there is
  // never a previous run left to compare against. Keep those two as the
  // always-current, easy-to-find copy, and additionally archive every run under a
  // timestamped name so history accumulates instead of being destroyed.
  const runsDir = path.join(outDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const archiveMd = path.join(runsDir, `${stamp}.md`);
  const archiveJson = path.join(runsDir, `${stamp}.json`);
  fs.writeFileSync(archiveMd, lines.join("\n"), "utf8");
  fs.writeFileSync(archiveJson, raw, "utf8");

  console.log(`\nTranscript: ${mdPath}`);
  console.log(`Raw:        ${jsonPath}`);
  console.log(`Archived:   ${archiveMd}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
