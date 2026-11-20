/**
 * golden-buyer-checklist.ts — the OWNER decides what is worth knowing about a
 * buyer (N12, 2026-09-23, session 58).
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * What a business wants to know about its buyers is a judgement, not research.
 * Two zari sellers would ask different things. So the system PROPOSES a starting
 * list — nobody should face an empty box — and from the moment the owner saves
 * anything, their list stands. Proposing is not deciding.
 *
 * Three layers: the owner's list for every buyer, extra lines per buyer type,
 * and lines added to one lead alone ("ask whether the sample reached").
 *
 *   CASE A — before the owner decides, the proposal is what gets listened for.
 *   CASE B — once saved, the OWNER'S list is what gets listened for.
 *   CASE C — a deliberately empty list stands, and costs nothing.
 *   CASE D — a buyer-type layer reaches every spelling of that type, and only it.
 *   CASE E — rewording a question keeps every answer already given to it.
 *   CASE F — a line on one lead comes first, is listened for, and removing it
 *            does not forget what the customer said.
 *   CASE G — a service business is proposed service wording, on the same keys.
 *   CASE H — a line on one lead can never shadow a question on the main list.
 *   CASE I — the lists are bounded, because every line is paid for on every
 *            conversation.
 *
 * Run: npx tsx scripts/golden/golden-buyer-checklist.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import {
  addLeadDiscoveryLine,
  getDiscoveryChecklist,
  getLeadDiscovery,
  listenForDiscoveryFacts,
  removeLeadDiscoveryLine,
  saveDiscoveryChecklist,
  type DiscoveryDetection,
} from "@/services/DiscoveryService";
import {
  DEFAULT_DISCOVERY_CHECKLIST,
  DISCOVERY_MAX_FACTS_PER_LIST,
  type DiscoveryFact,
} from "@/knowledge/discovery-checklist";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n12_${Date.now()}_${seq++}`;

async function leadWhoSpoke(workspaceId: string, buyerType?: string) {
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Ambica Textiles",
    whatsappNumber: `+9198765${String(seq).padStart(5, "0")}`,
    status: "replied",
    buyerType,
  });
  await repos.reply.create({
    workspaceId,
    leadId: lead.id,
    channel: "whatsapp",
    rawText: "Hum export bhi karte hain, Dubai aur Nepal. Sample mil gaya, accha tha.",
  } as never);
  return lead;
}

/**
 * A detector that records WHAT IT WAS ASKED TO LOOK FOR, and answers nothing
 * unless told to. The question under test in most cases is "which list reached
 * the model", and that is only observable at this seam — the real detector
 * would bill a provider and the suite's mock returns nothing either way.
 */
function recordingDetect(answers: DiscoveryDetection[] = []) {
  const asked: string[][] = [];
  const detect = async (_history: string, wanted: DiscoveryFact[]) => {
    asked.push(wanted.map((fact) => fact.key));
    return answers;
  };
  return { detect, asked };
}

/** Counts metered model calls by watching the run record every call writes. */
function countingRepos(base: RepositoryBundle) {
  const counter = { calls: 0 };
  const proxied = new Proxy(base as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "agentRun") {
        const runRepo = Reflect.get(target, prop, target) as Record<string, unknown>;
        return new Proxy(runRepo, {
          get(runTarget, runProp) {
            if (runProp === "create") {
              return async (...args: unknown[]) => {
                counter.calls += 1;
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
  return { repos: proxied, counter };
}

test("CASE A — before the owner decides, the proposal is what gets listened for", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  const view = await getDiscoveryChecklist(workspaceId, repos);
  assert.strictEqual(view.decided, false, "nothing saved yet, so the screen must say PROPOSED, not 'your list'");
  assert.ok(
    view.spine.length > 0,
    "and it is not empty. An owner facing a blank box writes nothing, and listening for nothing learns nothing.",
  );

  const { detect, asked } = recordingDetect();
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });
  assert.deepStrictEqual(
    [...asked[0]].sort(),
    DEFAULT_DISCOVERY_CHECKLIST.map((fact) => fact.key).sort(),
    "until the owner decides, the proposal is what the system listens for",
  );
});

test("CASE B — once saved, the OWNER'S list is what gets listened for", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  await saveDiscoveryChecklist(workspaceId, {
    spine: [{ label: "Do they export?" }, { label: "Which markets do they sell in?" }],
  }, repos);

  const { detect, asked } = recordingDetect();
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });

  assert.deepStrictEqual(
    asked[0],
    ["do_they_export", "which_markets_do_they_sell_in"],
    "THE POINT OF N12: what the model looks for is what the OWNER wrote. Before this, every workspace " +
      "listened for the same fixed six, whatever its owner cared about.",
  );
  const view = await getDiscoveryChecklist(workspaceId, repos);
  assert.strictEqual(view.decided, true);
  assert.strictEqual(
    view.spine[0].lookFor,
    "Do they export?",
    "an owner who writes only a question has said enough — the question is what the model looks for",
  );
});

test("CASE C — a deliberately empty list stands, and costs nothing", async () => {
  // The distinction between "never decided" and "decided on nothing". Collapse
  // them and the proposal quietly comes back after the owner removed it —
  // overruling the owner, which is the one thing this layer must not do.
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  await saveDiscoveryChecklist(workspaceId, { spine: [] }, repos);
  const view = await getDiscoveryChecklist(workspaceId, repos);
  assert.strictEqual(view.decided, true, "an empty list the owner saved is a decision");
  assert.deepStrictEqual(view.spine, [], "and the proposal must NOT come back");

  const watched = countingRepos(repos);
  const result = await listenForDiscoveryFacts(workspaceId, lead.id, watched.repos);
  assert.strictEqual(result.reason, "nothing_missing", "nothing on the list means nothing to look for");
  assert.strictEqual(watched.counter.calls, 0, "and nothing is spent looking");
});

test("CASE D — a buyer-type layer reaches every spelling of that type, and only it", async () => {
  const workspaceId = freshWorkspace();
  const shouting = await leadWhoSpoke(workspaceId, "  WHOLESALER ");
  const retailer = await leadWhoSpoke(workspaceId, "Retailer");

  await saveDiscoveryChecklist(workspaceId, {
    spine: [{ label: "What they deal in" }],
    segments: { Wholesaler: [{ label: "How many shops do they supply?" }] },
  }, repos);

  const toShouting = recordingDetect();
  await listenForDiscoveryFacts(workspaceId, shouting.id, repos, { detect: toShouting.detect });
  assert.ok(
    toShouting.asked[0].includes("how_many_shops_do_they_supply"),
    "buyer type is free text. A layer written for 'Wholesaler' that misses '  WHOLESALER ' applies to some " +
      "wholesalers and silently not the rest.",
  );

  const toRetailer = recordingDetect();
  await listenForDiscoveryFacts(workspaceId, retailer.id, repos, { detect: toRetailer.detect });
  assert.ok(
    !toRetailer.asked[0].includes("how_many_shops_do_they_supply"),
    "and a retailer is not asked a wholesaler's question",
  );
  assert.ok(toRetailer.asked[0].includes("what_they_deal_in"), "but still gets everything on the main list");
});

test("CASE E — rewording a question keeps every answer already given to it", async () => {
  // Answers are stored per KEY on every lead. If an edit minted a new key for a
  // reworded label, every buyer's answer to that question would be orphaned by
  // a change of wording — and would be asked again.
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  const first = await saveDiscoveryChecklist(workspaceId, { spine: [{ label: "Do they export?" }] }, repos);
  const key = first.spine[0].key;
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, {
    detect: recordingDetect([{ key, value: "export bhi karte hain, Dubai aur Nepal" }]).detect,
  });

  await saveDiscoveryChecklist(workspaceId, {
    spine: [{ key, label: "Do they sell outside India?" }],
  }, repos);

  const panel = await getLeadDiscovery(workspaceId, lead.id, repos);
  const row = panel.rows.find((item) => item.key === key);
  assert.ok(row, "the reworded question kept its key");
  assert.strictEqual(row!.label, "Do they sell outside India?", "shown with its new wording");
  assert.strictEqual(
    row!.known,
    true,
    "and the answer the buyer already gave is still there. Rewording a question must not cost an answer.",
  );
});

test("CASE F — a line on one lead comes first, is listened for, and removing it forgets nothing", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);
  const other = await leadWhoSpoke(workspaceId);

  await addLeadDiscoveryLine(workspaceId, lead.id, "Did the sample reach them?", repos);

  const { detect, asked } = recordingDetect([{ key: "did_the_sample_reach_them", value: "Sample mil gaya, accha tha" }]);
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });
  assert.strictEqual(
    asked[0][0],
    "did_the_sample_reach_them",
    "somebody typed this about THIS customer — it is more urgent than anything on the general list",
  );

  const toOther = recordingDetect();
  await listenForDiscoveryFacts(workspaceId, other.id, repos, { detect: toOther.detect });
  assert.ok(!toOther.asked[0].includes("did_the_sample_reach_them"), "and it belongs to that one lead only");

  await removeLeadDiscoveryLine(workspaceId, lead.id, "did_the_sample_reach_them", repos);
  const panel = await getLeadDiscovery(workspaceId, lead.id, repos);
  const kept = panel.rows.find((row) => row.key === "did_the_sample_reach_them");
  assert.ok(
    kept?.known && kept.value === "Sample mil gaya, accha tha",
    "removing a question is not forgetting the answer. The customer still said it.",
  );
  assert.strictEqual(kept?.noLongerAsked, true, "it is shown as no longer being asked, with its own label");
  assert.strictEqual(kept?.label, "Did the sample reach them?", "the label travelled with the answer");
});

test("CASE G — a service business is proposed service wording, on the same keys", async () => {
  const workspaceId = freshWorkspace();
  await repos.businessProfile.create({ workspaceId, companyName: "Kaveri Facility Services", businessType: "Facility maintenance services" });

  const view = await getDiscoveryChecklist(workspaceId, repos);
  const supplier = view.spine.find((fact) => fact.key === "current_supplier");
  assert.ok(supplier, "same keys — a business that changes its type keeps what its leads already told it");
  assert.match(
    supplier!.label,
    /who does this for them now/i,
    "nobody buys a maintenance contract from a 'supplier'. A proposal worded for the wrong kind of business " +
      "gets rewritten or ignored, and then it is not a starting point.",
  );
});

test("CASE H — a line on one lead can never shadow a question on the main list", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);
  await saveDiscoveryChecklist(workspaceId, { spine: [{ label: "Do they export?" }] }, repos);

  await addLeadDiscoveryLine(workspaceId, lead.id, "Do they export?", repos);
  const updated = await repos.lead.getLeadById(workspaceId, lead.id);
  const ownKey = updated!.discoveryExtras![0].key;
  assert.notStrictEqual(
    ownKey,
    "do_they_export",
    "a lead's own line took the same key as the main-list question. Then answering one would silently " +
      "answer the other, and removing the lead's line would look like removing the owner's question.",
  );
});

test("CASE I — the lists are bounded", async () => {
  // Every line on the list goes into the detection prompt of every
  // conversation. An unbounded list is an unbounded bill.
  const workspaceId = freshWorkspace();
  const many = Array.from({ length: 30 }, (_, n) => ({ label: `Question ${n + 1}` }));
  const saved = await saveDiscoveryChecklist(workspaceId, {
    spine: [...many, { label: "   " }, { label: "" }],
  }, repos);
  assert.strictEqual(saved.spine.length, DISCOVERY_MAX_FACTS_PER_LIST, "capped");

  // Blanks placed FIRST. The first version put them after thirty real lines,
  // where the cap discarded them before the blank check was ever reached — so
  // the assertion passed with the blank check deleted. Found by mutation M11.
  const withBlanks = await saveDiscoveryChecklist(workspaceId, {
    spine: [{ label: "   " }, { label: "" }, { label: "Do they export?" }],
  }, repos);
  assert.deepStrictEqual(
    withBlanks.spine.map((fact) => fact.label),
    ["Do they export?"],
    "blank lines are dropped, never stored as questions. A blank question on the list would be sent to " +
      "the model on every conversation, and would sit on every lead as a row nobody can answer.",
  );

  const lead = await leadWhoSpoke(workspaceId);
  for (let n = 0; n < DISCOVERY_MAX_FACTS_PER_LIST; n += 1) {
    await addLeadDiscoveryLine(workspaceId, lead.id, `Own line ${n + 1}`, repos);
  }
  await assert.rejects(
    addLeadDiscoveryLine(workspaceId, lead.id, "One too many", repos),
    /Cannot add more than/,
    "a lead's own list is bounded too, and the refusal says why in words the API maps to a 400",
  );
  await assert.rejects(
    addLeadDiscoveryLine(workspaceId, lead.id, "   ", repos),
    /Cannot add an empty line/,
  );
});

(async () => {
  console.log("\n=== GOLDEN: the owner decides what to learn about buyers (N12) ===\n");
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
    console.log("❌ GOLDEN FAILED: buyer-checklist");
    process.exit(1);
  }
})();
