/**
 * Golden test — Owner Copilot: Quote action + 5-tier router + clarify loop.
 *
 * Phase 1.5 / skill v2 / build-right Phase 3 — written BEFORE the service
 * code. This test DEFINES the contract; the service must satisfy it.
 *
 * What this proves (the design doc docs/planning/OWNER_COPILOT_DESIGN.md):
 *
 *   CASE A — Quote math is hand-computed and exact (the Golden Thread):
 *     Owner input captured from a call → clarifying Qs answered → a Quote
 *     draft is produced. The line total + grand total MUST equal the
 *     hand-computed values:
 *       500 metres × ₹42/m = ₹21,000  (lineTotal)
 *       grandTotal (single line)     = ₹21,000
 *     No LLM is needed for the MATH — the math is pure (reuses OrderService).
 *
 *   CASE B — The 5-tier router maps every intent to its safety tier:
 *     "score this lead"           → T1 (instant, read-only)
 *     "draft a reply"             → T2 (draft → approve)
 *     "build my customer profile" → T3 (big job, confirm cost)
 *     "send a message to raj"     → T4 (touches customer, hard gate)
 *     "send price list to all"    → T5 (never from chat — deflect)
 *     The router is a PURE LOOKUP (no AI decides routing). It must NEVER
 *     mis-route a T5 (bulk/customer-dangerous) intent down to T1/T2.
 *
 *   CASE C — Never-guess (no-hallucination): when required quote fields are
 *     MISSING, the Copilot MUST throw (ask for clarification), NOT produce a
 *     draft. It never invents quantity/price/product.
 *
 *   CASE D — Never-auto-send (no-auto-outreach): the Quote handler produces a
 *     DRAFT (status="draft"), NEVER status="sent". Sending requires a SEPARATE
 *     explicit approve() call. The handler does NOT contact the customer.
 *
 *   CASE E — Clarify-bounded: the clarification constants match the operator's
 *     locked answers (Q2): max 4 questions per batch, max 3 batches.
 *
 *   CASE F — Audit trail: when logAudit=true, the draft step writes an audit
 *     row via AuditLogService with a copilot.* action type.
 *
 *   CASE G — New-fact "ask before save": when the owner reveals a fact not in
 *     the KB (e.g. a bulk rate below standard), the handler returns a
 *     `offerSaveToKnowledge` flag = true. It does NOT silently save.
 *
 * Test isolation (build-right Gate #8): each case uses its OWN unique workspace
 * ID (ws_copilot_a/b/...). The golden preload pins each run to a process-unique
 * LEADGEN_DATA_DIR, so cases never share state. No cross-case cleanup needed.
 *
 * Run: npm run golden:copilot-quote
 *      npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-copilot-quote.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { classifyCopilotIntent, MAX_QUESTIONS_PER_BATCH, MAX_CLARIFY_BATCHES, draftQuoteFromCapture, handleOwnerCopilotTurn, type QuoteCaptureInput } from "@/services/OwnerCopilotService";
import { createJsonRepos } from "./_helpers/provider";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: Quote math is exact (the Golden Thread) ─────────────────────
  // Hand-computed BEFORE looking at the code:
  //   500 metres of "gold zari border 50mm" @ ₹42/metre
  //   lineTotal  = 500 × 42 = 21,000
  //   grandTotal = 21,000   (single line)
  {
    const WS = "ws_copilot_a";
    const capture: QuoteCaptureInput = {
      workspaceId: WS,
      leadId: "lead_raj",
      productName: "Gold Zari Border 50mm",
      quantity: 500,
      unit: "metre",
      unitPrice: 42,
      currencyCode: "INR",
      validityNote: "7 days",
    };
    const draft = await draftQuoteFromCapture(capture, repos);
    assert(draft.lineItems.length === 1, "CASE A: single line item");
    assert(draft.lineItems[0].lineTotal === 21000, `CASE A: lineTotal=21000, got ${draft.lineItems[0].lineTotal}`);
    assert(draft.grandTotal === 21000, `CASE A: grandTotal=21000, got ${draft.grandTotal}`);
    assert(draft.lineItems[0].quantity === 500, "CASE A: quantity snapshot 500");
    assert(draft.lineItems[0].unitPrice === 42, "CASE A: unitPrice snapshot 42");
    assert(draft.currencyCode === "INR", "CASE A: currency INR");
    console.log("  OK CASE A — quote math exact (500 × 42 = 21,000)");
  }

  // ─── CASE B: 5-tier router maps every intent correctly ───────────────────
  // The router is a PURE LOOKUP. It must never downgrade a dangerous intent.
  {
    assert(classifyCopilotIntent("score this lead for me").tier === "T1", "CASE B: score → T1");
    assert(classifyCopilotIntent("what is our MOQ?").tier === "T1", "CASE B: MOQ question → T1");
    assert(classifyCopilotIntent("draft a reply to raj about the quote").tier === "T2", "CASE B: draft reply → T2");
    assert(classifyCopilotIntent("make a quote for 500 metres").tier === "T2", "CASE B: draft quote → T2");
    assert(classifyCopilotIntent("build my customer profile").tier === "T3", "CASE B: ICP → T3");
    assert(classifyCopilotIntent("plan a campaign for surat buyers").tier === "T3", "CASE B: campaign → T3");
    assert(classifyCopilotIntent("send the quote to raj now").tier === "T4", "CASE B: send message → T4");
    assert(classifyCopilotIntent("send our price list to all warm leads").tier === "T5", "CASE B: bulk send → T5 (NEVER T1/T2)");
    assert(classifyCopilotIntent("delete this lead permanently").tier === "T5", "CASE B: delete → T5");
    assert(classifyCopilotIntent("wipe all customer data").tier === "T5", "CASE B: erasure → T5");
    // The dangerous bulk send must NOT be mis-routed to a safe tier.
    const bulkRoute = classifyCopilotIntent("send our price list to all warm leads");
    assert(bulkRoute.tier === "T5", `CASE B: bulk send must be T5, got ${bulkRoute.tier} (safety-critical!)`);
    console.log("  OK CASE B — 5-tier router maps all 10 intents correctly (T5 never downgraded)");
  }

  // ─── CASE C: Never-guess — missing required fields → throws, not a draft ─
  {
    const WS = "ws_copilot_c";
    // Product + quantity given, but PRICE + UNIT missing. Must NOT draft.
    const incomplete = {
      workspaceId: WS,
      leadId: "lead_raj",
      productName: "Gold Zari Border",
      quantity: 500,
      // unit, unitPrice, currencyCode deliberately missing
    } as Partial<QuoteCaptureInput> as QuoteCaptureInput;
    let threw = false;
    try {
      await draftQuoteFromCapture(incomplete, repos);
    } catch (e) {
      threw = true;
      assert(/missing|required|unit|price/i.test((e as Error).message), `CASE C: error mentions missing field, got: ${(e as Error).message}`);
    }
    assert(threw, "CASE C: missing unit+price MUST throw (never-guess), not draft");
    console.log("  OK CASE C — missing fields → refuses to draft (never-guess)");
  }

  // ─── CASE D: Never-auto-send — handler produces DRAFT, never SENT ─────────
  {
    const WS = "ws_copilot_d";
    const capture: QuoteCaptureInput = {
      workspaceId: WS,
      leadId: "lead_raj",
      productName: "Gold Zari Border 50mm",
      quantity: 500,
      unit: "metre",
      unitPrice: 42,
      currencyCode: "INR",
    };
    const draft = await draftQuoteFromCapture(capture, repos);
    assert(draft.status === "draft", `CASE D: handler must produce status="draft", got "${draft.status}"`);
    assert(draft.sentAt === undefined, "CASE D: draft must NOT have sentAt (never-auto-send)");
    console.log("  OK CASE D — handler produces DRAFT only, never sends (no-auto-outreach)");
  }

  // ─── CASE E: Clarify-bounded — max 4 Q/batch, max 3 batches ──────────────
  // 2026-08-04 rewrite (audit finding D): the old CASE E only asserted the
  // CONSTANTS equal 4/3 — it passed green while the runtime never consulted
  // them (finding C). Now we BEHAVIOURALLY prove the cap fires: drive the
  // service through MAX_CLARIFY_BATCHES+1 incomplete quote turns and assert
  // the (N+1)th emits "review manually" instead of another question.
  {
    assert(MAX_QUESTIONS_PER_BATCH === 4, `CASE E: max 4 questions/batch (operator Q2), got ${MAX_QUESTIONS_PER_BATCH}`);
    assert(MAX_CLARIFY_BATCHES === 3, `CASE E: max 3 batches (operator Q2), got ${MAX_CLARIFY_BATCHES}`);
    const WS = "ws_copilot_e";
    // Create a conversation row (the service reads/increments clarifyBatchCount on it).
    const convo = await repos.ownerCopilotConversation.create({ workspaceId: WS, ownerUserId: "user_owner" });
    // Send MAX_CLARIFY_BATCHES incomplete quote requests (no quoteCapture → asks).
    for (let i = 0; i < MAX_CLARIFY_BATCHES; i++) {
      const resp = await handleOwnerCopilotTurn({
        workspaceId: WS, ownerUserId: "user_owner", conversationId: convo.id,
        ownerText: "draft a quote for 500m gold border",
        repos,
      });
      assert(resp.kind === "copilot_question", `CASE E: batch ${i + 1} should ask (copilot_question), got ${resp.kind}`);
    }
    // The (N+1)th — must hit the bound and say "review manually", NOT re-ask.
    const overTheCap = await handleOwnerCopilotTurn({
      workspaceId: WS, ownerUserId: "user_owner", conversationId: convo.id,
      ownerText: "draft a quote for 500m gold border",
      repos,
    });
    assert(overTheCap.kind === "copilot_info", `CASE E: batch ${MAX_CLARIFY_BATCHES + 1} must hit the bound (copilot_info), got ${overTheCap.kind}`);
    assert(/review manually|not sure enough|manually/i.test(overTheCap.text), `CASE E: bound text must say 'review manually', got: ${overTheCap.text.slice(0, 80)}`);
    // And the counter persisted on the conversation must equal the cap.
    const convoAfter = await repos.ownerCopilotConversation.getById(WS, convo.id);
    assert(convoAfter?.clarifyBatchCount === MAX_CLARIFY_BATCHES, `CASE E: clarifyBatchCount should be ${MAX_CLARIFY_BATCHES} after the cap, got ${convoAfter?.clarifyBatchCount}`);
    console.log(`  OK CASE E — clarify bound ENFORCED: after ${MAX_CLARIFY_BATCHES} asks, the ${MAX_CLARIFY_BATCHES + 1}th says "review manually" (counter persisted)`);
  }

  // ─── CASE F: Audit trail — draft step writes a copilot.* audit row ────────
  {
    const WS = "ws_copilot_f";
    const before = (await repos.auditLog.listByWorkspace(WS)).length;
    const capture: QuoteCaptureInput = {
      workspaceId: WS,
      leadId: "lead_raj",
      productName: "Gold Zari Border 50mm",
      quantity: 500,
      unit: "metre",
      unitPrice: 42,
      currencyCode: "INR",
    };
    await draftQuoteFromCapture(capture, repos, { actorUserId: "user_owner", logAudit: true });
    const afterRows = (await repos.auditLog.listByWorkspace(WS)).filter((a) => /copilot/i.test(a.eventType));
    assert(afterRows.length > before || afterRows.length >= 1, `CASE F: at least 1 copilot.* audit row written, got ${afterRows.length}`);
    console.log(`  OK CASE F — audit trail written (${afterRows.length} copilot.* row(s) for the draft step)`);
  }

  // ─── CASE G: New-fact "ask before save" (never silent) ───────────────────
  {
    const WS = "ws_copilot_g";
    // Seed a ProductSettings with a standard price of ₹45. The owner's capture
    // uses ₹42 (below standard) — a new fact the KB should be offered to save.
    await repos.productSettings.upsertForWorkspace(WS, {
      products: [
        { id: "ps_gold_border", name: "Gold Zari Border 50mm", price: 45, currencyCode: "INR", unit: "metre" },
      ],
    } as never);
    const capture: QuoteCaptureInput = {
      workspaceId: WS,
      leadId: "lead_raj",
      productName: "Gold Zari Border 50mm",
      productId: "ps_gold_border",
      quantity: 500,
      unit: "metre",
      unitPrice: 42,
      currencyCode: "INR",
    };
    const draft = await draftQuoteFromCapture(capture, repos);
    assert(draft.offerSaveToKnowledge === true, "CASE G: a below-standard price MUST offer to save (not silent)");
    assert(typeof draft.saveFactSuggestion === "string" && draft.saveFactSuggestion.length > 0, "CASE G: save suggestion text provided");
    console.log("  OK CASE G — below-standard price offers to save (never silent auto-save)");
  }

  // ─── CASE H: T5 deflect fires even when quoteCapture is present ──────────
  // 2026-08-04 (audit follow-up): Finding B's short-circuit
  // (`if (quoteCapture) classified = {T2,draft_quote}`) ran BEFORE the T5 check,
  // so a T5 phrase + quoteCapture bypassed the deflect. CASE B only tests the
  // PURE classifier; this case proves the turn HANDLER honours T5 first even
  // when structured quote fields are attached — i.e. the safety wall holds on
  // the integration path, not just in the pure function.
  {
    const WS = "ws_copilot_h";
    const convo = await repos.ownerCopilotConversation.create({ workspaceId: WS, ownerUserId: "user_owner" });
    const capture: QuoteCaptureInput = {
      workspaceId: WS,
      leadId: "lead_raj",
      productName: "Gold Zari Border 50mm",
      quantity: 500,
      unit: "metre",
      unitPrice: 42,
      currencyCode: "INR",
    };
    // T5 phrase in the text, BUT quoteCapture also present. T5 must win.
    const resp = await handleOwnerCopilotTurn({
      workspaceId: WS, ownerUserId: "user_owner", conversationId: convo.id,
      ownerText: "send our price list to all warm leads",
      quoteCapture: capture,
      repos,
    });
    assert(resp.tier === "T5", `CASE H: T5 phrase must deflect even with quoteCapture present, got tier=${resp.tier} (SAFETY: T5-first bypass)`);
    assert(resp.kind === "copilot_deflect", `CASE H: expected copilot_deflect, got ${resp.kind}`);
    // And no quote should have been drafted.
    const quotes = await repos.quote.listByLead(WS, "lead_raj");
    assert(quotes.length === 0, `CASE H: no quote drafted when T5 deflects, got ${quotes.length}`);
    console.log("  OK CASE H — T5 deflect wins over quoteCapture (safety wall holds on the integration path)");
  }

  // ─── CASE I: CP-6 per-lead isolation — quoteCapture.leadId is validated ──
  // 2026-08-04 (audit follow-up): the quote route built quoteCapture.leadId
  // straight from the request body with no existence/scoping check, so a quote
  // could be orphaned to an arbitrary / non-existent leadId. This case proves
  // the SERVICE refuses to draft against a leadId that doesn't exist in the
  // workspace (CP-6: actions are per-lead-ISOLATED, not per-lead-claimed).
  {
    const WS = "ws_copilot_i";
    const convo = await repos.ownerCopilotConversation.create({ workspaceId: WS, ownerUserId: "user_owner" });
    const capture: QuoteCaptureInput = {
      workspaceId: WS,
      leadId: "lead_does_not_exist", // ← never seeded in WS
      productName: "Gold Zari Border 50mm",
      quantity: 500,
      unit: "metre",
      unitPrice: 42,
      currencyCode: "INR",
    };
    const resp = await handleOwnerCopilotTurn({
      workspaceId: WS, ownerUserId: "user_owner", conversationId: convo.id,
      ownerText: "draft a quote for 500m gold border at 42",
      quoteCapture: capture,
      repos,
    });
    // Must NOT produce a draft — the leadId is invalid. Expect a refusal/ask,
    // not a copilot_draft.
    assert(resp.kind !== "copilot_draft", `CASE I: invalid leadId must NOT produce a draft, got kind=${resp.kind} (CP-6 leadId validation)`);
    assert(/which lead|no lead|lead.*exist|invalid|doesn't exist|does not exist/i.test(resp.text), `CASE I: refusal text should explain the lead problem, got: ${resp.text.slice(0, 80)}`);
    // And no orphan quote row should exist.
    const orphanQuotes = await repos.quote.listByLead(WS, "lead_does_not_exist");
    assert(orphanQuotes.length === 0, `CASE I: no orphan quote for invalid leadId, got ${orphanQuotes.length}`);
    console.log("  OK CASE I — invalid leadId rejected (CP-6 per-lead isolation enforced, no orphan quotes)");
  }

  console.log("\nPASS golden-copilot-quote: all 9 cases match the Owner Copilot contract.");
  console.log("  Quote math: 500 × ₹42 = ₹21,000 (Golden Thread — pure, no LLM).");
  console.log("  5-tier router: T1/T2/T3/T4/T5 mapped; T5 (bulk/delete) never downgraded — even when");
  console.log("  quoteCapture is attached (CASE H, the integration path, not just the pure classifier).");
  console.log("  CP-6 leadId validated (CASE I). Never-guess, never-auto-send, audit trail, ask-before-save.");
  process.exit(0);
}

main().catch((e) => {
  console.error("golden-copilot-quote FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
