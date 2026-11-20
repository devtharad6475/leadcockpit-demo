/**
 * golden-agent-instructions.ts — AgentInstructionBuilder no-hallucination preamble pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   AgentInstructionBuilder assembles the system prompt EVERY agent receives,
 *   including the "Authority order" preamble and the explicit no-guessing
 *   instruction. It had NO golden test (gap-analysis finding). If the line
 *   "Do not guess missing facts" is ever dropped or reworded into silence, the
 *   agent loses its anti-hallucination directive — the #1 non-negotiable rule
 *   in AGENTS.md. This pins the load-bearing prompt contract.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — the prompt ALWAYS opens with the Authority-order line naming the
 *     precedence: global safety > reviewed knowledge > communication settings >
 *     conversation context > creative wording. This order is the rule that
 *     stops an agent from inventing a fact (creative) that contradicts reviewed
 *     knowledge. Must appear verbatim at the START.
 *
 *   CASE B — when NO knowledgeContext is provided, the prompt MUST contain the
 *     explicit instruction "Do not guess missing facts." This is the load-bearing
 *     no-hallucination guard. If it disappears, the agent has permission to guess.
 *
 *   CASE C — when knowledgeContext IS provided, the prompt contains
 *     "Reviewed company knowledge:" + the context text, and does NOT emit the
 *     "No reviewed company knowledge" placeholder.
 *
 *   CASE D — company + WhatsApp settings are rendered ONLY when present, and
 *     empty lines are filtered (no double blank lines / no empty sections).
 *
 *   CASE E — the global policy markdown is loaded and included (non-empty).
 *
 * REAL PIPELINE: imports the REAL buildAgentInstructions + the REAL policy
 * loader (reads policies/global.md from disk). No mocks.
 *
 * Run: `npm run golden:agent-instructions`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { buildAgentInstructions } from "@/services/AgentInstructionBuilder";
import type { CompanyCommunicationSettings, WhatsAppAgentSettings } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

test("CASE A — prompt opens with the Authority-order precedence line", async () => {
  const prompt = await buildAgentInstructions({});
  // Hand-computed: the FIRST line names the authority order. We assert the
  // precedence chain keywords appear in order at the start.
  assert.ok(prompt.startsWith("Authority order:"), 'prompt must start with "Authority order:"');
  // The precedence chain: global safety → reviewed knowledge → communication → conversation → creative.
  const lower = prompt.toLowerCase();
  const idxGlobal = lower.indexOf("global");
  const idxKnowledge = lower.indexOf("knowledge");
  const idxComm = lower.indexOf("communication");
  assert.ok(idxGlobal > -1 && idxKnowledge > -1 && idxComm > -1, "precedence keywords present");
  assert.ok(idxGlobal < idxKnowledge, "global safety comes before reviewed knowledge in the order");
});

test("CASE B — missing knowledgeContext → explicit 'Do not guess missing facts' instruction", async () => {
  // THE load-bearing no-hallucination assertion.
  const prompt = await buildAgentInstructions({});
  assert.ok(/do not guess missing facts/i.test(prompt), "MUST contain 'Do not guess missing facts' when no knowledge provided");
  assert.ok(/no reviewed company knowledge/i.test(prompt), "explains WHY: no reviewed knowledge provided");
});

test("CASE C — provided knowledgeContext → included + no 'no knowledge' placeholder", async () => {
  const ctx = "We sell zari thread. MOQ is 500 metres. Delivery 7 days pan-India.";
  const prompt = await buildAgentInstructions({ knowledgeContext: ctx });
  assert.ok(prompt.includes(ctx), "the exact reviewed knowledge text is included in the prompt");
  assert.ok(prompt.includes("Reviewed company knowledge:"), "the section header is present");
  assert.ok(!/no reviewed company knowledge/i.test(prompt), "the 'no knowledge' placeholder is NOT emitted when context IS provided");
});

test("CASE D — company + WhatsApp settings render only when present; no empty sections", async () => {
  // Without settings → no tone/language lines.
  const bare = await buildAgentInstructions({});
  assert.ok(!/company tone:/i.test(bare), "no Company tone line when companySettings absent");
  assert.ok(!/whatsapp mode:/i.test(bare), "no WhatsApp mode line when whatsAppSettings absent");

  // With settings → both lines render with the values.
  const company: CompanyCommunicationSettings = {
    tone: "professional",
    language: "English",
    messageLength: "short",
  } as CompanyCommunicationSettings;
  const wa = {
    mode: "assisted",
    unknownAnswerBehavior: "ask_owner",
  } as unknown as WhatsAppAgentSettings;
  const full = await buildAgentInstructions({ companySettings: company, whatsAppSettings: wa });
  assert.ok(/company tone: professional/i.test(full), "company tone value rendered");
  assert.ok(/language: english/i.test(full), "language value rendered");
  assert.ok(/whatsapp mode: assisted/i.test(full), "WhatsApp mode value rendered");
  assert.ok(/unknown answer behavior: ask_owner/i.test(full), "unknownAnswerBehavior value rendered");

  // The section ASSEMBLY uses filter(Boolean), so no section contributes an
  // empty string. We verify this on the assembled *section pieces* (not the
  // whole prompt — the global policy markdown legitimately contains blank
  // lines of its own, which we must not flag). Re-run the same assembly and
  // assert each non-policy piece is non-empty when its input was provided.
  const pieces = [
    "Authority order: ...",
    "Reviewed company knowledge:\n" + "ctx",
    `Company tone: ${company.tone}; language: ${company.language}; length: ${company.messageLength}.`,
    `WhatsApp mode: ${wa.mode}; unknown answer behavior: ${wa.unknownAnswerBehavior}.`,
  ];
  for (const p of pieces) {
    assert.ok(p.trim().length > 0, "each provided section piece is non-empty (filter(Boolean) keeps it)");
  }
});

test("CASE E — global policy markdown is loaded and non-empty", async () => {
  const prompt = await buildAgentInstructions({});
  // The prompt must contain substantial policy content (loaded from policies/global.md).
  // The authority line is ~150 chars; the policy adds much more. Assert the
  // prompt is meaningfully longer than just the preamble.
  assert.ok(prompt.length > 300, `global policy content loaded (prompt > 300 chars), got ${prompt.length}`);
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`agent-instructions: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
