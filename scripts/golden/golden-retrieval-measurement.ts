/**
 * golden-retrieval-measurement.ts — the measurement itself must count honestly
 * (N2 + N10, 2026-09-23, session 58).
 *
 * A measurement that miscounts is worse than none: it is the number decisions
 * get made on. So the arithmetic is pinned with injected searches, and no
 * provider is called.
 *
 *   CASE A — the loop runs ONLY where the plain search was weak, exactly as on
 *            the real reply path, and its calls are counted where they happen.
 *   CASE B — "found" means the expected fact is in what came back, not merely
 *            that something came back with a high score.
 *
 * Run: npx tsx scripts/golden/golden-retrieval-measurement.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { measureRetrieval, type Probe } from "@/services/RetrievalMeasurementService";
import type { SemanticRetriever } from "@/rag/SemanticRetriever";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
const workspaceId = `ws_n2_${Date.now()}`;

const PROBES: Probe[] = [
  { about: "strong", asked: "moq kya hai", expect: /minimum/i },
  { about: "weak but rescued", asked: "gold border ka rate", expect: /zari/i },
  { about: "weak and lost", asked: "bahar bhejte ho", expect: /export/i },
];

const fakeRetriever = (hits: Record<string, string[]>) =>
  ({ retrieve: async (_ws: string, q: string) => (hits[q] || []).map((chunkText, i) => ({ id: `c${i}`, chunkText, score: 0.9 })) }) as unknown as SemanticRetriever;

const ctx = (confidenceScore: number, texts: string[]) => ({ confidenceScore, chunks: texts.map((chunkText) => ({ chunkText })) }) as never;

test("CASE A — the loop runs only where the plain search was weak, and its calls are counted", async () => {
  const loopedOn: string[] = [];
  const report = await measureRetrieval(workspaceId, repos, {
    probes: PROBES,
    retrievers: {
      wordsOnly: fakeRetriever({ "moq kya hai": ["Minimum order is 25 kg"] }),
      withMeaning: fakeRetriever({ "moq kya hai": ["Minimum order is 25 kg"], "gold border ka rate": ["Zari trimming price list"] }),
    },
    plain: async (_ws, q) => (q === "moq kya hai" ? ctx(0.8, ["Minimum order is 25 kg"]) : ctx(0.1, ["unrelated"])),
    loop: async (ws, q, loopRepos: RepositoryBundle) => {
      loopedOn.push(q);
      // Two model calls, recorded the way every real call is recorded.
      await loopRepos.agentRun.create({ workspaceId: ws, agentName: "whatsapp-conversation-agent", status: "completed" } as never);
      await loopRepos.agentRun.create({ workspaceId: ws, agentName: "whatsapp-conversation-agent", status: "completed" } as never);
      return q === "gold border ka rate" ? ctx(0.7, ["Zari trimming price list"]) : null;
    },
  });

  assert.deepStrictEqual(loopedOn, ["gold border ka rate", "bahar bhejte ho"], "never on a question the plain search already answered");
  assert.strictEqual(report.whatsappPlain, 1);
  assert.strictEqual(report.whatsappWithLoop, 2, "the loop rescued one");
  assert.strictEqual(report.loopModelCalls, 4, "and its cost is counted from the calls actually recorded, not estimated");
  assert.strictEqual(report.wordsOnly, 1);
  assert.strictEqual(report.withMeaning, 2, "meaning search found the paraphrase words alone missed");
});

test("CASE B — found means the fact is in what came back", async () => {
  const report = await measureRetrieval(workspaceId, repos, {
    probes: [PROBES[0]],
    retrievers: { wordsOnly: fakeRetriever({ "moq kya hai": ["Our shade card has 60 colours"] }), withMeaning: fakeRetriever({}) },
    plain: async () => ctx(0.9, ["Our shade card has 60 colours"]),
    loop: async () => null,
  });
  assert.strictEqual(report.wordsOnly, 0, "a confident answer about the wrong thing is not a found fact");
  assert.strictEqual(report.whatsappPlain, 0, "on the reply path either");
});

(async () => {
  console.log("\n=== GOLDEN: the retrieval measurement counts honestly (N2/N10) ===\n");
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
    console.log("❌ GOLDEN FAILED: retrieval-measurement");
    process.exit(1);
  }
})();
