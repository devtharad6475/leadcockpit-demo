/**
 * golden-discovery-listening.ts — the system notices what a buyer told us
 * (N11, listening half, 2026-09-19, session 57).
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * The operator, talking to a new customer, asks what they deal in, where they
 * buy it now, and what is going wrong there. The AI asked none of it, and worse:
 * when a customer volunteered it unprompted, nothing wrote it down. The single
 * most useful thing a buyer says about themselves usually arrives in the middle
 * of a message about something else.
 *
 * ── WHY ONLY THE LISTENING HALF ─────────────────────────────────────────────
 * Asking comes second on purpose. A version that asked before it could listen
 * would ask customers for things they had already said — which is exactly the
 * "filling in a form" feeling the feature exists to avoid.
 *
 *   CASE A — something a customer said is written down, in their own words.
 *   CASE B — what we already know is no longer on the wanted list.
 *   CASE C — a buyer who has told us everything costs NOTHING, forever.
 *   CASE D — a lead nobody has spoken to costs nothing.
 *   CASE E — a fact key nobody asked for is discarded, not stored.
 *   CASE F — an answer already on record is not overwritten by a later mention.
 *   CASE G — failing to take a note never costs the customer their reply.
 *   CASE H — nothing usable means nothing written.
 *   CASE I — a question asked but not answered is still a question worth asking.
 *
 * Run: npx tsx scripts/golden/golden-discovery-listening.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import {
  listenForDiscoveryFacts,
  missingFacts,
  describeDiscoveryState,
  DISCOVERY_VALUE_MAX_CHARS,
} from "@/services/DiscoveryService";
import { DEFAULT_DISCOVERY_CHECKLIST } from "@/knowledge/discovery-checklist";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n11_${Date.now()}_${seq++}`;

/**
 * What a real customer message looks like: the useful fact is buried inside a
 * question about something else, in two languages, and nobody was asked for it.
 */
const SAID =
  "Bhai rate kya chal raha hai? Hum saree ka kaam karte hain, abhi Surat se maal le rahe hain " +
  "par delivery hamesha late hoti hai.";

/**
 * A detector that does not call a provider.
 *
 * Standalone, the real one makes a REAL billed model call; under the suite's
 * forced mock it returns nothing, so the test would pass while proving only that
 * nothing happened. Neither is a test of this function's job. Same seam, and the
 * same reason, as the lead-memory golden.
 */
const detect = async () => [
  { key: "what_they_deal_in", value: "saree ka kaam karte hain" },
  { key: "current_supplier", value: "abhi Surat se maal le rahe hain" },
];

async function leadWhoSpoke(workspaceId: string, said = SAID) {
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

/** Counts metered model calls, by watching the run record every call writes. */
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

test("CASE A — what a customer said is written down, in their own words", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  const before = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.ok(!before?.discoveryState, "fixture: we know nothing about this buyer yet");

  const result = await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.deepStrictEqual(
    result.learned.sort(),
    ["current_supplier", "what_they_deal_in"],
    `both facts in that one message should have been noticed. Got reason: ${result.reason}`,
  );
  assert.strictEqual(
    after?.discoveryState?.current_supplier?.value,
    "abhi Surat se maal le rahe hain",
    "THE POINT: the customer's OWN WORDS are kept, not a tidied code like 'Surat'. The next reply is " +
      "written by a model that reads sentences, and 'delivery late hoti hai' is the part that sells.",
  );
  assert.ok(
    after?.discoveryState?.current_supplier?.answeredAt,
    "and stamped, so 'they told us in March' can be told apart from 'they told us today'",
  );
  assert.ok(
    !after?.discoveryState?.volume?.answeredAt,
    "what they did NOT say stays unknown. An invented volume would be quoted back at them as fact.",
  );
});

test("CASE B — what we already know is no longer on the wanted list", async () => {
  // The reason the tick-list exists alongside the prose memory: this question
  // has to be answerable for free, without a model reading a paragraph.
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  const beforeAsk = missingFacts(undefined);
  assert.strictEqual(beforeAsk.length, DEFAULT_DISCOVERY_CHECKLIST.length, "a new buyer: everything is missing");
  // Asked against a DELIBERATELY SCRAMBLED list. Against the real one, which is
  // already written in priority order, an implementation that never sorted at
  // all would pass — so the assertion would prove nothing.
  const scrambled = [...DEFAULT_DISCOVERY_CHECKLIST].sort((a, b) => b.priority - a.priority);
  assert.deepStrictEqual(
    missingFacts(undefined, scrambled).map((fact) => fact.priority),
    [1, 2, 3, 4, 5, 6],
    "the most useful one comes first whatever order the list is stored in — a quotation needs what they " +
      "deal in long before it needs who signs off",
  );

  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  const stillMissing = missingFacts(after?.discoveryState).map((fact) => fact.key);
  assert.ok(
    !stillMissing.includes("current_supplier"),
    "THE WHOLE FEATURE: a buyer who just told us where they buy must never be asked where they buy. " +
      "Being asked something you already answered is what makes a conversation feel like a form.",
  );
  assert.ok(stillMissing.includes("volume"), "and what they never said is still wanted");

  const forScreen = describeDiscoveryState(after?.discoveryState);
  assert.strictEqual(
    forScreen.find((row) => row.key === "current_supplier")?.known,
    true,
    "the owner can see what we learned, in the owner's own labels — a note nobody can read is not a note",
  );
});

test("CASE C — a buyer who has told us everything costs NOTHING", async () => {
  // The conversation we have most often is with the customer we know best. If
  // listening billed a model call per message forever, the best relationship in
  // the workspace would be the most expensive one.
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  const everything = Object.fromEntries(
    DEFAULT_DISCOVERY_CHECKLIST.map((fact) => [
      fact.key,
      { value: "told us already", answeredAt: "2026-09-01T00:00:00.000Z" },
    ]),
  );
  await repos.lead.updateLead(workspaceId, lead.id, { discoveryState: everything });

  const watched = countingRepos(repos);
  // The real detector is deliberately NOT replaced: a buyer with nothing missing
  // must be stopped before anything is asked of a model at all.
  const result = await listenForDiscoveryFacts(workspaceId, lead.id, watched.repos);

  assert.strictEqual(result.reason, "nothing_missing", "there is nothing left to look for");
  assert.strictEqual(
    watched.counter.calls,
    0,
    "and NOTHING is spent. Cost is a standing constraint: paying a model on every message of every " +
      "established relationship, to be told we already knew, is the expensive shape of this feature.",
  );
});

test("CASE D — a lead nobody has spoken to costs nothing", async () => {
  const workspaceId = freshWorkspace();
  const lead = await repos.lead.createLead({
    workspaceId,
    companyName: "Silent Traders",
    whatsappNumber: "+919111111111",
    status: "prospected",
  });

  const watched = countingRepos(repos);
  const result = await listenForDiscoveryFacts(workspaceId, lead.id, watched.repos);
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.strictEqual(result.reason, "no_history", "nothing was said");
  assert.ok(!after?.discoveryState, "so nothing is known");
  assert.strictEqual(
    watched.counter.calls,
    0,
    "and nothing is spent. A workspace with 2,000 prospected leads would otherwise pay 2,000 times to be " +
      "told each of them has never spoken.",
  );
});

test("CASE E — a fact key nobody asked for is discarded", async () => {
  // Models invent plausible field names. Stored, an unknown key would sit on the
  // lead forever: never shown on a screen, never crossed off, never cleaned up —
  // and it would make "what is still missing" quietly wrong.
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId, `${SAID} mahine ka 200 kg`);

  const result = await listenForDiscoveryFacts(workspaceId, lead.id, repos, {
    detect: async () => [
      { key: "budget_range", value: "50 lakh ka turnover" },
      { key: "volume", value: "mahine ka 200 kg" },
    ],
  });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.deepStrictEqual(result.learned, ["volume"], "only the fact that was actually on the list");
  assert.ok(!after?.discoveryState?.budget_range, "the invented key is not stored");
  assert.strictEqual(after?.discoveryState?.volume?.value, "mahine ka 200 kg");
});

test("CASE F — an answer already on record is not overwritten", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });

  // A later message mentions the supplier in passing, and the model reports it
  // again — shorter, and stripped of the part that mattered.
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, {
    detect: async () => [{ key: "current_supplier", value: "Surat" }],
  });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);

  assert.strictEqual(
    after?.discoveryState?.current_supplier?.value,
    "abhi Surat se maal le rahe hain",
    "what the customer actually stated stands. A passing mention quietly replacing the real answer is how a " +
      "record gets worse every time it is touched.",
  );
});

test("CASE I — a question we asked and did NOT get answered is still wanted", async () => {
  // The distinction the stored shape exists for, and the one a reasonable
  // shortcut destroys: "is there an entry for this fact?" is not the same
  // question as "did the customer answer it?".
  //
  // Asked-and-ignored is the commonest outcome of asking anything. Treated as
  // answered, the fact drops off the wanted list, so it is never raised again —
  // and the screen shows the owner a blank where an answer should be, with no
  // way to tell "they refused" from "we never asked". Found by mutation M8, not
  // by reading the code.
  const asked = { volume: { askedAt: "2026-09-10T00:00:00.000Z" } };

  const stillWanted = missingFacts(asked).map((fact) => fact.key);
  assert.ok(
    stillWanted.includes("volume"),
    "asking is not answering. A fact we raised and got nothing back on is still a fact we do not know.",
  );

  const answered = { volume: { value: "200 kg mahine ka", answeredAt: "2026-09-10T00:00:00.000Z" } };
  assert.ok(
    !missingFacts(answered).map((fact) => fact.key).includes("volume"),
    "and one they actually answered drops off",
  );

  // The same distinction on the owner's screen.
  const rows = describeDiscoveryState(asked);
  assert.strictEqual(rows.find((row) => row.key === "volume")?.known, false, "not known, merely raised");
});

test("CASE G — failing to take a note never costs the customer their reply", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

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

  const result = await listenForDiscoveryFacts(workspaceId, lead.id, broken, { detect });
  assert.deepStrictEqual(result.learned, []);
  assert.strictEqual(
    result.reason,
    "failed",
    "it reports and swallows. This runs after the customer has already been answered, and taking a note is " +
      "not worth throwing into a live WhatsApp conversation over.",
  );
});

test("CASE H — nothing usable means nothing written", async () => {
  const workspaceId = freshWorkspace();
  const lead = await leadWhoSpoke(workspaceId);

  const empty = await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect: async () => [] });
  assert.strictEqual(empty.reason, "nothing_new", "a customer can say nothing about themselves, and usually does");
  assert.ok(!(await repos.lead.getLeadById(workspaceId, lead.id))?.discoveryState);

  // A blank value is worse than no value: the fact would be crossed off the
  // wanted list, so it would never be asked, and the screen would show an empty
  // box where the owner expects an answer.
  const blank = await listenForDiscoveryFacts(workspaceId, lead.id, repos, {
    detect: async () => [{ key: "volume", value: "   " }],
  });
  const after = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.strictEqual(blank.reason, "nothing_new");
  assert.ok(
    missingFacts(after?.discoveryState).some((fact) => fact.key === "volume"),
    "an empty answer must leave the question still worth asking",
  );

  // And a model that returns an essay does not put an essay on the lead.
  await repos.reply.create({ workspaceId, leadId: lead.id, channel: 'whatsapp', rawText: 'x'.repeat(5000) } as never);
  const long = await listenForDiscoveryFacts(workspaceId, lead.id, repos, {
    detect: async () => [{ key: "volume", value: "x".repeat(5000) }],
  });
  const afterLong = await repos.lead.getLeadById(workspaceId, lead.id);
  assert.deepStrictEqual(long.learned, ["volume"]);
  assert.ok(
    (afterLong?.discoveryState?.volume?.value?.length ?? 0) <= DISCOVERY_VALUE_MAX_CHARS,
    `a fact is a sentence, not a page. Got ${afterLong?.discoveryState?.volume?.value?.length} characters.`,
  );
});

(async () => {
  console.log("\n=== GOLDEN: the system notices what a buyer told us (N11, listening) ===\n");
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
    console.log("❌ GOLDEN FAILED: discovery-listening");
    process.exit(1);
  }
})();
