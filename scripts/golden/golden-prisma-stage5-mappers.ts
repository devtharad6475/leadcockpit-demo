/**
 * golden-prisma-stage5-mappers.ts — pins that the Stage 5 Prisma repos map
 * raw DB rows through explicit field-by-field mappers (Stage 5 re-audit, F-P2-7).
 *
 * WHAT THIS PROVES
 *   The Stage 5 Prisma repos (FeatureFlag, PasswordResetToken,
 *   ImpersonationSession, EmailVerificationToken, Invite, PlatformAdmin,
 *   PlatformAdminCredential, PlatformAuditLog) originally returned rows via
 *   `record as unknown as FeatureFlag` — a raw cast that skips mapping.
 *
 *   Why that's a bug (build-right Phase 3d "Strict Typing"): Prisma returns
 *   `Date` objects for timestamp columns, but the domain types expect ISO
 *   `string`. The cast hides the mismatch — `featureFlag.updatedAt` is a
 *   `Date` object masquerading as `string`. When downstream code calls
 *   `.slice()` or string methods on it, the behavior is undefined. A field
 *   rename (camelCase vs snake_case) would also pass the cast silently.
 *
 *   The fix: each repo gets an explicit `mapXxx(record)` helper that converts
 *   each field (especially `iso(date)` for timestamps). The cast disappears.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — every Stage 5 Prisma repo class has a private mapXxx helper that
 *            takes a `Record<string, unknown>` and returns the typed shape.
 *            We statically assert the helper exists for each repo.
 *
 *   CASE B — the raw `as unknown as <Stage5Type>` casts are GONE from the
 *            Stage 5 repo methods. We grep the file and assert ZERO remaining
 *            casts against the 8 Stage 5 types. (A future agent who re-adds a
 *            cast fails here.)
 *
 *   CASE C — the JSON repos (which already use mappers) round-trip the
 *            timestamp fields as ISO STRINGS (not Date objects). We create a
 *            feature flag, read it back, and assert `updatedAt` is a string
 *            matching the ISO format. This pins the contract the Prisma
 *            mappers must ALSO satisfy.
 *
 * NOTE: A full Prisma round-trip would need DATABASE_URL. CASE A + B pin the
 * fix statically (the regression vector is "agent removes the mapper"); CASE C
 * proves the contract is satisfiable at the JSON layer. Together they close
 * the finding as strongly as possible without a live Postgres.
 *
 * Run: npx tsx scripts/golden/golden-prisma-stage5-mappers.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createJsonRepos } from "./_helpers/provider";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN_ID = `s5m_${Date.now()}`;

async function cleanupRun() {
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    data.featureFlags = (data.featureFlags || []).filter(
      (f) => !(typeof f.lastToggledByAdminId === "string" && f.lastToggledByAdminId.includes(RUN_ID)),
    );
    data.platformAdmins = (data.platformAdmins || []).filter(
      (a) => !(typeof a.email === "string" && a.email.includes(RUN_ID)),
    );
    data.platformAdminCredentials = (data.platformAdminCredentials || []).filter(
      (c) => !(typeof c.email === "string" && c.email.includes(RUN_ID)),
    );
    return undefined;
  });
}

/** The 8 Stage 5 types whose Prisma repos must use mappers, not raw casts. */
const STAGE5_TYPES = [
  "FeatureFlag",
  "PasswordResetToken",
  "ImpersonationSession",
  "EmailVerificationToken",
  "Invite",
  "PlatformAdmin",
  "PlatformAdminCredential",
  "PlatformAuditLog",
];

// ─── CASE A: every Stage 5 Prisma repo has a mapXxx helper ──────────────────
test("CASE A — every Stage 5 Prisma repo declares a private mapXxx helper", async () => {
  const repoPath = path.resolve(process.cwd(), "src/repositories/prisma/index.ts");
  const src = readFileSync(repoPath, "utf8");

  // Each Stage 5 type T needs a `mapT(record: Record<string, unknown>): T` or
  // `private mapT(record: ...): T` helper somewhere in the file.
  const expectedMappers: Record<string, RegExp> = {
    FeatureFlag: /mapFeatureFlag\s*\(/,
    PasswordResetToken: /mapPasswordResetToken\s*\(/,
    ImpersonationSession: /mapImpersonationSession\s*\(/,
    EmailVerificationToken: /mapEmailVerificationToken\s*\(/,
    Invite: /mapInvite\s*\(/,
    PlatformAdmin: /mapPlatformAdmin\s*\(/,
    PlatformAdminCredential: /mapPlatformAdminCredential\s*\(/,
    PlatformAuditLog: /mapPlatformAuditLog\s*\(/,
  };

  for (const [type, pattern] of Object.entries(expectedMappers)) {
    assert.ok(
      pattern.test(src),
      `Stage 5 Prisma repo for ${type} MUST have a mapXxx helper (F-P2-7 — was using raw 'as unknown as ${type}' cast, hiding Date-vs-string and field-rename bugs)`,
    );
  }
});

// ─── CASE B: raw 'as unknown as <Stage5Type>' casts are GONE ────────────────
test("CASE B — ZERO remaining 'as unknown as <Stage5Type>' casts in the Stage 5 repo methods", async () => {
  const repoPath = path.resolve(process.cwd(), "src/repositories/prisma/index.ts");
  const src = readFileSync(repoPath, "utf8");

  const offenders: string[] = [];
  for (const type of STAGE5_TYPES) {
    // Match `as unknown as FeatureFlag` (with optional array suffix []).
    const pattern = new RegExp(`as\\s+unknown\\s+as\\s+${type}(\\[\\])?\\b`, "g");
    const matches = src.match(pattern);
    if (matches && matches.length > 0) {
      offenders.push(`${type}: ${matches.length} cast(s) remaining`);
    }
  }
  assert.strictEqual(
    offenders.length,
    0,
    `Stage 5 Prisma repos must NOT use raw 'as unknown as <Type>' casts (F-P2-7). Offenders:\n  - ${offenders.join("\n  - ")}`,
  );
});

// ─── CASE C: JSON repo round-trips timestamps as ISO strings ────────────────
test("CASE C — JSON repo: featureFlag timestamps are ISO strings (the contract Prisma mappers must match)", async () => {
  const repos = createJsonRepos();
  // Seed an admin + toggle a flag (the only way to create a flag row).
  const adminId = `admin_${RUN_ID}`;
  await repos.platformAdmin.createWithCredential({
    admin: { id: adminId, email: `s5m+${RUN_ID}@test.example`, name: "S5M", role: "operator", status: "active" },
    credential: { adminId, email: `s5m+${RUN_ID}@test.example`, passwordHash: "x".repeat(60) },
  });
  await repos.featureFlag.upsert({ key: "new_signup_enabled", enabled: false, lastToggledByAdminId: adminId });

  const flag = await repos.featureFlag.getByKey("new_signup_enabled");
  assert.ok(flag, "flag must exist after upsert");
  // updatedAt MUST be a string (ISO format), NOT a Date object. This is the
  // contract the Prisma mapper must also satisfy.
  assert.strictEqual(typeof flag!.updatedAt, "string", "updatedAt must be a string (ISO), not a Date object");
  assert.match(flag!.updatedAt as string, /^\d{4}-\d{2}-\d{2}T/, "updatedAt must be ISO format");
  // createdAt too.
  assert.strictEqual(typeof flag!.createdAt, "string", "createdAt must be a string (ISO)");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  await cleanupRun();
  let passed = 0;
  let failed = 0;
  try {
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
    await cleanupRun();
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-prisma-stage5-mappers FAILED — F-P2-7 not closed.");
    process.exit(1);
  }
  console.log("✅ golden-prisma-stage5-mappers ALL GREEN ✅");
  process.exit(0);
})();
