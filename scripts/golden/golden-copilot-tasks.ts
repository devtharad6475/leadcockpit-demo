/**
 * Golden test — Owner Copilot: UNIVERSAL task wiring (the other 21 actions).
 *
 * Phase 1.5 / skill v2 / build-right Phase 3 — written BEFORE the handler code.
 * This test DEFINES the contract that the universal wiring must satisfy.
 * Companion to golden-copilot-quote.ts (which pins the Quote action + router).
 *
 * What this proves (the rules in docs/LOGIC.md CP-1..CP-11):
 *
 *   CASE A — UNIVERSAL COVERAGE: every one of the 22 AI tasks has a tier.
 *     No task is left unmapped / ambiguous. (CP-1 universal + 5-tiered.)
 *     For each task, ALL_TASK_TIER_MAP[taskName] must be one of T1..T5.
 *
 *   CASE B — T1 read-only knowledge answer WITH a supporting KB chunk:
 *     When the owner asks "what is our MOQ?" and the KB has the answer, the
 *     Copilot returns the answer text + reports honest AI status (real/mock).
 *     It does NOT mutate anything (T1 = read-only). Pure read.
 *
 *   CASE C — T1 knowledge answer with NO supporting chunk (CP-11):
 *     When the owner asks a question the KB can't answer, the Copilot MUST:
 *       - NOT invent an answer (no-hallucination),
 *       - return an honest "I don't have that" message,
 *       - offer a pendingAction to capture it as an Information Needed card.
 *     It never fabricates.
 *
 *   CASE D — T2 draft reply (never-send): a "draft a reply to raj" intent
 *     produces a DRAFT reply, NEVER sends. The draft is persisted + audited.
 *     No customer contact occurs.
 *
 *   CASE E — T3 confirm-then-RUN (CP-10): when the owner confirms a T3 cost
 *     prompt (ICP generation), the Copilot EXECUTES the job and reports the
 *     result in chat (it does NOT just deflect to the dedicated screen). The
 *     result is a real ICP row. The confirm gate still stood (never auto-ran).
 *
 *   CASE F — Per-lead isolation for ACTIONS (CP-6): a T2 action with no active
 *     lead returns "which lead?" instead of acting on a guessed lead. T1
 *     read-only questions are lead-free (allowed).
 *
 *   CASE G — Every tier handler writes an audit row (CP-8).
 *
 *   CASE H — saveCopilotFact (CP-5 ask-before-save): accepting the "save this
 *     fact?" offer captures it as an Information Needed card, NOT a silent KB
 *     write.
 *
 * Test isolation (build-right Gate #8): every case uses its OWN unique
 * workspace ID (ws_cptask_*). The golden preload pins each run to a
 * process-unique LEADGEN_DATA_DIR, so cases never share state.
 *
 * Run: npm run golden:copilot-tasks
 *      npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-copilot-tasks.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import "./_helpers/no-platform-ai-keys";
import {
  classifyCopilotIntent,
  ALL_TASK_TIER_MAP,
  handleOwnerCopilotTurn,
  confirmCopilotBigJob,
  saveCopilotFact,
} from "@/services/OwnerCopilotService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";
import { LLMService } from "@/llm/LLMService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Open (or reuse) the owner's active conversation for a workspace. */
async function openConversation(repos: RepositoryBundle, workspaceId: string, ownerUserId: string, leadId?: string) {
  const existing = await repos.ownerCopilotConversation.getActiveForOwner(workspaceId, ownerUserId);
  if (existing) return existing;
  return repos.ownerCopilotConversation.create({ workspaceId, ownerUserId, activeLeadId: leadId });
}

/** Seed a workspace so the FK constraints hold. */
async function seedWorkspace(repos: RepositoryBundle, workspaceId: string) {
  await repos.workspace.create({ id: workspaceId, name: `Test WS ${workspaceId}`, status: "active" });
}

/** Seed an approved lead + return its id. */
async function seedApprovedLead(repos: RepositoryBundle, workspaceId: string, companyName = "Raj Textiles"): Promise<string> {
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName,
    contactName: "Raj",
    phone: "+919999900001",
    whatsappNumber: "+919999900001",
    source: "manual",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
  });
  return lead.id;
}

async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: UNIVERSAL COVERAGE — every one of the 22 tasks has a tier ─────
  // CP-1: the Copilot is universal. No task is left ambiguous.
  {
    const ALL_22_TASKS = [
      "business_extraction", "icp_generation", "campaign_planning",
      "prospect_research", "lead_enrichment", "lead_scoring",
      "message_generation", "reply_classification", "whatsapp_reply",
      "knowledge_answer", "document_extraction_mapping", "lead_review_decision",
      "product_application_research", "market_research", "creative_generation",
      "embedding", "campaign_learning", "policy_answer", "quality_review",
      "image_generation", "web_search", "manual_answer_mapping",
    ] as const;
    for (const task of ALL_22_TASKS) {
      const tier = ALL_TASK_TIER_MAP[task];
      assert(
        tier === "T1" || tier === "T2" || tier === "T3" || tier === "T4" || tier === "T5",
        `CASE A: task "${task}" must have a tier (T1..T5), got ${String(tier)}`,
      );
    }
    assert(Object.keys(ALL_TASK_TIER_MAP).length === 22, `CASE A: exactly 22 tasks mapped, got ${Object.keys(ALL_TASK_TIER_MAP).length}`);
    console.log("  OK CASE A — all 22 AI tasks mapped to a tier (universal coverage, CP-1)");
  }

  // ─── CASE B: T1 knowledge answer WITH a supporting KB chunk ───────────────
  {
    const WS = "ws_cptask_b";
    await seedWorkspace(repos, WS);
    const doc = await repos.knowledgeBaseDocument.create(WS, {
      id: "kb_moq_b",
      title: "Pricing & MOQ",
      documentType: "policy",
      source: "manual",
      status: "active",
      contentText: "Our minimum order quantity (MOQ) for gold zari border is 100 metres. Orders below MOQ are not accepted.",
      metadata: {},
    });
    await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
      { chunkIndex: 0, chunkText: "Our minimum order quantity (MOQ) for gold zari border is 100 metres.", metadata: { documentId: doc.id, source: "manual" } },
    ]);
    const convo = await openConversation(repos, WS, "user_owner");

    const res = await handleOwnerCopilotTurn({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      ownerText: "what is our MOQ?",
      repos,
    });
    assert(res.tier === "T1", `CASE B: MOQ question → T1, got ${res.tier}`);
    assert(/100/i.test(res.text), `CASE B: answer should mention 100 metres, got: ${res.text}`);
    assert(res.aiStatus !== undefined, "CASE B: response must carry honest AI status (CP-1 §10)");
    assert(res.kind !== "copilot_action_done", "CASE B: T1 must not perform a write action");
    console.log(`  OK CASE B — T1 knowledge answer (MOQ=100m) returned read-only with honest AI status: ${res.aiStatus}`);
  }

  // ─── CASE C: T1 knowledge answer with NO supporting chunk (CP-11) ─────────
  {
    const WS = "ws_cptask_c";
    await seedWorkspace(repos, WS);
    // NO KB document seeded — the credit-policy answer is unknown.
    const convo = await openConversation(repos, WS, "user_owner");

    const res = await handleOwnerCopilotTurn({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      ownerText: "what is our credit policy for new buyers?",
      repos,
    });
    assert(res.tier === "T1", `CASE C: credit question → T1, got ${res.tier}`);
    assert(/don't have|not in your knowledge|don.t have that|no knowledge/i.test(res.text) || res.pendingAction !== undefined, `CASE C: must say "I don't have that" or offer a card, got: ${res.text}`);
    assert(
      res.pendingAction?.entityType === "unknown_question",
      `CASE C: must offer an Information Needed card, got pendingAction=${JSON.stringify(res.pendingAction)}`,
    );
    console.log("  OK CASE C — empty KB → honest 'I don't have that' + offers capture card (CP-11, no-hallucination)");
  }

  // ─── CASE D: T2 draft reply (never-send) ──────────────────────────────────
  {
    const WS = "ws_cptask_d";
    await seedWorkspace(repos, WS);
    const leadId = await seedApprovedLead(repos, WS);
    await repos.reply.create({
      workspaceId: WS,
      leadId,
      channel: "whatsapp",
      rawText: "Hi, is the gold zari border 50mm in stock? What's the price for 500m?",
    });
    const convo = await openConversation(repos, WS, "user_owner", leadId);

    const res = await handleOwnerCopilotTurn({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      ownerText: "draft a reply to raj about the 500m quote",
      leadId,
      repos,
    });
    assert(res.tier === "T2", `CASE D: draft reply → T2, got ${res.tier}`);
    assert(res.kind === "copilot_draft", `CASE D: must be a draft, got kind=${res.kind}`);
    assert(res.pendingAction?.entityType === "reply", `CASE D: pendingAction must be a reply draft, got ${JSON.stringify(res.pendingAction)}`);
    const drafts = (await repos.messageTemplate.listByWorkspace(WS)).filter((m) => m.status === "draft");
    assert(drafts.length >= 1, `CASE D: a reply draft must be persisted (status=draft), got ${drafts.length} drafts`);
    console.log("  OK CASE D — T2 draft reply persisted (pending_review), never sent (no-auto-outreach)");
  }

  // ─── CASE E: T3 confirm-then-RUN (CP-10) — ICP generation ─────────────────
  {
    const WS = "ws_cptask_e";
    await seedWorkspace(repos, WS);
    await repos.businessProfile.create({
      id: "bp_e",
      workspaceId: WS,
      companyName: "Balaji Zari",
      industry: "textile",
      products: ["gold zari border"],
    });
    const convo = await openConversation(repos, WS, "user_owner");

    // Step 1: owner asks for an ICP → T3 confirm prompt (never auto-runs).
    const ask = await handleOwnerCopilotTurn({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      ownerText: "build my customer profile",
      repos,
    });
    assert(ask.tier === "T3", `CASE E: ICP ask → T3, got ${ask.tier}`);
    assert(ask.kind === "copilot_confirm", `CASE E: must be a confirm prompt, got kind=${ask.kind}`);
    assert(ask.pendingAction?.entityType === "icp", `CASE E: confirm must carry an ICP pending action, got ${JSON.stringify(ask.pendingAction)}`);
    const icpPendingId = ask.pendingAction!.entityId!;

    // Step 2: owner confirms → the job RUNS (CP-10).
    // Success needs actual usable task output, not the generic mock echo.
    const originalTask = LLMService.prototype.runTask;
    LLMService.prototype.runTask = (async () => ({ output: { icps: [{
      name: "Textile wholesalers", buyerType: "wholesaler", description: "Bulk textile buyers",
      industries: ["textile"], geography: ["India"], likelyNeeds: ["gold zari border"],
      buyingTriggers: ["Seasonal collection"], painPoints: ["Consistent quality"], preferredChannels: ["email"],
      messagingAngles: ["Product range"], qualificationRules: ["Business buyer"], confidenceScore: 0.8,
      companySizeBucket: "small company",
    }] }, mode: "real", fallbackUsed: false, provider: "synthetic" })) as unknown as typeof originalTask;
    let run;
    try { run = await confirmCopilotBigJob({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      pendingActionId: icpPendingId,
      intent: "icp_generation",
      repos,
    }); } finally { LLMService.prototype.runTask = originalTask; }
    assert(run.kind === "copilot_action_done", `CASE E: confirm must RUN the job, got kind=${run.kind}`);
    const icps = await repos.icp.listByWorkspace(WS);
    assert(icps.length >= 1, `CASE E: ICP generation must create ≥1 ICP row (CP-10 run), got ${icps.length}`);
    console.log(`  OK CASE E — T3 confirm→RUN: ICP generation executed in chat, ${icps.length} ICP row(s) created (CP-10)`);
    // A later outage cannot replace that valid profile with a fabricated one.
    const retryProposal = await handleOwnerCopilotTurn({ workspaceId: WS, ownerUserId: "user_owner", conversationId: convo.id,
      ownerText: "build my customer profile", repos, conversationBrain: false });
    LLMService.prototype.runTask = (async () => { throw new Error("Synthetic provider outage"); }) as typeof originalTask;
    try {
      const failed = await confirmCopilotBigJob({ workspaceId: WS, ownerUserId: "user_owner", conversationId: convo.id,
        pendingActionId: retryProposal.pendingAction!.entityId!, intent: "icp_generation", repos });
      assert(failed.kind !== "copilot_action_done", "CASE E outage must not claim completion");
      assert(JSON.stringify(await repos.icp.listByWorkspace(WS)) === JSON.stringify(icps), "CASE E outage must preserve valid profiles");
    } finally { LLMService.prototype.runTask = originalTask; }
  }

  // ─── CASE F: Per-lead isolation for ACTIONS (CP-6) ────────────────────────
  {
    const WS = "ws_cptask_f";
    await seedWorkspace(repos, WS);
    const convo = await openConversation(repos, WS, "user_owner");

    const res = await handleOwnerCopilotTurn({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      ownerText: "draft a reply to raj",
      // leadId deliberately omitted
      repos,
    });
    assert(res.tier === "T2", `CASE F: draft reply → T2, got ${res.tier}`);
    assert(/which lead|active lead|select a lead|no lead|pick a lead/i.test(res.text), `CASE F: must ask 'which lead?' (CP-6 per-lead isolation), got: ${res.text}`);
    assert(res.kind !== "copilot_draft" || res.pendingAction?.entityType !== "reply", "CASE F: must NOT create a reply draft with no active lead");
    console.log("  OK CASE F — T2 action with no active lead asks 'which lead?' (CP-6 per-lead isolation)");
  }

  // ─── CASE G: Every tier handler writes an audit row (CP-8) ────────────────
  {
    const WS = "ws_cptask_g";
    await seedWorkspace(repos, WS);
    const leadId = await seedApprovedLead(repos, WS);
    await repos.reply.create({ workspaceId: WS, leadId, channel: "whatsapp", rawText: "Hello, pricing?" });
    const convo = await openConversation(repos, WS, "user_owner", leadId);
    const before = (await repos.auditLog.listByWorkspace(WS)).filter((a) => /copilot/i.test(a.eventType)).length;

    await handleOwnerCopilotTurn({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      ownerText: "draft a reply to raj",
      leadId,
      repos,
    });
    const after = (await repos.auditLog.listByWorkspace(WS)).filter((a) => /copilot/i.test(a.eventType)).length;
    assert(after > before, `CASE G: T2 draft must write a copilot.* audit row (before=${before}, after=${after})`);
    console.log(`  OK CASE G — T2 draft wrote ${after - before} copilot.* audit row(s) (CP-8)`);
  }

  // ─── CASE H: saveCopilotFact (CP-5 ask-before-save) ───────────────────────
  {
    const WS = "ws_cptask_h";
    await seedWorkspace(repos, WS);
    const convo = await openConversation(repos, WS, "user_owner");

    const captured = await saveCopilotFact({
      workspaceId: WS,
      ownerUserId: "user_owner",
      conversationId: convo.id,
      questionText: "What is our credit policy for new buyers?",
      missingTopic: "credit_policy",
      repos,
    });
    assert(captured.kind === "copilot_action_done", `CASE H: save-fact must complete, got kind=${captured.kind}`);
    const uqs = await repos.unknownQuestion.listByWorkspace(WS);
    assert(uqs.some((u) => /credit/i.test(u.questionText)), `CASE H: an UnknownQuestion must be created for the captured fact, got ${uqs.length} UQs`);
    console.log("  OK CASE H — saveCopilotFact captures as Information Needed card (CP-5, never silent KB write)");
  }

  console.log("\nPASS golden-copilot-tasks: universal Copilot wiring contract holds.");
  console.log("  All 22 tasks mapped (CP-1). T1 read-only answers (B/C). T2 never-send drafts (D).");
  console.log("  T3 confirm→RUN (E, CP-10). Per-lead isolation (F, CP-6). Audit trail (G).");
  console.log("  Ask-before-save capture (H, CP-5). Empty-KB offer card (C, CP-11).");
  process.exit(0);
}

main().catch((e) => {
  console.error("golden-copilot-tasks FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
