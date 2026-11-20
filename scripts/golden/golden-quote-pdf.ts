/**
 * Golden test — Quote PDF generation (GAP-7).
 *
 * build-right Phase 3 — written BEFORE the feature code lands in a route. This
 * test DEFINES the contract QuotePdfService must satisfy.
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-7. Before this, only
 * Policy + Knowledge-Questionnaire PDFs existed; Quotes had no PDF.
 *
 * Hand-computed BEFORE writing the assertions (the Golden Thread):
 *
 *   Setup: a lead "Balaji Zari" + a quote with TWO line items:
 *     Item A: "Gold border 50mm" - 100 metre x INR 150.00 = INR 15000.00
 *     Item B: "Red zari thread"  -  20 kg      x INR 800.00 = INR 16000.00
 *   grandTotal snapshot stored on the quote = 31000.00
 *
 *   CASE A — generates a REAL PDF (proves it's not a stub):
 *     - the returned MediaCatalogItem has fileType "application/pdf"
 *     - the buffer starts with the PDF magic "%PDF-1.4"
 *     - the buffer ends with the PDF EOF marker "%%EOF"
 *     - the item is linked to the lead + workspace
 *
 *   CASE B — the PDF content is honest (no-hallucination):
 *     - the line-item product names appear in the extracted text
 *     - the grand total "31,000.00" appears (matches the stored snapshot, NOT a
 *       recompute — so it always agrees with what the owner approved)
 *     - the review note is present (sensitive-topic reminder)
 *
 *   CASE C — non-existent quote throws (no silent empty PDF).
 *
 *   CASE D — the grand total on the PDF is the STORED snapshot, even if the
 *     line items would recompute differently (proves we don't recompute).
 *
 * Test isolation (Gate #8): own workspace id (ws_quote_pdf_*).
 * Run: npm run golden:quote-pdf
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { generateQuotePdf } from "@/services/QuotePdfService";
import { readMediaCatalogFile } from "@/services/MediaCatalogService";
import { buildPdfFromLines } from "@/lib/pdf-writer";
import { inspectPdf } from "./_helpers/pdf-inspection";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function seedWorkspace(repos: RepositoryBundle, id: string) {
  await repos.workspace.create({ id, name: `Test WS ${id}`, status: "active" });
  await repos.businessProfile.create({ workspaceId: id, companyName: "Balaji Zari Udyog", businessType: "Textile/Zari" });
}

async function seedLead(repos: RepositoryBundle, ws: string) {
  return repos.lead.createLead({
    workspaceId: ws,
    companyName: "Balaji Zari",
    contactName: "Ramesh",
    source: "manual",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
    doNotContact: false,
    consentStatus: "none",
  });
}



async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: generates a REAL PDF (magic + EOF + linked) ───────────────────
  {
    const WS = "ws_quote_pdf_a";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS);
    // Hand-computed: 100×150 + 20×800 = 15000 + 16000 = 31000.00
    const quote = await repos.quote.create({
      workspaceId: WS,
      leadId: lead.id,
      status: "draft",
      currencyCode: "INR",
      grandTotal: 31000,
      lineItems: [
        { id: "li1", productName: "Gold border 50mm", quantity: 100, unit: "metre", unitPrice: 150, currencyCode: "INR", lineTotal: 15000 },
        { id: "li2", productName: "Red zari thread", quantity: 20, unit: "kg", unitPrice: 800, currencyCode: "INR", lineTotal: 16000 },
      ],
    });

    const item = await generateQuotePdf({ workspaceId: WS, quoteId: quote.id }, repos);
    const stored = await readMediaCatalogFile(WS, item.id, repos);
    assert(stored, "the generated PDF could not be read back from the store");
    const bytes = stored!.bytes;

    assert(item.fileType === "application/pdf", `CASE A: fileType is application/pdf, got ${item.fileType}`);
    assert(bytes.subarray(0, 8).toString("utf8").startsWith("%PDF-1.4"), "CASE A: PDF starts with %PDF-1.4 magic");
    assert(bytes.subarray(-6).toString("utf8").includes("%%EOF"), "CASE A: PDF ends with %%EOF");
    assert(item.leadId === lead.id, "CASE A: item linked to lead");
    assert(item.workspaceId === WS, "CASE A: item scoped to workspace");
    console.log("✅ CASE A — real PDF generated (magic + EOF + linked to lead/workspace)");
  }

  // ─── CASE B: content is honest (items + total + review note) ───────────────
  {
    const WS = "ws_quote_pdf_b";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS);
    const quote = await repos.quote.create({
      workspaceId: WS,
      leadId: lead.id,
      status: "sent",
      currencyCode: "INR",
      grandTotal: 31000,
      validityNote: "Valid for 7 days",
      lineItems: [
        { id: "li1", productName: "Gold border 50mm", quantity: 100, unit: "metre", unitPrice: 150, currencyCode: "INR", lineTotal: 15000 },
        { id: "li2", productName: "Red zari thread", quantity: 20, unit: "kg", unitPrice: 800, currencyCode: "INR", lineTotal: 16000 },
      ],
    });

    const item = await generateQuotePdf({ workspaceId: WS, quoteId: quote.id }, repos);
    const stored = await readMediaCatalogFile(WS, item.id, repos);
    assert(stored, "the generated PDF could not be read back from the store");
    const bytes = stored!.bytes;
    const { text } = await inspectPdf(bytes);

    assert(/Gold border 50mm/.test(text), `CASE B: line item "Gold border 50mm" present`);
    assert(/Red zari thread/.test(text), `CASE B: line item "Red zari thread" present`);
    // Hand-computed: 31000.00 formatted en-IN = "31,000.00"
    assert(/31,000\.00/.test(text), `CASE B: grand total 31,000.00 present, got a miss`);
    assert(/Review Note/i.test(text) || /review/i.test(text), "CASE B: review note present (sensitive-topic reminder)");
    console.log("✅ CASE B — content honest: line items + grand total 31,000.00 + review note");
  }

  // ─── CASE C: non-existent quote throws (no silent empty PDF) ───────────────
  {
    const WS = "ws_quote_pdf_c";
    await seedWorkspace(repos, WS);
    let threw = false;
    try {
      await generateQuotePdf({ workspaceId: WS, quoteId: "does-not-exist" }, repos);
    } catch {
      threw = true;
    }
    assert(threw, "CASE C: non-existent quote must throw (no silent empty PDF)");
    console.log("✅ CASE C — non-existent quote throws (no silent empty PDF)");
  }

  // ─── CASE D: PDF shows the STORED grandTotal, not a recompute ──────────────
  // The owner approved grandTotal=25000 even though items sum to 31000 (a manual
  // discount, or a stale snapshot). The PDF must show what the owner approved
  // (25000), proving we never silently recompute.
  {
    const WS = "ws_quote_pdf_d";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS);
    const quote = await repos.quote.create({
      workspaceId: WS,
      leadId: lead.id,
      status: "draft",
      currencyCode: "INR",
      grandTotal: 25000, // STORED snapshot (differs from the 31000 line items sum)
      lineItems: [
        { id: "li1", productName: "Gold border 50mm", quantity: 100, unit: "metre", unitPrice: 150, currencyCode: "INR", lineTotal: 15000 },
        { id: "li2", productName: "Red zari thread", quantity: 20, unit: "kg", unitPrice: 800, currencyCode: "INR", lineTotal: 16000 },
      ],
    });

    const item = await generateQuotePdf({ workspaceId: WS, quoteId: quote.id }, repos);
    const stored = await readMediaCatalogFile(WS, item.id, repos);
    assert(stored, "the generated PDF could not be read back from the store");
    const bytes = stored!.bytes;
    const { text } = await inspectPdf(bytes);
    assert(/25,000\.00/.test(text), `CASE D: PDF shows STORED grandTotal 25,000.00 (not a recompute)`);
    assert(!/31,000\.00/.test(text), "CASE D: PDF does NOT show the recomputed 31,000.00");
    console.log("✅ CASE D — PDF shows STORED grandTotal (25,000.00), not a recompute");
  }

  // ─── CASE E: pdf-writer chokepoint sanity (shared writer works standalone) ─
  {
    const buf = await buildPdfFromLines(["# Hello", "## Section", "body text"]);
    assert(buf.subarray(0, 8).toString("utf8").startsWith("%PDF-1.4"), "CASE E: shared writer emits PDF magic");
    assert(buf.subarray(-6).toString("utf8").includes("%%EOF"), "CASE E: shared writer emits EOF");
    console.log("✅ CASE E — shared pdf-writer chokepoint works (single source of truth)");
  }

  console.log("\n✅✅✅ All quote-pdf golden cases PASSED (A–E). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
