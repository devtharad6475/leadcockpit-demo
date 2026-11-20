/**
 * golden-credential-session-version-prisma.ts — pins that sessionVersion
 * SURVIVES a real Postgres round-trip through create + bump + read (Stage 6 /
 * 2026-07-31). This is the Postgres-layer upgrade to F-P1-9.
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts: this is a
 * PERSISTENCE golden that needs `.env`'s DATABASE_URL (real Postgres). The suite
 * runner does NOT force JSON for it (unlike logic goldens).
 *
 * WHY THIS TEST EXISTS:
 *   F-P1-9 was originally a STATIC golden (golden:credential-session-version-
 *   mapper CASE A/B/D read the mapper SOURCE to confirm sessionVersion is
 *   preserved; CASE C proved it only on JSON). After the operator flipped to
 *   Postgres (Stage 6), the static check was no longer enough — the question
 *   "does sessionVersion actually persist to Postgres and come back?" could
 *   only be answered by a real round-trip. The flip had already exposed a
 *   related split-brain bug (golden-platform-admin-ops CASE K — sessionVersion
 *   appeared not to bump). This golden closes the proof gap: it creates a
 *   credential on real Neon at version 1, bumps it twice, and asserts version 3
 *   is read back — AND that a FRESH repo bundle (no in-memory cache) reads 3 too.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — create credential at sessionVersion=1, read back → 1.
 *   CASE B — bump twice (updatePasswordAndBumpSession) → read back = 3
 *     (1 → 2 → 3). The latest passwordHash is also persisted.
 *   CASE C — a FRESH createRepositories("prisma") bundle reads sessionVersion=3
 *     (proves it PERSISTED to Postgres, not an in-memory artifact).
 *
 * ISOLATION (Gate #8): RUN-tagged workspace + cascade-delete at the end.
 *
 * Env-gated: requires DATABASE_URL (real Neon). Run: `npm run golden:credential-session-version-prisma`
 */
import assert from "node:assert";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { prisma } from "@/lib/prisma";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_svm_prisma_${RUN}`;
const USER = `user_svm_prisma_${RUN}`;
const CRED = `cred_svm_prisma_${RUN}`;
const EMAIL = `svmprisma+${RUN}@test.example`;

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

async function seed() {
  const repos = createRepositories("prisma");
  await repos.workspace.create({
    id: WS, name: `SVM Prisma ${RUN}`, status: "active",
    autonomyKillSwitch: false, autoSendToggle: false,
  });
  await repos.user.create({
    id: USER, workspaceId: WS, name: "SVM Prisma", email: EMAIL, role: "owner",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await (repos.userCredential as unknown as {
    create: (input: Record<string, unknown>) => Promise<unknown>;
  }).create({
    id: CRED, userId: USER, workspaceId: WS, email: EMAIL,
    passwordHash: "scrypt:oldhash", sessionVersion: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

async function cleanup() {
  // Gate #8: cascade-delete the workspace (wipes user + credential via FK).
  try {
    await (prisma as unknown as { workspace: { deleteMany: (a: unknown) => Promise<unknown> } }).workspace.deleteMany({ where: { id: WS } });
  } catch { /* best-effort */ }
}

// ─── CASE A: create at version 1, read back → 1 ─────────────────────────────
test("CASE A — create credential at sessionVersion=1; read back is 1", async () => {
  const repos = createRepositories("prisma");
  const cred = await repos.userCredential.findByUserId(USER);
  assert.ok(cred, "credential must exist after create");
  assert.strictEqual(cred!.sessionVersion, 1, "initial sessionVersion must be 1 on real Neon");
});

// ─── CASE B: bump twice → read back = 3 ─────────────────────────────────────
test("CASE B — two updatePasswordAndBumpSession calls → sessionVersion = 3 (1 → 2 → 3)", async () => {
  const repos = createRepositories("prisma");
  await repos.userCredential.updatePasswordAndBumpSession(USER, "scrypt:newhash1");
  await repos.userCredential.updatePasswordAndBumpSession(USER, "scrypt:newhash2");
  const cred = await repos.userCredential.findByUserId(USER);
  assert.ok(cred);
  assert.strictEqual(cred!.sessionVersion, 3, "sessionVersion must be 3 after two bumps");
  assert.strictEqual(cred!.passwordHash, "scrypt:newhash2", "the latest passwordHash must be persisted to Neon");
});

// ─── CASE C: a FRESH repo bundle reads 3 (persistence proof) ────────────────
test("CASE C — a fresh prisma repo bundle reads sessionVersion=3 (persisted, not memory)", async () => {
  const fresh: RepositoryBundle = createRepositories("prisma");
  const cred = await fresh.userCredential.findByUserId(USER);
  assert.ok(cred);
  assert.strictEqual(cred!.sessionVersion, 3, "sessionVersion must be 3 via a fresh repo bundle — it PERSISTED to Postgres");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  await cleanup();
  let passed = 0;
  let failed = 0;
  try {
    // Seed ONCE before the cases (they share the same credential row).
    await seed();
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
  } finally {
    await cleanup();
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-credential-session-version-prisma FAILED — sessionVersion does NOT round-trip through Postgres.");
    process.exit(1);
  }
  console.log("✅ golden-credential-session-version-prisma ALL GREEN ✅");
  process.exit(0);
})();
