/**
 * golden-dnc-registry-substrate-prisma.ts — the regression guard for N-DNC-1
 * (2026-08-18, CEO-loop session 6).
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. This is a
 * PERSISTENCE golden: it needs `.env`'s DATABASE_URL and a real Postgres. The
 * runner does not force JSON for it.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK
 * ------------------------------------------
 * `src/lib/dnc-registry.ts` — the permanent Do-Not-Contact registry, the store
 * that decides whether this product may message somebody who said stop — used
 * `readData()` / `mutateData()` from `src/lib/db.ts`. Those are plain file
 * operations on `.leadgen-data/app-data.json` with NO `PERSISTENCE_PROVIDER`
 * awareness (db.ts:209 and :260). So on the substrate this product ships on
 * (Postgres, decision D3) the compliance registry lived in a local JSON file
 * while `do_not_contact_entries` sat in Postgres with nothing reading it.
 *
 * Measured on the ship database on 2026-08-18, before the fix:
 *
 *     DIRECTION 1 — registerDoNotContact() ran, returned an entry, and:
 *       "VERDICT: postgres DID NOT CHANGE, json GREW"
 *     DIRECTION 2 — an opt-out sitting in do_not_contact_entries, asked about:
 *       "isPermanentlyDoNotContact(+91 00000 00099) = false"
 *       "VERDICT: a contact who opted out, recorded in the SHIP database, is
 *        NOT BLOCKED — the product would message them"
 *
 * That is the worst failure this product can have, and NOTHING went red: every
 * golden passed, every service returned success, the registry looked like it
 * was working. It only shows up when the two halves are asked about each other.
 * So the guard has to be exactly that question, run against a real database.
 *
 * This golden is the probe (scripts/probes/probe-dnc-substrate.ts) turned into
 * something that runs unattended and fails loudly. It is unusual for a golden in
 * that it deliberately looks at BOTH substrates at once — that is the whole
 * point, and a substrate-blind version of it would have passed before the fix.
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — DIRECTION 1, the write. With the app bound to Postgres, an opt-out
 *            registered through the product's own API lands in
 *            `do_not_contact_entries`. The row is looked up by CONTENT, not by
 *            a count, so a concurrent write cannot make this pass by accident.
 *   CASE B — DIRECTION 1, the other half. That same registration did NOT grow
 *            `.leadgen-data/app-data.json`. A fix that wrote to both substrates
 *            would satisfy CASE A while leaving the split-brain in place, so the
 *            absence is asserted as its own case rather than assumed.
 *   CASE C — DIRECTION 2, the dangerous one. An opt-out placed DIRECTLY in
 *            `do_not_contact_entries` — the shape a migrated or operator-entered
 *            opt-out has — makes isPermanentlyDoNotContact() answer true. This
 *            is the case that answered `false` before the fix.
 *   CASE D — isContactBlocked(), the function every outbound path calls, refuses
 *            a lead whose number is on that Postgres row, and says the registry
 *            is why. CASE C proves the store is readable; this proves the
 *            SENDING path actually consults it.
 *   CASE E — removal reaches Postgres too. removeFromDncRegistry() reports 1,
 *            the row is gone from the table when queried directly, and the guard
 *            answers false again. A remove that only cleared the JSON file would
 *            leave a contact permanently blocked with no way out.
 *
 * SAFETY: numbers are N-SAFETY-1 unroutable by construction (`+91 00000 000NN`).
 * ISOLATION (Gate #8): a RUN-tagged workspace, cascade-deleted in `finally`,
 * plus a JSON-side sweep for this run's workspace id — because if the defect HAS
 * regressed, this golden's own rows are what ends up in the demo file, and a
 * test that leaves debris behind when it fails is a test people stop running.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-prisma-provider.ts scripts/golden/golden-dnc-registry-substrate-prisma.ts
 */
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { readData, mutateData } from "@/lib/db";
import {
  isPermanentlyDoNotContact,
  isContactBlocked,
  registerDoNotContact,
  removeFromDncRegistry,
  normalizePhone,
} from "@/lib/dnc-registry";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_dncsub_${RUN}`;
const PHONE_WRITE = "+91 00000 00081";
const PHONE_READ = "+91 00000 00082";
const SEEDED_ID = `dnc_golden_seeded_${RUN}`;
const REASON = "dnc substrate golden";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

/** Rows in the JSON demo file. Counted, never written to by the happy path. */
async function jsonRegistrySize(): Promise<number> {
  return ((await readData()).doNotContactRegistry || []).length;
}

let jsonBefore = 0;

async function seed() {
  await createRepositories("prisma").workspace.create({
    id: WS, name: `DNC substrate golden ${RUN}`, status: "active",
    autonomyKillSwitch: false, autoSendToggle: false,
  });
}

// ─── CASE A ─────────────────────────────────────────────────────────────────
test("CASE A — an opt-out registered through the product lands in Postgres", async () => {
  jsonBefore = await jsonRegistrySize();

  const entry = await registerDoNotContact(WS, { phone: PHONE_WRITE, reason: REASON });
  assert.ok(entry, "registerDoNotContact must return the stored entry");

  const row = await prisma.doNotContactEntry.findUnique({ where: { id: entry!.id } });
  assert.ok(row,
    "the opt-out is not in do_not_contact_entries. The registry is writing somewhere " +
    "the ship database cannot see — this is N-DNC-1 back again.");
  assert.strictEqual(row!.workspaceId, WS, "the row must belong to the workspace it was registered for");
  assert.strictEqual(row!.normalizedPhone, normalizePhone(PHONE_WRITE), "the phone must be stored normalised");
  assert.strictEqual(row!.reason, REASON, "the reason the contact gave must survive the write");
});

// ─── CASE B ─────────────────────────────────────────────────────────────────
test("CASE B — …and did not also write the JSON demo file", async () => {
  const jsonAfter = await jsonRegistrySize();
  assert.strictEqual(jsonAfter, jsonBefore,
    `.leadgen-data/app-data.json grew from ${jsonBefore} to ${jsonAfter} rows. With the app bound ` +
    "to Postgres the registry must not touch the file substrate at all — writing to both is still " +
    "a split brain, it just hides the read failure.");

  const strays = ((await readData()).doNotContactRegistry || []).filter((e) => e.workspaceId === WS);
  assert.strictEqual(strays.length, 0, `this run left ${strays.length} row(s) in the JSON demo file`);
});

// ─── CASE C ─────────────────────────────────────────────────────────────────
test("CASE C — an opt-out already in Postgres is seen by the guard", async () => {
  // Written with the Prisma client directly: this is the shape a MIGRATED or
  // operator-entered opt-out has. It never passed through the registry module,
  // so nothing but a real read of the table can find it.
  await prisma.doNotContactEntry.create({
    data: {
      id: SEEDED_ID, workspaceId: WS,
      normalizedPhone: normalizePhone(PHONE_READ),
      reason: `${REASON} (seeded straight into postgres)`,
    },
  });

  const blocked = await isPermanentlyDoNotContact(WS, { phone: PHONE_READ });
  assert.strictEqual(blocked, true,
    "a contact who opted out, recorded in the SHIP database, is NOT BLOCKED — the product would " +
    "message them. This is the exact reading N-DNC-1 produced on 2026-08-18.");

  const other = await isPermanentlyDoNotContact(WS, { phone: "+91 00000 00083" });
  assert.strictEqual(other, false, "sanity: an unregistered number must still be allowed");
});

// ─── CASE D ─────────────────────────────────────────────────────────────────
test("CASE D — the outbound guard refuses that lead and names the registry", async () => {
  const verdict = await isContactBlocked(WS, { whatsappNumber: PHONE_READ });
  assert.strictEqual(verdict.blocked, true,
    "isContactBlocked is what the sending paths call; it must refuse a contact on the Postgres registry");
  assert.match(verdict.reason, /permanent do-not-contact registry/i,
    `the operator must be told which rule stopped the send (got ${JSON.stringify(verdict.reason)})`);
});

// ─── CASE E ─────────────────────────────────────────────────────────────────
test("CASE E — removal deletes the Postgres row, not just a local copy", async () => {
  const removed = await removeFromDncRegistry(WS, { phone: PHONE_READ });
  assert.strictEqual(removed, 1, `removal must report exactly what it removed (got ${removed})`);

  const row = await prisma.doNotContactEntry.findUnique({ where: { id: SEEDED_ID } });
  assert.strictEqual(row, null,
    "the row is still in do_not_contact_entries. A removal that does not reach the ship database " +
    "leaves the contact blocked forever with no way out — the mirror image of the send bug.");

  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: PHONE_READ }), false,
    "after an approved removal the guard must answer false");
  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: PHONE_WRITE }), true,
    "removing one opt-out must not take the other one with it");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  console.log("GOLDEN dnc-registry-substrate-prisma — N-DNC-1 regression guard\n");

  if (process.env.PERSISTENCE_PROVIDER !== "prisma") {
    console.error(
      `PERSISTENCE_PROVIDER is ${JSON.stringify(process.env.PERSISTENCE_PROVIDER)}, not "prisma". ` +
      "This golden asks whether the registry reaches Postgres, which is meaningless on any other " +
      "substrate. Run it with --import ./scripts/golden/_helpers/force-prisma-provider.ts",
    );
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  try {
    await seed();
    // Ordered on purpose: A writes, B inspects what A did NOT do, C seeds the
    // other direction, D reads it through the sending guard, E removes it.
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
    // Postgres: cascade-delete the workspace, which takes its registry rows.
    try {
      await prisma.workspace.deleteMany({ where: { id: WS } });
    } catch { /* best-effort */ }
    // JSON: only ever non-empty if the defect has regressed, which is exactly
    // when leaving debris in the demo file would do the most damage.
    try {
      const swept = await mutateData((data) => {
        const before = (data.doNotContactRegistry || []).length;
        data.doNotContactRegistry = (data.doNotContactRegistry || []).filter((e) => e.workspaceId !== WS);
        return before - data.doNotContactRegistry.length;
      });
      if (swept > 0) console.log(`  (swept ${swept} stray row(s) out of the JSON demo file)`);
    } catch { /* best-effort */ }
  }

  console.log("");
  console.log(`=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("golden-dnc-registry-substrate-prisma FAILED — the compliance registry and the ship database disagree.");
    process.exit(1);
  }
  console.log("golden-dnc-registry-substrate-prisma ALL GREEN");
  process.exit(0);
})();
