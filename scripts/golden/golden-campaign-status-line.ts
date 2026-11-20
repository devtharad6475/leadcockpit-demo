/**
 * golden-campaign-status-line.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Live Dashboard, two panels apart, about the same campaign:
 *
 *     Active campaigns   0            ← KPI tile, counting status === "active"
 *     Campaign   1 active (Draft)     ← Workspace status panel
 *
 * The panel counted every campaign, called the total "active", and printed the
 * real statuses in brackets — contradicting itself inside its own sentence. An
 * owner who believes a campaign is running does not go and start it.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the exact live state: one draft campaign. The word "active" must
 *   not appear, and the sentence must say it is not running.
 *
 *   CASE B — a genuinely running campaign is still called active. A fix that
 *   stopped ever saying "active" would be its own bug.
 *
 *   CASE C — a mix reports both halves, and never counts the idle ones as
 *   active.
 *
 *   CASE D — no campaigns keeps the existing instruction, which tells the owner
 *   where to make one.
 *
 *   CASE E — the KPI tile and this line can never disagree again: for any set
 *   of campaigns, the number this line calls active equals the number the tile
 *   counts (status === "active").
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { campaignStatusLine } from "@/lib/campaign-status-line";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

test("CASE A — one draft campaign is not an active campaign", () => {
  const line = campaignStatusLine([{ status: "draft" }]);
  assert.ok(!/\bactive\b/i.test(line),
    `a draft is not running; the live Dashboard said "1 active (Draft)" beside a tile reading 0 — got: ${line}`);
  assert.ok(/not running/i.test(line), `and it must say so plainly — got: ${line}`);
  assert.ok(/draft/i.test(line), `while still naming what is actually there — got: ${line}`);
});

test("CASE B — a running campaign is still reported as active", () => {
  assert.strictEqual(campaignStatusLine([{ status: "active" }]), "1 active.");
  assert.strictEqual(campaignStatusLine([{ status: "active" }, { status: "active" }]), "2 active.");
});

test("CASE C — a mix reports both halves without inflating the active count", () => {
  const line = campaignStatusLine([{ status: "active" }, { status: "draft" }, { status: "paused" }]);
  assert.ok(line.startsWith("1 active"), `only one of the three is running — got: ${line}`);
  assert.ok(/2 not running/.test(line), `and the other two must not vanish — got: ${line}`);
  assert.ok(/draft/.test(line) && /paused/.test(line), `naming both states — got: ${line}`);
});

test("CASE D — no campaigns tells the owner where to make one", () => {
  assert.strictEqual(campaignStatusLine([]), "No campaign yet — create one from Prospecting → Campaign.");
});

test("CASE E — this line can never disagree with the KPI tile again", () => {
  // The tile is `state.activeCampaigns.length`, built server-side as
  // `campaigns.filter(c => c.status === "active")`. Whatever the mix, the
  // number this sentence calls active must be that same number.
  const mixes = [
    [],
    [{ status: "draft" }],
    [{ status: "active" }],
    [{ status: "active" }, { status: "draft" }],
    [{ status: "paused" }, { status: "completed" }],
    [{ status: "active" }, { status: "active" }, { status: "archived" }],
    [{ status: undefined }],
  ];
  const disagreements = mixes
    .map((campaigns) => {
      const tile = campaigns.filter((c) => c.status === "active").length;
      const line = campaignStatusLine(campaigns);
      const claimed = Number(line.match(/^(\d+) active/)?.[1] ?? 0);
      return { line, tile, claimed };
    })
    .filter((row) => row.claimed !== row.tile);
  assert.deepStrictEqual(disagreements, [],
    "two numbers about the same thing on the same screen must not contradict each other");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-campaign-status-line — N-BUG (a draft campaign must not be reported as active)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`campaign-status-line: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
