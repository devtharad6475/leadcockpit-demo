/**
 * golden-an-icp-can-be-edited-on-postgres.ts — session 55 (2026-09-09).
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. This is a
 * PERSISTENCE golden: it needs `.env`'s DATABASE_URL and a real Postgres. The
 * runner does not force JSON for it.
 *
 * THE TWO DEFECTS THIS EXISTS TO STOP COMING BACK
 * -----------------------------------------------
 * Both were found by typing into "Who you do NOT sell to" on the running
 * product and pressing save, and both were invisible to every existing test
 * because those tests exercise the JSON substrate, where an update is a shallow
 * merge onto a plain object and a field nobody declared is stored anyway.
 *
 *   1. `ICP.exclusions` had NO COLUMN. The screen saved, `PUT /api/icp/:id`
 *      answered 200, and the value was gone on the next read. The feature that
 *      forces a reject when a lead matches something the owner said they do not
 *      sell to had a domain type, a UI, a matcher and a golden — and no place to
 *      keep the rule. On JSON it worked end to end, which is why it shipped.
 *
 *   2. Every ICP edit answered 500 on Postgres, and always had. The `*Data()`
 *      builders are shared between `create` and `update`; a create needs `id`,
 *      `workspaceId` and `createdAt`, and Prisma refuses those on an update —
 *      "Unknown argument `workspaceId`. Did you mean `workspace`?". So renaming
 *      an ICP, editing its industries, or selecting a different one was a 500 on
 *      the substrate the demo and production both run on. The exclusions work
 *      only exposed it; it predates that entirely.
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — the column exists. Asked of `information_schema`, not of Prisma:
 *     a client generated from a schema whose migration was never applied will
 *     happily describe a column the database does not have.
 *
 *   CASE B — an edit round-trips. Exclusions written through the repository
 *     come back from a second, independent read with the same phrases in the
 *     same order. This is the assertion that was failing silently.
 *
 *   CASE C — an update carries the whole record and still cannot re-own it.
 *     The screen sends the object back as it received it, so `workspaceId`,
 *     `id` and `createdAt` ARE in the patch. The update must succeed, and must
 *     leave all three exactly as they were: an edit changes what a record says,
 *     never which workspace owns it, which row it is, or when it began.
 *
 *   CASE D — a record moved between workspaces is the failure CASE C prevents,
 *     so it is asserted from the other side too: an update naming a DIFFERENT
 *     workspace does not move the row. A row silently re-owned is invisible to
 *     every query the real owner can make, and visible to a tenant who should
 *     never have seen it.
 *
 *   CASE E — the persisted value is what the matcher reads. `matchedExclusions`
 *     run against the ICP as it comes back OUT of Postgres names the phrase.
 *     CASE B proves the string survives; this proves the feature does.
 *
 *   CASE F — an exclusion list can be emptied. "I no longer exclude anyone" has
 *     to be sayable: a JSON column that only ever grows would leave the owner
 *     unable to undo an over-broad rule, which is the one rule they most need
 *     to undo.
 *
 * ISOLATION (Gate #8): a RUN-tagged workspace and its own business profile,
 * cascade-deleted in `finally`.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-prisma-provider.ts scripts/golden/golden-an-icp-can-be-edited-on-postgres.ts
 */
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { matchedExclusions } from "@/services/LeadReviewDecisionService";
import type { ICP, Lead } from "@/lib/types";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_icpedit_${RUN}`;
const OTHER_WS = `ws_golden_icpedit_other_${RUN}`;
const PROFILE = `profile_golden_icpedit_${RUN}`;

const repos = createRepositories("prisma");

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

let icp: ICP;

async function seed() {
  for (const id of [WS, OTHER_WS]) {
    await repos.workspace.create({
      id, name: `ICP edit golden ${RUN}`, status: "active",
      autonomyKillSwitch: false, autoSendToggle: false,
    });
  }
  await prisma.businessProfile.create({
    data: { id: PROFILE, workspaceId: WS, companyName: `ICP edit golden ${RUN}` },
  });
  const created = await repos.icp.createMany([{
    workspaceId: WS,
    businessProfileId: PROFILE,
    name: "Golden buyers",
    description: "Seeded by golden-an-icp-can-be-edited-on-postgres",
    industries: ["Manufacturing"],
    status: "suggested",
  }]);
  icp = created[0];
}

// ─── CASE A ─────────────────────────────────────────────────────────────────
test("CASE A — the exclusions column exists in the database", async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'icps' AND column_name = 'exclusions_json'`,
  );
  assert.strictEqual(rows.length, 1,
    "icps.exclusions_json does not exist. 'Who you do NOT sell to' will save, the API will " +
    "answer 200, and the rule will be gone on the next read — which is exactly how it shipped.");
});

// ─── CASE B ─────────────────────────────────────────────────────────────────
test("CASE B — exclusions written through the repository come back", async () => {
  const phrases = ["fashion retail chains", "competitors who also manufacture the same thread"];
  await repos.icp.update(WS, icp.id, { exclusions: phrases });

  const back = await repos.icp.getById(WS, icp.id);
  assert.ok(back, "the ICP disappeared after an update");
  assert.deepStrictEqual(back!.exclusions, phrases,
    `exclusions did not survive the round trip: got ${JSON.stringify(back!.exclusions)}`);
});

// ─── CASE C ─────────────────────────────────────────────────────────────────
test("CASE C — an update carrying the whole record succeeds and cannot re-own it", async () => {
  const before = await repos.icp.getById(WS, icp.id);
  assert.ok(before, "setup: the ICP must exist");

  // Exactly what the screen sends: the object it was given, with one field
  // changed. `id`, `workspaceId` and `createdAt` are all present.
  await repos.icp.update(WS, icp.id, { ...before!, name: "Golden buyers, renamed" });

  const after = await repos.icp.getById(WS, icp.id);
  assert.ok(after, "the ICP disappeared after a whole-record update");
  assert.strictEqual(after!.name, "Golden buyers, renamed",
    "the edit did not take — every ICP edit answered 500 on Postgres before this was fixed");
  assert.strictEqual(after!.id, before!.id, "an update must not change which row this is");
  assert.strictEqual(after!.workspaceId, WS, "an update must not change which workspace owns this row");
  assert.strictEqual(after!.createdAt, before!.createdAt, "an update must not re-date the record");
});

// ─── CASE D ─────────────────────────────────────────────────────────────────
test("CASE D — an update naming a different workspace does not move the row", async () => {
  await repos.icp.update(WS, icp.id, { workspaceId: OTHER_WS, description: "still ours" });

  const stillHere = await repos.icp.getById(WS, icp.id);
  assert.ok(stillHere,
    "the ICP left its workspace because the patch said so. A re-owned row is invisible to " +
    "every query its real owner can make and visible to a tenant who should never see it.");
  assert.strictEqual(stillHere!.description, "still ours", "the rest of the patch must still apply");

  const moved = await repos.icp.getById(OTHER_WS, icp.id);
  assert.strictEqual(moved, undefined, "the row must not be readable from the workspace named in the patch");
});

// ─── CASE E ─────────────────────────────────────────────────────────────────
test("CASE E — the persisted exclusions are what the matcher reads", async () => {
  await repos.icp.update(WS, icp.id, { exclusions: ["fashion retail chains"] });
  const back = await repos.icp.getById(WS, icp.id);

  const lead = { companyName: "Northline Fashion Retail Chains Ltd", industry: "Retail" } as Lead;
  assert.deepStrictEqual(matchedExclusions(lead, back), ["fashion retail chains"],
    "the rule did not fire on the value read back out of Postgres — storing the phrase is " +
    "only half of it, the reject has to actually be forced");

  const other = { companyName: "Surat Bridal Trims Pvt Ltd", industry: "Manufacturing" } as Lead;
  assert.deepStrictEqual(matchedExclusions(other, back), [],
    "a lead that matches nothing must not be excluded — an over-broad rule rejects the pipeline");
});

// ─── CASE F ─────────────────────────────────────────────────────────────────
test("CASE F — an exclusion list can be emptied again", async () => {
  await repos.icp.update(WS, icp.id, { exclusions: [] });
  const back = await repos.icp.getById(WS, icp.id);
  assert.deepStrictEqual(back!.exclusions, [],
    "the owner could not withdraw an exclusion. An over-broad rule is the one rule that most " +
    "needs undoing, and it would be rejecting real buyers until it could be.");
});

(async () => {
  console.log("=== GOLDEN: an ICP can be edited on Postgres ===\n");
  let passed = 0;
  let failed = 0;
  try {
    await seed();
    for (const c of cases) {
      try {
        await c.fn();
        passed++;
        console.log(`  PASS  ${c.name}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${(e as Error).message}`);
      }
    }
  } finally {
    try {
      await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER_WS] } } });
    } catch { /* best-effort */ }
  }

  console.log("");
  console.log(`=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("golden-an-icp-can-be-edited-on-postgres FAILED — an ICP cannot be edited on the substrate we ship on.");
    process.exit(1);
  }
  console.log("golden-an-icp-can-be-edited-on-postgres ALL GREEN");
  process.exit(0);
})();
