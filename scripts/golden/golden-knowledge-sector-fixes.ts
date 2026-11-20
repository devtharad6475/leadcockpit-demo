/**
 * golden-knowledge-sector-fixes.ts — pins the seven knowledge / setup defects
 * found by the 2026-09-27 break test (scripts/probes/knowledge-sector-probe.ts,
 * scanned-pdf-probe.ts, checklist-shape-probe.ts). Every case below failed on
 * the code before the fix (see docs/LOGIC.md KNOWLEDGE-OWNER-LEVEL).
 *
 *   K1  an owner-approved answer (bulk "Approve safe answers", source still
 *       "website") is never replaced or demoted by a later document
 *   K2  an answer given in the setup interview, or on an Information Needed
 *       card, reaches the copy the AI searches (and the old one leaves it)
 *   K3  a rejected AI key stops extraction after ONE call, as a plain-English
 *       4xx, with no raw provider JSON on screen
 *   K4  a scanned PDF (page markers only) reads as "no text" and no AI call is
 *       made on marker-only text
 *   K5  Hindi / Gujarati answers are compared on their words, not blanked
 *   K6  "customer" is not the sensitive topic "custom"
 *   K7  "Ready for the AI" counts only answers the AI can actually use
 *
 * Modules added by the fix are imported inside their case, so on the old code
 * each case fails on its own instead of the whole file failing to load.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-knowledge-sector-fixes.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { mergeExtractedAnswers } from "@/services/KnowledgeAnswerMergeService";
import {
  answerDocumentQuestions,
  approveAllSafeKnowledgeAnswers,
  approveKnowledgeQuestionAnswer,
  getWorkspaceChecklist,
  listKnowledgeQuestionAnswers,
} from "@/services/DocumentQuestionAnsweringService";
import { recordSetupAnswer } from "@/services/SetupInterviewService";
import { answerUnknownQuestionGroup } from "@/services/AISettingsService";
import { searchKnowledge } from "@/services/KnowledgeBaseService";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";

const repos = createJsonRepos();
let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}
const ws = (tag: string) => `ws_gold_ksf_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;

function answerRow(over: Partial<KnowledgeQuestionAnswer>): KnowledgeQuestionAnswer {
  return {
    id: `kqa_${Math.random().toString(36).slice(2)}`,
    workspaceId: "w",
    domainKey: "company_overview",
    domainTitle: "Company",
    questionKey: "what_company_does",
    question: "What does the company do in simple business language?",
    answer: "",
    answerStatus: "answered",
    sourceType: "website",
    confidenceScore: 0.9,
    isCanonical: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  } as KnowledgeQuestionAnswer;
}

function mergeOne(data: AppData, workspaceId: string, row: KnowledgeQuestionAnswer, answer: string, sourceId = "doc1") {
  mergeExtractedAnswers({
    workspaceId, sourceType: "document", sourceId, sourceTitle: "brochure.pdf", data, now: "2026-09-10T00:00:00.000Z",
    extractedAnswers: [{
      domainKey: row.domainKey, domainTitle: "x", questionKey: row.questionKey, question: row.question,
      answer, answerStatus: "answered", sourceType: "document", confidenceScore: 0.8, sourceSnippet: "brochure line",
    } as never],
  });
}

/** An image-only PDF — what a phone-scanned rate card is to a text reader. */
function imageOnlyPdf(pages: number) {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  return buildPdf(objs);
}

/** A one-page PDF with a real text layer. */
function textPdf(line: string) {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function buildPdf(objs: string[]) {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((obj, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function withRejectingProvider<T>(fn: (calls: () => number) => Promise<T>) {
  process.env.PLATFORM_DEEPSEEK_API_KEY = "golden-not-a-real-key";
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****-key is invalid", type: "authentication_error", param: null, code: "invalid_request_error" } }), { status: 401, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PLATFORM_DEEPSEEK_API_KEY;
  }
}

async function main() {
  console.log("golden-knowledge-sector-fixes — 2026-09-27 knowledge break test (K1-K7)\n");

  await check("K1a — a bulk-approved website answer is not replaced by a later document", () => {
    const approved = answerRow({ workspaceId: "w1", answer: "We manufacture zari thread.", isUserApproved: true, reviewedAt: "2026-09-02T00:00:00.000Z" });
    const data = { knowledgeQuestionAnswers: [approved], unknownQuestions: [] } as unknown as AppData;
    mergeOne(data, "w1", approved, "We trade imported polyester embroidery thread and sequins from 3 warehouses in 12 states.");
    const after = data.knowledgeQuestionAnswers!.find((a) => a.id === approved.id)!;
    assert.equal(after.answer, "We manufacture zari thread.", "the owner-approved answer was silently replaced");
    assert.equal(after.isUserApproved, true);
    assert.equal(after.answerStatus, "answered");
    assert.equal(data.unknownQuestions!.filter((q) => q.status === "open").length, 1, "the owner must get ONE card to choose");
  });

  await check("K1b — a contradicting document does not demote an approved answer to conflict", () => {
    const approved = answerRow({ workspaceId: "w1b", questionKey: "moq", question: "What minimum order quantity rules apply?", answer: "Minimum order is 5 kg per shade.", isUserApproved: true });
    const data = { knowledgeQuestionAnswers: [approved], unknownQuestions: [] } as unknown as AppData;
    mergeOne(data, "w1b", approved, "Minimum order is 25 kg per shade.", "doc2");
    const after = data.knowledgeQuestionAnswers![0];
    assert.equal(after.answerStatus, "answered", `status became ${after.answerStatus} without the owner`);
    assert.equal(after.answer, "Minimum order is 5 kg per shade.");
    assert.ok(data.unknownQuestions!.some((q) => q.status === "open" && q.conflictSourcesJson), "the disagreement must still reach the owner as a card");
  });

  await check("K1c — an UNapproved website answer can still be improved by a document (control)", () => {
    const row = answerRow({ workspaceId: "w1c", answer: "Zari.", isUserApproved: false });
    const data = { knowledgeQuestionAnswers: [row], unknownQuestions: [] } as unknown as AppData;
    mergeOne(data, "w1c", row, "We manufacture metallic zari thread and sell it to saree weavers across Gujarat.", "doc3");
    assert.match(data.knowledgeQuestionAnswers![0].answer || "", /metallic zari/);
  });

  await check("K1d — bulk approval records which answers the owner approved", async () => {
    const W = ws("bulk");
    await ensureWorkspace(repos, W);
    const checklist = await getWorkspaceChecklist(W, repos);
    const target = checklist.questions.find((q) => /customers use/i.test(q.question)) || checklist.questions.find((q) => !q.humanReviewRequired)!;
    await repos.mutateAll!((data) => {
      data.knowledgeQuestionAnswers ||= [];
      data.knowledgeQuestionAnswers.push(answerRow({ workspaceId: W, domainKey: target.domainKey, questionKey: target.questionKey, question: target.question, answer: "sales@example.test", sourceType: "document", confidenceScore: 0.92, sourceSnippet: "Write to sales@example.test", humanReviewRequired: false }));
      return null;
    });
    const result = await approveAllSafeKnowledgeAnswers(W, repos);
    assert.equal(result.approvedCount, 1, `approved ${result.approvedCount}`);
    const audit = await repos.mutateAll!((data) => (data.auditLogs || []).find((log) => log.workspaceId === W && log.eventType === "knowledge.safe_answers.bulk_approved"));
    const ids = (audit?.payload as { approvedAnswerIds?: string[] } | undefined)?.approvedAnswerIds || [];
    assert.equal(ids.length, 1, "the bulk-approval record must name the answers the owner approved");
  });

  await check("K2a — a correction in the setup interview replaces what the AI searches", async () => {
    const W = ws("setup");
    await ensureWorkspace(repos, W);
    const q = (await getWorkspaceChecklist(W, repos)).questions[0];
    await repos.mutateAll!((data) => {
      data.knowledgeQuestionAnswers ||= [];
      data.knowledgeQuestionAnswers.push(answerRow({ workspaceId: W, domainKey: q.domainKey, questionKey: q.questionKey, question: q.question, answer: "Minimum order quantity is 50 kg per shade.", sourceType: "document", sourceSnippet: "MOQ 50 kg" }));
      return null;
    });
    const row = (await listKnowledgeQuestionAnswers(W, repos)).find((a) => a.domainKey === q.domainKey && a.questionKey === q.questionKey)!;
    await approveKnowledgeQuestionAnswer(W, row.id, repos);
    await recordSetupAnswer({ workspaceId: W, domainKey: q.domainKey, questionKey: q.questionKey, answer: "Minimum order quantity is 100 kg per shade.", ownerWords: "100 kg now", repos });
    const text = (await searchKnowledge(W, "minimum order quantity per shade", repos)).chunks.map((c) => c.chunkText).join(" || ");
    assert.ok(/100 kg/.test(text), "the corrected answer is not in what the AI searches");
    assert.ok(!/50 kg/.test(text), "the AI still finds the old 50 kg answer");
  });

  await check("K2b — a first answer given in the setup interview is findable", async () => {
    const W = ws("setup2");
    await ensureWorkspace(repos, W);
    const q = (await getWorkspaceChecklist(W, repos)).questions[0];
    await recordSetupAnswer({ workspaceId: W, domainKey: q.domainKey, questionKey: q.questionKey, answer: "We make metallic zari thread in Surat for saree weavers.", ownerWords: "zari thread surat", repos });
    const found = await searchKnowledge(W, "metallic zari thread Surat saree weavers", repos);
    assert.ok(found.chunks.some((c) => /zari thread/i.test(c.chunkText)), `chunks found: ${found.chunks.length}`);
  });

  await check("K2c — an Information Needed card correction removes the old answer from search", async () => {
    const W = ws("card");
    await ensureWorkspace(repos, W);
    const q = (await getWorkspaceChecklist(W, repos)).questions[0];
    await repos.mutateAll!((data) => {
      data.knowledgeQuestionAnswers ||= [];
      data.knowledgeQuestionAnswers.push(answerRow({ workspaceId: W, domainKey: q.domainKey, questionKey: q.questionKey, question: q.question, answer: "Minimum order quantity is 50 kg per shade.", sourceType: "document", sourceSnippet: "MOQ 50 kg" }));
      return null;
    });
    const row = (await listKnowledgeQuestionAnswers(W, repos)).find((a) => a.domainKey === q.domainKey && a.questionKey === q.questionKey)!;
    await approveKnowledgeQuestionAnswer(W, row.id, repos);
    await answerUnknownQuestionGroup(W, [`uq_gold_${Date.now()}`], "Minimum order quantity is 100 kg per shade.", true, repos, { domainKey: q.domainKey, relatedQuestionKeys: [q.questionKey] });
    const text = (await searchKnowledge(W, "minimum order quantity per shade", repos)).chunks.map((c) => c.chunkText).join(" || ");
    assert.ok(!/50 kg/.test(text), "the AI still finds the old 50 kg answer after the card was answered");
  });

  await check("K3 — a rejected key stops after one call with a plain 4xx sentence", async () => {
    const W = ws("badkey");
    await ensureWorkspace(repos, W);
    await withRejectingProvider(async (calls) => {
      let thrown: unknown;
      try {
        await answerDocumentQuestions({ workspaceId: W, documentText: "Om Jari Udyog makes gold zari thread in Surat. Minimum order is 10 kg per shade.", documentMetadata: { title: "profile.txt", sourceType: "document" } }, repos);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, "a rejected key must stop the extraction");
      const error = thrown as Error & { statusCode?: number };
      assert.equal(error.name, "NeedsActionError", `thrown ${error.name}: routes turn this into a 500 "our fault"`);
      assert.ok((error.statusCode || 500) < 500, "must be a 4xx");
      assert.match(error.message, /AI key was rejected/);
      assert.doesNotMatch(error.message, /\{"|authentication_error|invalid_request_error/, "raw provider JSON reached the owner");
      assert.equal(calls(), 1, `the rejected key was sent ${calls()} times — it must stop at the first`);
      const runs = await repos.mutateAll!((data) => (data.knowledgeExtractionRuns || []).filter((r) => r.workspaceId === W));
      assert.doesNotMatch(runs[0]?.errorMessage || "", /\{"|authentication_error/, "the extraction panel would show raw JSON");
    });
    const { ownerFacingFailureText } = await import("@/llm/provider-failure");
    const legacy = 'Extraction did not produce usable LLM answers. Knowledge Base was not changed. Reason: Provider request failed with 401: {"error":{"message":"bad","type":"authentication_error"}} (23 batches)';
    assert.doesNotMatch(ownerFacingFailureText(legacy), /\{"|authentication_error/, "a run stored before the fix still shows raw JSON");
  });

  await check("K4a — a scanned PDF reads as no text; a real PDF keeps its words", async () => {
    const { extractPdfText, stripPdfPageMarkers } = await import("@/lib/pdf-text");
    assert.equal(await extractPdfText(imageOnlyPdf(3)), "", "a 3-page scan must read as empty so the scanned-PDF message shows");
    assert.equal(await extractPdfText(imageOnlyPdf(1)), "");
    const real = await extractPdfText(textPdf("Minimum order is 10 kg per shade of gold zari."));
    assert.match(real, /Minimum order is 10 kg/);
    assert.doesNotMatch(real, /--\s*\d+\s+of\s+\d+\s*--/, "page markers must not reach the AI");
    assert.equal(stripPdfPageMarkers("\n\n-- 1 of 2 --\n\n-- 2 of 2 --\n"), "");
  });

  await check("K4b — marker-only text is refused before any AI call", async () => {
    const W = ws("scan");
    await ensureWorkspace(repos, W);
    await withRejectingProvider(async (calls) => {
      let thrown: unknown;
      try {
        await answerDocumentQuestions({ workspaceId: W, documentText: "Source file: rates.pdf\n\n-- 1 of 3 --\n\n-- 2 of 3 --\n\n-- 3 of 3 --", documentMetadata: { title: "rates.pdf", sourceType: "document" } }, repos);
      } catch (error) {
        thrown = error;
      }
      assert.equal(calls(), 0, `${calls()} AI calls were made on a document with no text`);
      assert.equal((thrown as Error | undefined)?.name, "NeedsActionError");
      assert.match((thrown as Error).message, /scanned PDF/);
    });
  });

  await check("K5 — re-reading the same Hindi document raises no conflict; Gujarati figures are compared", () => {
    const hindi = "हम सूरत में ज़री धागा बनाते हैं और थोक में बेचते हैं।";
    const row = answerRow({ workspaceId: "w5", answer: hindi, sourceType: "document", sourceId: "docA" });
    const data = { knowledgeQuestionAnswers: [row], unknownQuestions: [] } as unknown as AppData;
    mergeOne(data, "w5", row, hindi, "docA");
    assert.notEqual(data.knowledgeQuestionAnswers![0].answerStatus, "conflict", "the same Hindi sentence was called a contradiction");
    assert.equal(data.unknownQuestions!.length, 0);
    const guj = answerRow({ workspaceId: "w5b", questionKey: "moq", question: "What minimum order quantity rules apply?", answer: "ન્યૂનતમ ઓર્ડર 50 કિલો", sourceType: "document" });
    const d2 = { knowledgeQuestionAnswers: [guj], unknownQuestions: [] } as unknown as AppData;
    mergeOne(d2, "w5b", guj, "ન્યૂનતમ ઓર્ડર 50 કિલો", "docB");
    assert.notEqual(d2.knowledgeQuestionAnswers![0].answerStatus, "conflict", "the same Gujarati answer from another document is agreement");
  });

  await check("K6 — 'customer' questions can be bulk-approved; custom work still cannot", async () => {
    const W = ws("custom");
    await ensureWorkspace(repos, W);
    const checklist = await getWorkspaceChecklist(W, repos);
    const plain = checklist.questions.find((q) => /customers use/i.test(q.question));
    assert.ok(plain, "fixture question 'What email address should customers use?' missing from the default checklist");
    await repos.mutateAll!((data) => {
      data.knowledgeQuestionAnswers ||= [];
      data.knowledgeQuestionAnswers.push(answerRow({ workspaceId: W, domainKey: plain.domainKey, questionKey: plain.questionKey, question: plain.question, answer: "sales@example.test", sourceType: "document", confidenceScore: 0.92, sourceSnippet: "Write to sales@example.test", humanReviewRequired: false }));
      data.knowledgeQuestionAnswers.push(answerRow({ workspaceId: W, domainKey: "products", questionKey: "custom_orders_gold", question: "Do you accept customised orders?", answer: "Yes, customised shades on request.", sourceType: "document", confidenceScore: 0.95, sourceSnippet: "Customised shades on request", humanReviewRequired: false }));
      data.knowledgeQuestionAnswers.push(answerRow({ workspaceId: W, domainKey: "export", questionKey: "customs_docs_gold", question: "Which customs documents do you provide?", answer: "Invoice and packing list.", sourceType: "document", confidenceScore: 0.95, sourceSnippet: "Invoice and packing list", humanReviewRequired: false }));
      return null;
    });
    await approveAllSafeKnowledgeAnswers(W, repos);
    const rows = await repos.mutateAll!((data) => (data.knowledgeQuestionAnswers || []).filter((a) => a.workspaceId === W && a.answer?.trim()));
    assert.equal(rows.find((a) => a.questionKey === plain.questionKey)?.isUserApproved, true, "a plain 'customers' question was treated as sensitive");
    for (const key of ["custom_orders_gold", "customs_docs_gold"]) {
      const row = rows.find((a) => a.questionKey === key);
      if (row) assert.notEqual(row.isUserApproved, true, `${key} is custom work / customs and must stay for a person`);
    }
    // The rule itself, on the real bank's wording.
    const { isSensitiveQuestion } = await import("@/services/DocumentQuestionAnsweringService");
    const sensitive = (question: string, questionKey = "q", domainKey = "d") => isSensitiveQuestion({ domainKey, questionKey, question });
    assert.equal(sensitive("What email address should customers use?", "customer_email", "customer_service"), false);
    assert.equal(sensitive("Who are your main customer types?", "customer_types", "customers"), false);
    for (const question of [
      "What is the minimum order for a customised product?",
      "How does customisation change the price?",
      "Do you take customized orders?",
      "What are the HS (customs) codes for your main products?",
      "Do you accept custom orders?",
    ]) assert.equal(sensitive(question), true, `"${question}" must stay for a person`);
    assert.equal(sensitive("Anything", "custom_orders"), true, "a custom_ question key is custom work");
    assert.equal(sensitive("Do you give a discount to repeat customers?"), true, "other sensitive topics stay blocked");
  });

  await check("K7 — 'Ready for the AI' counts only answers the AI can use", async () => {
    const { knowledgeReadiness } = await import("@/lib/knowledge-readiness");
    const section = (approved: boolean) => [
      { domainKey: "company", answer: "We make zari.", answerStatus: "answered", isUserApproved: approved, sourceType: "document" },
      { domainKey: "company", answer: "Surat.", answerStatus: "answered", isUserApproved: approved, sourceType: "document" },
    ];
    const unapproved = knowledgeReadiness(section(false));
    assert.equal(unapproved.readySections, 0, "a section of answers never OK'd was counted as ready for the AI");
    assert.equal(unapproved.waitingForOk, 2);
    const approved = knowledgeReadiness(section(true));
    assert.equal(approved.readySections, 1);
    assert.equal(approved.waitingForOk, 0);
    const source = readFileSync(path.join(process.cwd(), "src/app/sections/KnowledgeBaseSection.tsx"), "utf8");
    assert.match(source, /knowledgeReadiness\(/, "the Knowledge Base screen must count readiness with the shared rule");
    assert.match(source, /can't use until you OK/, "the screen must say how many answers the AI can't use yet");
    const service = readFileSync(path.join(process.cwd(), "src/services/DocumentQuestionAnsweringService.ts"), "utf8");
    assert.match(service, /return isAnswerServable\(item\)/, "server and screen must share one definition of 'usable by the AI'");
  });

  console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
  if (failed) {
    console.error("\nFAIL golden-knowledge-sector-fixes");
    process.exit(1);
  }
  console.log("PASS golden-knowledge-sector-fixes: owner-approved answers stay, corrections reach search, key/scan failures are plain, Indic text compares, readiness is honest.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
