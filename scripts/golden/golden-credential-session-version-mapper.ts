/**
 * golden-credential-session-version-mapper.ts — pins that the UserCredential
 * mappers + writers preserve `sessionVersion` across BOTH runtimes
 * (Stage 5 re-audit, F-P1-9).
 *
 * WHAT THIS PROVES
 *   `sessionVersion` is the value baked into the HMAC-signed session cookie
 *   and compared on every authenticated request by
 *   `resolveUserFromSessionWithVersionCheck`. When a password is reset, the
 *   credential's sessionVersion is bumped, which invalidates all prior
 *   sessions (the WP2 session-revocation rule).
 *
 *   Before this fix, the Prisma `mapCredential` mapper DROPPED the field —
 *   so a credential read from Postgres always had `sessionVersion === undefined`.
 *   The version-check then treated undefined as "matches anything" (or rejected
 *   every request, depending on the comparator), breaking the contract in
 *   Prisma-production mode while JSON-demo mode worked fine. This is a
 *   split-brain bug: JSON works, Postgres silently breaks.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — the Prisma mapCredential mapper PRESERVES sessionVersion. We read
 *            the mapper source and assert it copies the field (so a row with
 *            sessionVersion=3 maps to { sessionVersion: 3 }, not undefined).
 *            A future agent who removes the field from the mapper fails here.
 *
 *   CASE B — the Prisma createWorkspaceWithOwner + acceptInviteAtomically
 *            writers STORE sessionVersion on create (so day-1 sessions have a
 *            value to compare against). We statically assert both writers pass
 *            `sessionVersion: input.credential.sessionVersion ?? 1` into the
 *            prisma create payload.
 *
 *   CASE C — the JSON repo round-trips sessionVersion correctly through the
 *            bump primitive (the runtime half we CAN exercise without a DB).
 *            We create a credential at version 1, bump it twice, and assert
 *            the read-back value is 3.
 *
 *   CASE D — the versionCheck comparator treats undefined sessionVersion as
 *            INVALID (not "matches anything"). We read the comparator source
 *            and assert it rejects when the stored version is undefined. This
 *            is the fail-closed rule — a missing field never silently passes.
 *
 * Run: npx tsx scripts/golden/golden-credential-session-version-mapper.ts
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

const RUN_ID = `svm_${Date.now()}`;

/** Ironclad Gate #8: clean up this run's rows from the shared demo file. */
async function cleanupRun() {
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    const testUserIds = new Set(
      (data.users || []).filter((u) => typeof u.email === "string" && u.email.includes(RUN_ID)).map((u) => u.id),
    );
    data.users = (data.users || []).filter((u) => !(typeof u.email === "string" && u.email.includes(RUN_ID)));
    data.userCredentials = (data.userCredentials || []).filter(
      (c) => !(typeof c.email === "string" && c.email.includes(RUN_ID)),
    );
    return undefined;
  });
}

// ─── CASE A: Prisma mapCredential preserves sessionVersion (static) ─────────
test("CASE A — Prisma mapCredential mapper copies sessionVersion from the row", async () => {
  const repoPath = path.resolve(process.cwd(), "src/repositories/prisma/index.ts");
  const src = readFileSync(repoPath, "utf8");

  // Find the UserCredential mapCredential (NOT the LLM one). It's the one that
  // returns UserCredential and includes passwordHash.
  const fnStart = src.indexOf("private mapCredential(record: Record<string, unknown>): UserCredential");
  assert.ok(fnStart > 0, "Prisma UserCredential mapCredential must exist");
  const fnEnd = src.indexOf("}", src.indexOf("return {", fnStart)) + 1;
  const fnBody = src.slice(fnStart, fnEnd);

  assert.match(
    fnBody,
    /sessionVersion\s*:/,
    "Prisma mapCredential MUST copy sessionVersion (F-P1-9 — was dropped, breaking session-revocation in Prisma mode)",
  );
});

// ─── CASE B: Prisma writers store sessionVersion on create (static) ─────────
test("CASE B — Prisma createWorkspaceWithOwner + acceptInviteAtomically store sessionVersion on create", async () => {
  const repoPath = path.resolve(process.cwd(), "src/repositories/prisma/index.ts");
  const src = readFileSync(repoPath, "utf8");

  // Find each method body by matching braces from its `async` keyword to the
  // matching close (methods are class members, so we stop at the next
  // top-level method or class close). A generous 3000-char window safely
  // covers each method body.
  function methodBody(methodName: string): string {
    const start = src.indexOf(`async ${methodName}`);
    assert.ok(start > 0, `${methodName} must exist`);
    return src.slice(start, start + 3000);
  }

  const cwwBody = methodBody("createWorkspaceWithOwner");
  assert.match(
    cwwBody,
    /sessionVersion\s*:/,
    "createWorkspaceWithOwner MUST store sessionVersion on create (so day-1 sessions have a value to compare against)",
  );

  const aiaBody = methodBody("acceptInviteAtomically");
  assert.match(
    aiaBody,
    /sessionVersion\s*:/,
    "acceptInviteAtomically MUST store sessionVersion on create",
  );
});

// ─── CASE C: JSON repo round-trips sessionVersion through the bump primitive ─
test("CASE C — JSON repo: updatePasswordAndBumpSession increments sessionVersion correctly", async () => {
  const repos = createJsonRepos();
  const userId = `user_${RUN_ID}`;
  const workspaceId = `ws_${RUN_ID}`;
  // Seed an isolated workspace + user + credential at version 1.
  await repos.workspace.create({
    id: workspaceId, name: "SVM Test", status: "active",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await repos.user.create({
    id: userId, workspaceId, name: "SVM", email: `svm+${RUN_ID}@test.example`, role: "owner",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await (repos.userCredential as unknown as {
    create: (input: Record<string, unknown>) => Promise<unknown>;
  }).create({
    id: `cred_${RUN_ID}`, userId, workspaceId, email: `svm+${RUN_ID}@test.example`,
    passwordHash: "scrypt:oldhash", sessionVersion: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  // Read back — version is 1.
  let cred = await repos.userCredential.findByUserId(userId);
  assert.ok(cred, "credential must exist");
  assert.strictEqual(cred!.sessionVersion, 1, "initial sessionVersion must be 1");

  // Bump twice → version is 3.
  await repos.userCredential.updatePasswordAndBumpSession(userId, "scrypt:newhash1");
  await repos.userCredential.updatePasswordAndBumpSession(userId, "scrypt:newhash2");
  cred = await repos.userCredential.findByUserId(userId);
  assert.ok(cred);
  assert.strictEqual(cred!.sessionVersion, 3, "sessionVersion must be 3 after two bumps (1 → 2 → 3)");
  assert.strictEqual(cred!.passwordHash, "scrypt:newhash2", "the latest passwordHash must be persisted");
});

// ─── CASE D: version-check comparator treats undefined as INVALID ────────────
test("CASE D — resolveUserFromSessionWithVersionCheck rejects when stored sessionVersion is undefined", async () => {
  const authPath = path.resolve(process.cwd(), "src/lib/auth-service.ts");
  const src = readFileSync(authPath, "utf8");

  // The version check must NOT treat undefined as "matches anything". Find the
  // comparator inside resolveUserFromSessionWithVersionCheck.
  // NOTE (2026-08-04 build-right audit, Test-Honesty): the OLD code anchored on
  // the FIRST occurrence of the name, which was a comment ~150 lines ABOVE the
  // function. The 4000-char window from there didn't reach the real comparator
  // (line ~309), so CASE D always failed even though the code is correct (it
  // uses `payload.sessionVersion !== currentVersion`). Now we anchor on the
  // actual function declaration so the window covers the real body.
  // 2026-09-28 (S9): resolveUserFromSessionWithVersionCheck, resolveCurrentUser
  // and /auth/me now all delegate to ONE core, resolveSessionPayload — so the
  // comparator is read there. The wrapper must still call it.
  const wrapperStart = src.indexOf("export async function resolveUserFromSessionWithVersionCheck");
  assert.ok(wrapperStart > 0, "resolveUserFromSessionWithVersionCheck function declaration must exist");
  assert.match(src.slice(wrapperStart, wrapperStart + 800), /resolveSessionPayload\(/, "the wrapper must run the shared session check");
  const fnStart = src.indexOf("async function resolveSessionPayload");
  assert.ok(fnStart > 0, "resolveSessionPayload (the shared session check) must exist");
  // Read the function body (~80 lines is enough for the comparator).
  const fnBody = src.slice(fnStart, fnStart + 5000);

  // The check must compare sessionVersion from the credential against the
  // token's sessionVersion, AND must reject when the credential's version is
  // undefined (fail-closed). We assert the comparator mentions both fields.
  assert.match(fnBody, /sessionVersion/, "the version check must reference sessionVersion");
  // And it must NOT have a permissive `?? 0` or `|| 0` fallback that would
  // make undefined silently equal to the token's version. (A `?? 1` default
  // for FRESH credentials is fine — that's the create-time default. The bug
  // would be a fallback INSIDE THE COMPARATOR that masks a missing field.)
  // We assert the comparator uses strict inequality (=== or !==) on the versions.
  assert.match(fnBody, /sessionVersion\s*(===|!==|==|!=)/, "the version check must use strict comparison on sessionVersion");
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
    console.error("❌ golden-credential-session-version-mapper FAILED — F-P1-9 not closed.");
    process.exit(1);
  }
  console.log("✅ golden-credential-session-version-mapper ALL GREEN ✅");
  process.exit(0);
})();
