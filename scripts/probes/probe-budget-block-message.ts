/**
 * probe-budget-block-message.ts — N-AI-5 verification on the REAL stored limits.
 *
 * The golden proves `buildBlockedExtractionMessage` on constructed strings. This
 * proves the string it is fed is the one the real usage gate actually produces,
 * so the two halves meet on real data rather than on my assumption about the
 * format.
 *
 * WHY THIS COSTS NOTHING. The usage gate is PRE-FLIGHT: `LLMService.runTask`
 * calls `checkCanRunTask` and throws at LLMService.ts:38 before any provider is
 * constructed. Asking the gate for a verdict never contacts DeepSeek.
 *
 * WHY IT RUNS ON AN ISOLATED STORE, AND WHY THAT IS STILL REAL. `checkCanRunTask`
 * calls `resetUsageIfNeeded`, which upserts — and because the live record was
 * last written on a previous day, running it against the demo store would ZERO
 * the day's counters as a side effect. A probe must not change the thing it is
 * measuring. So: run under the golden preload (which redirects LEADGEN_DATA_DIR
 * to a per-process temp dir and pins the JSON provider, so the ship database is
 * untouchable), and COPY the real limits record out of the live
 * `.leadgen-data/app-data.json` into that isolated store first. Real limits,
 * real current usage, real gate, no mutation of anything that matters.
 *
 * NOTE ON WHY THE BLOCK HAS TO BE FORCED. The original N-AI-5 sighting used the
 * seeded 50,000-token daily cap against a 63,105-token extraction. N-AI-4 raised
 * that cap to 2,000,000, so the exact original scenario is no longer reachable —
 * which is the N-AI-4 fix working. The block is therefore synthesised by asking
 * for one token more than the workspace has left.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/probes/probe-budget-block-message.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import fs from "node:fs";
import path from "node:path";

type UsageRecord = Record<string, number | string | undefined>;

function readLiveUsageRecord(workspaceId: string): UsageRecord | undefined {
  const file = path.join(process.cwd(), ".leadgen-data", "app-data.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { aiUsageLimits?: UsageRecord[] };
  return (raw.aiUsageLimits || []).find((item) => item.workspaceId === workspaceId);
}

function snapshot(usage: UsageRecord | undefined) {
  if (!usage) return "(no record)";
  return `dailyTokenLimit=${usage.dailyTokenLimit} currentDailyTokens=${usage.currentDailyTokens} dailyCostLimit=${usage.dailyCostLimit} currentDailyCost=${usage.currentDailyCost}`;
}

async function main() {
  const { createRepositories, getPersistenceProvider } = await import("@/repositories");
  const { checkCanRunTask } = await import("@/services/AIUsageService");
  const { buildBlockedExtractionMessage } = await import("@/services/DocumentQuestionAnsweringService");

  const workspaceId = "workspace_demo";
  console.log(`persistence provider: ${getPersistenceProvider()}`);
  console.log(`isolated data dir:    ${process.env.LEADGEN_DATA_DIR}\n`);

  const live = readLiveUsageRecord(workspaceId);
  if (!live) {
    console.error("PROBE INCONCLUSIVE: no aiUsageLimits record for workspace_demo in the live store.");
    process.exit(3);
  }
  console.log(`REAL limits copied from the live store: ${snapshot(live)}\n`);

  const repos = createRepositories();
  await repos.aiUsageLimit.upsertForWorkspace(workspaceId, live as never);

  const dailyLimit = Number(live.dailyTokenLimit);
  const used = Number(live.currentDailyTokens) || 0;
  const remaining = dailyLimit - used;

  // 1. A normal call must still be allowed — otherwise the blocked result below
  //    would prove nothing about the gate discriminating.
  const normal = await checkCanRunTask(workspaceId, "document_question_answering", 1000, 0, repos);
  console.log(`normal call (1,000 tokens):        allowed=${normal.allowed}`);
  console.log(`  reason: ${normal.reason}\n`);

  // 2. One token past what is left.
  const oversized = remaining + 1;
  const blocked = await checkCanRunTask(workspaceId, "document_question_answering", oversized, 0, repos);
  console.log(`oversized call (${oversized.toLocaleString()} tokens):  allowed=${blocked.allowed}`);
  console.log(`  reason: ${blocked.reason}\n`);

  if (blocked.allowed) {
    console.error("PROBE INCONCLUSIVE: the gate allowed a deliberately oversized run.");
    process.exit(3);
  }

  // 3. That reason is what lands in `modelUsed.warning` after per-batch
  //    aggregation. Print what the operator is actually told, both ways.
  console.log("=== what the operator was told BEFORE the N-AI-5 fix ===");
  console.log(`  ${buildBlockedExtractionMessage("llm", undefined)}\n`);
  console.log("=== what the operator is told AFTER the N-AI-5 fix ===");
  console.log(`  ${buildBlockedExtractionMessage("llm", blocked.reason)}\n`);

  const after = readLiveUsageRecord(workspaceId);
  console.log(`live store AFTER: ${snapshot(after)}`);
  console.log(`live store unchanged by this probe: ${snapshot(live) === snapshot(after)}`);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
});
