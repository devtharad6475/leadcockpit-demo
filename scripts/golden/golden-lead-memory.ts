/**
 * golden-lead-memory.ts — the AI remembers a buyer between conversations
 * (N4, 2026-09-18, session 57).
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * Every reply was written from the knowledge base plus the recent messages.
 * Nothing carried forward. A customer who said in March "we buy from Kolkata
 * and the quality is inconsistent" had told us the single most useful thing
 * about themselves, and by April neither the owner nor the AI could recall it.
 *
 * ── THE RULE THAT MATTERS MORE THAN THE FEATURE ─────────────────────────────
 * An owner's correction is permanent. The moment a person edits the memory, the
 * AI stops rewriting it. "I fixed it and it came back" is how somebody stops
 * trusting a system, and a memory that restores itself is not one the owner
 * controls.
 *
 *   CASE A — a conversation leaves something behind.
 *   CASE B — what was left behind reaches the NEXT reply.
 *   CASE C — an owner's edit is never overwritten by the AI.
 *   CASE D — clearing it hands control back, so nobody is stuck.
 *   CASE E — a customer who has said nothing gets no invented memory.
 *   CASE F — a failure to remember never costs the customer their reply.
 *
 * Run: npx tsx scripts/golden/golden-lead-memory.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import {
  rememberConversation,
  setOwnerLeadMemory,
  formatLeadMemoryForPrompt,
} from "@/services/LeadMemoryService";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n4_${Date.now()}_${seq++}`;

const SAID = "We are buying zari from Kolkata right now but the quality is inconsistent. We need 200 kg a month.";
const REMEMBERED = "Buys zari from a Kolkata supplier today; says quality is inconsistent. Needs about 200 kg a month.";

/**
 * A summariser that does not call a provider.
 *
 * The first version of this golden let the real one run. Standalone that made a
 * REAL billed model call, and under the suite's forced mock provider it returned
 * nothing — so the test passed for the wrong reason in one place and failed in
 * the other. A test that costs money is not a test.
 */
const summarise = async () => REMEMBERED;

async function leadWithConversation(workspaceId: string, said = SAID) {
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Ambica Textiles",
    contactName: "Bhavesh",
    whatsappNumber: "+919876543210",
    status: "replied",
  });
  await repos.reply.create({
    workspaceId,
    leadId: lead.id,
    channel: "whatsapp",
    rawText: said,
    direction: "inbound",
  } as never);
  return lead;
}

test("CASE A — a conversation leaves something behind", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWithConversation(workspaceId);

  const before = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.ok(!before?.conversationMemory, "fixture: nothing is remembered yet");

  const result = await rememberConversation(workspaceId, lead.id, repos, { summarise });

  const after = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.ok(result.updated, `the conversation should have produced a memory. Got reason: ${result.reason}`);
  assert.ok(after?.conversationMemory?.trim(), "and it is written ON THE LEAD, where the owner can read and correct it");
  assert.strictEqual(after?.conversationMemorySource, "ai", "marked as the machine's, so an owner edit can outrank it later");
  assert.ok(after?.conversationMemoryAt, "and stamped, because a fact from months ago deserves less confidence than one from today");
});

test("CASE B — what was remembered reaches the next reply", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWithConversation(workspaceId);
  await rememberConversation(workspaceId, lead.id, repos, { summarise });
  const remembered = await repos.lead.getLeadById(workspaceId, lead.id);

  const forPrompt = formatLeadMemoryForPrompt(remembered);
  assert.ok(forPrompt.length > 0, "THE POINT: a memory nothing reads is a diary, not a memory");
  assert.ok(
    forPrompt.includes(remembered!.conversationMemory!.slice(0, 40)),
    "the actual remembered text reaches the model, not a summary of a summary",
  );
  assert.match(
    forPrompt,
    /last updated \d{4}-\d{2}-\d{2}/,
    "with its age attached — the model cannot judge whether a fact is stale unless it is told when it was learned",
  );
});

test("CASE C — an owner's correction is never overwritten", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWithConversation(workspaceId);
  await rememberConversation(workspaceId, lead.id, repos, { summarise });

  const CORRECTED = "Buys from Surat, not Kolkata. Wants 500 kg, not 200.";
  await setOwnerLeadMemory(workspaceId, lead.id, CORRECTED, repos);

  // Another conversation happens, and the AI tries to remember again.
  const second = await rememberConversation(workspaceId, lead.id, repos, { summarise });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.strictEqual(second.updated, false, "the AI must not write over it");
  assert.strictEqual(second.reason, "owner_edited", "and must say plainly why it did not");
  assert.strictEqual(
    after?.conversationMemory,
    CORRECTED,
    "THE RULE: the owner's words stand. A memory that quietly restores itself after every conversation is " +
      "not something the owner controls, and 'I fixed it and it came back' is how people stop trusting a system.",
  );
  assert.strictEqual(after?.conversationMemorySource, "owner");
});

test("CASE D — clearing it hands control back to the AI", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWithConversation(workspaceId);
  await setOwnerLeadMemory(workspaceId, lead.id, "something the owner typed", repos);
  await setOwnerLeadMemory(workspaceId, lead.id, "", repos);

  const result = await rememberConversation(workspaceId, lead.id, repos, { summarise });
  assert.notStrictEqual(
    result.reason,
    "owner_edited",
    "an owner who decides the memory is more trouble than it is worth must not be stuck with an empty box forever",
  );
});

test("CASE E — a customer who has said nothing gets no invented memory", async () => {
  const workspaceId = freshWorkspace();
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Never Spoke Traders",
    whatsappNumber: "+919000000000",
    status: "prospected",
  });

  // The real summariser is deliberately NOT replaced here: a lead with no
  // history must be stopped before anything is asked of a model at all.
  const result = await rememberConversation(workspaceId, lead.id, repos);
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.strictEqual(result.updated, false, "nothing was said, so nothing is remembered");
  assert.ok(
    !after?.conversationMemory,
    "and NOTHING is written. A paragraph of plausible speculation about a customer who has never spoken is " +
      "worse than an empty box: the next reply would act on it as though they had told us.",
  );
});

test("CASE G — a lead nobody has spoken to costs nothing", async () => {
  // CASE E proves nothing is WRITTEN. This proves nothing is SPENT. They are
  // different failures: a model call that returns "NOTHING YET" still bills,
  // and a workspace with 2,000 prospected leads would pay for 2,000 of them.
  const workspaceId = freshWorkspace();
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Silent Traders",
    whatsappNumber: "+919111111111",
    status: "prospected",
  });

  let modelCalls = 0;
  const counted = new Proxy(repos as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "agentRun") {
        const runRepo = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(runRepo, {
          get(runTarget, runProp) {
            if (runProp === "create") {
              return async (...args: unknown[]) => {
                modelCalls += 1;
                return (runTarget.create as (...a: unknown[]) => unknown)(...args);
              };
            }
            const value = Reflect.get(runTarget, runProp, runTarget);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(runTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;

  await rememberConversation(workspaceId, lead.id, counted);
  assert.strictEqual(
    modelCalls,
    0,
    "no conversation means no model call. Asking a model to summarise an empty history costs money to be " +
      "told there is nothing there — and cost is a standing constraint on this product.",
  );
});

test("CASE H — a model that returns nothing usable writes nothing", async () => {
  // What the suite's mock provider actually does, and what a real provider does
  // on a bad day. The memory must stay empty rather than being set to "" or to
  // the word "undefined" — either of which the next reply would read as fact.
  const workspaceId = freshWorkspace();
  const lead = await leadWithConversation(workspaceId);

  const result = await rememberConversation(workspaceId, lead.id, repos, { summarise: async () => "" });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.strictEqual(result.updated, false);
  assert.ok(!after?.conversationMemory, "nothing usable came back, so nothing is written");

  // And the model's own way of saying "there is nothing here". The prompt asks
  // for exactly this phrase, so it arrives as ordinary text — and stored as a
  // memory it would be read back before the next reply as though the customer
  // had said it.
  const sentinel = await rememberConversation(workspaceId, lead.id, repos, { summarise: async () => "NOTHING YET" });
  const afterSentinel = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.strictEqual(sentinel.updated, false, "'NOTHING YET' is an answer meaning nothing, not a memory");
  assert.ok(
    !afterSentinel?.conversationMemory,
    "storing it would put the words NOTHING YET in front of the model before the next reply, as a fact " +
      "about the customer",
  );
});

test("CASE F — failing to remember never costs the customer their reply", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWithConversation(workspaceId);

  // The lead write refuses. This runs AFTER the customer has been answered, so
  // it must report and swallow rather than throw into the reply path.
  const broken = new Proxy(repos as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "lead") {
        const leadRepo = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(leadRepo, {
          get(leadTarget, leadProp) {
            if (leadProp === "updateLead") {
              return async () => {
                throw new Error("lead write refused");
              };
            }
            const value = Reflect.get(leadTarget, leadProp, leadTarget);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(leadTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;

  const result = await rememberConversation(workspaceId, lead.id, broken, { summarise });
  assert.strictEqual(result.updated, false);
  assert.strictEqual(
    result.reason,
    "failed",
    "it reports the failure rather than throwing. Taking a note is not worth breaking a customer conversation over.",
  );
});

(async () => {
  console.log("\n=== GOLDEN: the AI remembers a buyer between conversations (N4) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: lead-memory");
    process.exit(1);
  }
})();
