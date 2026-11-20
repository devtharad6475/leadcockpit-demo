/**
 * golden-whatsapp-last-inbound.ts — CP-24 production round-trip pin (NEW, 2026-08-02).
 *
 * WHY THIS TEST EXISTS (the bug it prevents):
 *   CP-24 was originally built with the JSON demo runtime only. The engine
 *   stamped lastInboundAt via repos.lead.updateLead(...), and the JSON repo's
 *   Object.assign-based updateLead persisted it generically — so the demo path
 *   worked. BUT the Prisma (production) path was broken: the Lead model had no
 *   lastInboundAt column, so the stamp was SILENTLY DROPPED on every inbound
 *   WhatsApp message in production. That meant the 24h window gate would always
 *   read undefined → "window closed" → every reply would be forced to template
 *   mode even inside the 24h window. A real production bug with no error.
 *
 *   This test pins the round-trip on BOTH repos so the gap can never return:
 *   write lastInboundAt → read it back → it survives. If either repo drops it,
 *   this test fails loudly.
 *
 * HAND-COMPUTED CONTRACT:
 *   CASE A — JSON repo round-trip. Create a lead, updateLead with a known
 *     lastInboundAt ISO string, read it back, assert the stored value matches
 *     EXACTLY. Hand-computed: the value we write is the value we must read.
 *
 *   CASE B — JSON repo: distinct from lastContactedAt. Set ONLY lastInboundAt,
 *     assert lastContactedAt stays undefined. These two fields MUST NOT alias —
 *     lastContactedAt = outbound (we contacted them), lastInboundAt = inbound
 *     (they messaged us). Confusion here would break the window gate logic.
 *
 *   CASE C — JSON repo: re-stamping updates the value (not appends/ignores).
 *     A second inbound message must overwrite the first timestamp. Hand-computed:
 *     after two updates, the stored value === the second value, not the first.
 *
 *   CASE D — JSON repo: undefined is preserved as "no inbound yet". A lead
 *     created without lastInboundAt reads back undefined (not null, not empty
 *     string). The window gate treats undefined as "never messaged → closed".
 *
 *   CASE E — Prisma mapper contract (source-text pin). The mapLead function
 *     must parse lastInboundAt to ISO (mirroring lastContactedAt), and the
 *     Prisma schema must declare the column. This is a source-contract pin
 *     because the Prisma repo needs a live DATABASE_URL to exercise — we assert
 *     the wiring exists so a future schema revert is caught. (The full Prisma
 *     round-trip is exercised by golden:prisma-runtime when DATABASE_URL is set.)
 *
 * REAL PIPELINE: uses the real JSON repo (createJsonRepos) + the real updateLead.
 * Each case uses a unique timestamped workspace so demo data stays clean.
 *
 * Run: `npm run golden:whatsapp-last-inbound`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function ws(): string {
  return `ws_golden_lastinbound_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function seedLead(repos: RepositoryBundle, workspaceId: string) {
  return repos.lead.createLead({
    workspaceId,
    companyName: "Test Buyer",
    contactName: "Test",
    status: "discovered",
    reviewStatus: "approved",
  });
}

// === CASE A: JSON round-trip ===================================================
test("A: JSON repo — write lastInboundAt, read it back, value survives exactly", async () => {
  const repos = createJsonRepos();
  const w = ws();
  const lead = await seedLead(repos, w);
  const stamp = "2026-08-02T10:30:00.000Z";
  await repos.lead.updateLead(w, lead.id, { lastInboundAt: stamp });
  const readBack = await repos.lead.getLeadById(w, lead.id);
  assert.ok(readBack, "lead must exist after update");
  assert.strictEqual(readBack!.lastInboundAt, stamp, `lastInboundAt must round-trip exactly; got ${readBack!.lastInboundAt}`);
});

// === CASE B: distinct from lastContactedAt ====================================
test("B: JSON repo — lastInboundAt and lastContactedAt do NOT alias", async () => {
  const repos = createJsonRepos();
  const w = ws();
  const lead = await seedLead(repos, w);
  // Set only the inbound stamp.
  await repos.lead.updateLead(w, lead.id, { lastInboundAt: "2026-08-02T10:30:00.000Z" });
  const readBack = await repos.lead.getLeadById(w, lead.id);
  assert.strictEqual(readBack!.lastInboundAt, "2026-08-02T10:30:00.000Z");
  assert.strictEqual(readBack!.lastContactedAt, undefined, "lastContactedAt must stay undefined — it is a DIFFERENT field (outbound)");
  // Now set lastContactedAt and confirm lastInboundAt is untouched.
  await repos.lead.updateLead(w, lead.id, { lastContactedAt: "2026-08-02T11:00:00.000Z" });
  const readBack2 = await repos.lead.getLeadById(w, lead.id);
  assert.strictEqual(readBack2!.lastContactedAt, "2026-08-02T11:00:00.000Z");
  assert.strictEqual(readBack2!.lastInboundAt, "2026-08-02T10:30:00.000Z", "lastInboundAt must survive a lastContactedAt update");
});

// === CASE C: re-stamping overwrites ===========================================
test("C: JSON repo — a second inbound message overwrites the first timestamp", async () => {
  const repos = createJsonRepos();
  const w = ws();
  const lead = await seedLead(repos, w);
  const first = "2026-08-02T10:30:00.000Z";
  const second = "2026-08-02T14:45:00.000Z";
  await repos.lead.updateLead(w, lead.id, { lastInboundAt: first });
  await repos.lead.updateLead(w, lead.id, { lastInboundAt: second });
  const readBack = await repos.lead.getLeadById(w, lead.id);
  assert.strictEqual(readBack!.lastInboundAt, second, "second stamp must overwrite the first");
});

// === CASE D: undefined preserved (never messaged) =============================
test("D: JSON repo — a lead with no inbound reads lastInboundAt === undefined", async () => {
  const repos = createJsonRepos();
  const w = ws();
  const lead = await seedLead(repos, w);
  const readBack = await repos.lead.getLeadById(w, lead.id);
  assert.strictEqual(readBack!.lastInboundAt, undefined, "never-messaged lead must read undefined (not null/empty)");
});

// === CASE E: Prisma wiring contract (source pin) ==============================
test("E: Prisma — schema has lastInboundAt column + mapLead parses it to ISO", async () => {
  const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
  assert.ok(/lastInboundAt\s+DateTime\?\s+@map\("last_inbound_at"\)/.test(schema), "schema must declare lastInboundAt DateTime? @map(\"last_inbound_at\")");

  const migrationDir = path.join(process.cwd(), "prisma/migrations/20260802120000_cp24_last_inbound_at");
  let migrationSql = "";
  try { migrationSql = readFileSync(path.join(migrationDir, "migration.sql"), "utf8"); }
  catch { assert.fail("CP-24 migration file must exist at prisma/migrations/20260802120000_cp24_last_inbound_at/migration.sql"); }
  assert.ok(/last_inbound_at/.test(migrationSql), "migration must add the last_inbound_at column");

  const prismaRepo = readFileSync(path.join(process.cwd(), "src/repositories/prisma/index.ts"), "utf8");
  assert.ok(/lastInboundAt:\s*record\.lastInboundAt\s*\?\s*iso\(/.test(prismaRepo), "mapLead must parse lastInboundAt to ISO (mirroring lastContactedAt)");
});

// === RUNNER ===================================================================
(async () => {
  let passed = 0, failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${c.name}`);
      console.error(`    ${(e as Error).message}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed (${failed} failed)`);
  if (failed > 0) process.exit(1);
})();
