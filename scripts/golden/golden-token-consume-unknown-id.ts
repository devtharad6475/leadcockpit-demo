/**
 * Golden test — ONE-SHOT SECURITY TOKENS: consuming an id that does not exist
 * must FAIL, on both substrates (N-DATA-20, session 27).
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Three repository methods stamp a security token as spent:
 *
 *   passwordResetToken.markConsumed(id)     — the reset link has been used
 *   emailVerificationToken.markConsumed(id) — the verify link has been clicked
 *   impersonationSession.markEnded(id)      — the support session is over
 *
 * All three are ONE-SHOT semantics: after the stamp, the credential is dead.
 * The stamp is the only thing standing between "used once" and "reusable".
 *
 * Until today the two substrates disagreed about what happens when the id is
 * not there. `src/repositories/json/index.ts` wrapped every write in
 * `if (item) { ... }`, so the call resolved quietly and reported success.
 * `src/repositories/prisma/index.ts` issues a bare `update({ where: { id } })`,
 * which throws `No record was found for an update`.
 *
 * Prisma is the correct one, and this is not a style question. If
 * `markConsumed` can silently do nothing, then a caller that consumes the
 * wrong id — a stale id, a truncated id, an empty string — believes the token
 * is dead while the row is still live and unconsumed. That is precisely the
 * reusable-reset-link window `scripts/golden/golden-password-reset-redemption.ts`
 * CASE E exists to rule out, reintroduced one layer below it.
 *
 * It is also not hypothetical. The old body of that same reset golden carried
 * a stray `markConsumed("")` on an id that existed nowhere. It sat there for
 * months. On JSON it was a no-op, so nobody noticed; the line was only found
 * because moving the case onto Postgres made it throw (see L24 in
 * docs/LESSONS-FOR-THE-SKILL.md).
 *
 * ─── WHAT THIS PROVES ──────────────────────────────────────────────────────
 *
 * The same six cases run TWICE, once per substrate:
 *
 *   CASE A — passwordResetToken.markConsumed(unknown id)     → THROWS
 *   CASE B — emailVerificationToken.markConsumed(unknown id) → THROWS
 *   CASE C — impersonationSession.markEnded(unknown id)      → THROWS
 *   CASE D — passwordResetToken.markConsumed(REAL id)     → succeeds + stamps
 *   CASE E — emailVerificationToken.markConsumed(REAL id) → succeeds + stamps
 *   CASE F — impersonationSession.markEnded(REAL id)      → succeeds + stamps
 *
 * D/E/F are not padding. A guard that refuses everything is exactly as broken
 * as one that refuses nothing — it would kill every password reset in the
 * product while turning this file green on A/B/C alone. The refusal has to be
 * narrow, and the only way to show it is narrow is to drive the happy path
 * through the same method in the same run.
 *
 * On JSON the refusal message is additionally required to NAME the record
 * type, because an operator reading a production log needs to know which of
 * the three tokens failed. Prisma's own message ("No record was found for an
 * update") does not name it and cannot be made to, so that assertion is
 * JSON-only and is stated as such rather than being weakened for both.
 *
 * ─── SUBSTRATE ─────────────────────────────────────────────────────────────
 *
 * // HYBRID_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. Same
 * reasoning as golden-substrate-parity.ts: this file names both substrates
 * itself via createRepositories("json") / createRepositories("prisma"), so it
 * must NOT be force-pinned to JSON, but it DOES need JSON-side data isolation
 * from the preload _helpers/isolate-json-data.ts.
 *
 * Postgres handling follows golden-substrate-parity.ts exactly, and for the
 * same audit-F-4 test-honesty reason:
 *   - no DATABASE_URL at all        → SKIP the Prisma half, exit 0, say so;
 *   - DATABASE_URL set but down     → NOT VERIFIED, exit 1 (unless --allow-skip);
 *   - DATABASE_URL reachable        → run it for real.
 * The JSON half always runs and always has to pass.
 *
 * Cleanup: CASE D/E need a workspace (both token tables carry a
 * `workspace Workspace @relation(... onDelete: Cascade)`). One throwaway
 * workspace per substrate, removed in a `finally` via workspace.delete(), which
 * is documented as a no-op for an absent id and so is safe to call blind.
 *
 * ─── MUTATION RECORD ───────────────────────────────────────────────────────
 *
 * 2026-08-26 (session 27). Every mutation is on SHIPPING code
 * (src/repositories/json/index.ts), each compiles clean under `tsc --noEmit`,
 * and the file was restored byte-identical (sha256) afterwards.
 *
 *   m22 — put the `if (item) { ... }` no-op back on passwordResetToken
 *         → CASE A fails: "it resolved quietly — a spent reset link would
 *           stay live". RECEIPT: golden-password-reset-redemption, the golden
 *           whose whole subject is one-shot reset links, ran GREEN under this
 *           mutation (5 passed, 0 failed, exit 0). Nothing in the suite of 185
 *           noticed.
 *   m23 — same, on emailVerificationToken
 *         → CASE B fails. RECEIPT: golden-signup-invite GREEN (15 passed, 0
 *           failed, exit 0).
 *   m24 — same, on impersonationSession.markEnded
 *         → CASE C fails. RECEIPT: golden-platform-admin-ops GREEN (14 passed,
 *           0 failed, exit 0).
 *   m25 — the OPPOSITE failure: a guard that refuses EVERY id, real ones
 *         included (the find() is kept but made unreachable via
 *         `process.env.__MUTATION_NEVER_SET__`, so it still compiles)
 *         → CASE D fails: "threw: Password reset token not found",
 *           "consumedAt=undefined". This one IS also caught elsewhere
 *           (golden-password-reset-redemption goes 1 passed / 4 failed), which
 *           is the expected result — a guard that breaks everything is loud.
 *           CASE D/E/F are here so this file can tell the two failure modes
 *           apart on its own.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/isolate-json-data.ts \
 *        scripts/golden/golden-token-consume-unknown-id.ts
 */
import { createRepositories } from "../../src/repositories";
import type { RepositoryBundle } from "../../src/repositories/interfaces";

const ALLOW_SKIP = process.argv.includes("--allow-skip");
const STAMP = Date.now();

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  OK: ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Runs `fn` and returns the Error it threw, or undefined if it did not throw. */
async function capture(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const ISO = (offsetMs: number) => new Date(STAMP + offsetMs).toISOString();

/**
 * The six cases, against whichever bundle it is handed.
 *
 * `nameTheRecord` is true only on JSON — see the header. Prisma's P2025 text
 * is fixed by Prisma and says nothing about which table it was.
 */
async function runCases(repos: RepositoryBundle, substrate: string, nameTheRecord: boolean) {
  const wsId = `tcu-${STAMP}-${substrate}-ws`;
  const userId = `tcu-${STAMP}-${substrate}-user`;

  try {
    await repos.workspace.create({ id: wsId, name: `token-consume golden (${substrate})` });

    // ── CASE A/B/C — an id that exists nowhere is REFUSED ─────────────────
    // Not seeded, not deleted, never issued: these ids have no row on either
    // substrate. Distinct per case so a failure names the method it came from.
    console.log(`\n[${substrate}] CASE A/B/C — an unknown id must be refused:`);

    const unknownReset = `prt_no_such_row_${STAMP}`;
    const errA = await capture(() => repos.passwordResetToken.markConsumed(unknownReset));
    ok(
      `[${substrate}] passwordResetToken.markConsumed(unknown) THROWS`,
      errA !== undefined,
      "it resolved quietly — a spent reset link would stay live",
    );
    if (nameTheRecord) {
      ok(
        `[${substrate}] ...and the message names the record ("password reset token")`,
        /password reset token/i.test(errA?.message || ""),
        `got: ${errA?.message ?? "(no error)"}`,
      );
    }

    const unknownVerify = `evt_no_such_row_${STAMP}`;
    const errB = await capture(() => repos.emailVerificationToken.markConsumed(unknownVerify));
    ok(
      `[${substrate}] emailVerificationToken.markConsumed(unknown) THROWS`,
      errB !== undefined,
      "it resolved quietly — an email could be marked verified against no token",
    );
    if (nameTheRecord) {
      ok(
        `[${substrate}] ...and the message names the record ("email verification token")`,
        /email verification token/i.test(errB?.message || ""),
        `got: ${errB?.message ?? "(no error)"}`,
      );
    }

    const unknownSession = `imp_no_such_row_${STAMP}`;
    const errC = await capture(() => repos.impersonationSession.markEnded(unknownSession));
    ok(
      `[${substrate}] impersonationSession.markEnded(unknown) THROWS`,
      errC !== undefined,
      "it resolved quietly — a support session would be reported ended while still open",
    );
    if (nameTheRecord) {
      ok(
        `[${substrate}] ...and the message names the record ("impersonation session")`,
        /impersonation session/i.test(errC?.message || ""),
        `got: ${errC?.message ?? "(no error)"}`,
      );
    }

    // ── CASE D/E/F — a REAL id still consumes, and the stamp lands ─────────
    // The narrowness check. Neither substrate assigns the id we ask for
    // (Prisma's is @default(cuid())), so the id under test is the one the
    // create call handed back — which is also the only id a caller would ever
    // have.
    console.log(`\n[${substrate}] CASE D/E/F — a real id still works, and the stamp lands:`);

    const resetHash = `hash_reset_${STAMP}_${substrate}`;
    const reset = await repos.passwordResetToken.create({
      userId,
      workspaceId: wsId,
      tokenHash: resetHash,
      issuedAt: ISO(0),
      expiresAt: ISO(24 * 60 * 60 * 1000),
      issuedByAdminId: `tcu-${STAMP}-admin`,
    });
    const errD = await capture(() => repos.passwordResetToken.markConsumed(reset.id));
    ok(
      `[${substrate}] passwordResetToken.markConsumed(real id) SUCCEEDS`,
      errD === undefined,
      `threw: ${errD?.message ?? ""}`,
    );
    const resetAfter = await repos.passwordResetToken.findByTokenHash(resetHash);
    ok(
      `[${substrate}] ...and consumedAt is now stamped (the link is actually dead)`,
      Boolean(resetAfter?.consumedAt),
      `consumedAt=${String(resetAfter?.consumedAt)}`,
    );

    const verifyHash = `hash_verify_${STAMP}_${substrate}`;
    const verify = await repos.emailVerificationToken.create({
      userId,
      workspaceId: wsId,
      tokenHash: verifyHash,
      issuedAt: ISO(0),
      expiresAt: ISO(24 * 60 * 60 * 1000),
      source: "signup",
    });
    const errE = await capture(() => repos.emailVerificationToken.markConsumed(verify.id));
    ok(
      `[${substrate}] emailVerificationToken.markConsumed(real id) SUCCEEDS`,
      errE === undefined,
      `threw: ${errE?.message ?? ""}`,
    );
    const verifyAfter = await repos.emailVerificationToken.findByTokenHash(verifyHash);
    ok(
      `[${substrate}] ...and consumedAt is now stamped`,
      Boolean(verifyAfter?.consumedAt),
      `consumedAt=${String(verifyAfter?.consumedAt)}`,
    );

    const sessionHash = `hash_imp_${STAMP}_${substrate}`;
    const session = await repos.impersonationSession.create({
      adminId: `tcu-${STAMP}-admin`,
      targetUserId: userId,
      targetWorkspaceId: wsId,
      tokenHash: sessionHash,
      startedAt: ISO(0),
      expiresAt: ISO(15 * 60 * 1000),
      reason: "golden N-DATA-20",
    });
    const errF = await capture(() => repos.impersonationSession.markEnded(session.id));
    ok(
      `[${substrate}] impersonationSession.markEnded(real id) SUCCEEDS`,
      errF === undefined,
      `threw: ${errF?.message ?? ""}`,
    );
    const sessionAfter = await repos.impersonationSession.findByTokenHash(sessionHash);
    ok(
      `[${substrate}] ...and endedAt is now stamped (the session is actually over)`,
      Boolean(sessionAfter?.endedAt),
      `endedAt=${String(sessionAfter?.endedAt)}`,
    );
  } finally {
    // Documented as a no-op for an id that is not there, so this cannot mask
    // the real failure with a cleanup error.
    await repos.workspace.delete(wsId);

    // N-DATA-2 (2026-08-26): the workspace delete does NOT take the
    // impersonation session with it, and CASE F creates one on every run. The
    // JSON half is harmless (the preload gives it a throwaway data directory),
    // but the Prisma half writes to the database the operator actually uses,
    // and 45 of these had piled up there before anything was watching.
    //
    // ImpersonationSessionRepository has no delete() — the interface offers
    // create / find / markEnded and nothing else. That is a real gap worth its
    // own entry (nothing in the product can ever remove one, so the table grows
    // without bound in production too), but widening a product interface to
    // tidy up after a test is the wrong trade, so this reaches past the
    // repository for its own row and only its own row: tokenHash carries this
    // run's STAMP and the substrate name, so it can match nothing else.
    if (substrate === "prisma") {
      try {
        const { prisma } = await import("../../src/lib/prisma");
        await (prisma as unknown as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>)
          .impersonationSession.deleteMany({ where: { tokenHash: `hash_imp_${STAMP}_${substrate}` } });
      } catch { /* best-effort: a cleanup error must never mask a real failure */ }
    }
  }
}

async function main() {
  console.log("GOLDEN: one-shot token consume — unknown id must be refused (N-DATA-20)");

  // ── JSON half — always runs, always has to pass ──────────────────────────
  // Data-file isolation comes from the _helpers/isolate-json-data.ts PRELOAD,
  // never from code in this file: src/lib/db.ts reads LEADGEN_DATA_DIR into a
  // module-level const at first import, and the import at the top of this file
  // has already triggered that by the time main() runs. See that helper's
  // header — golden-substrate-parity.ts shipped this exact bug once.
  await runCases(createRepositories("json"), "json", true);

  // ── Prisma half ─────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    console.log("");
    console.log("  ════════════════════════════════════════════════════════");
    console.log("   SKIPPED (Prisma half) — no DATABASE_URL configured.");
    console.log("   The JSON half above still ran and still had to pass.");
    console.log("  ════════════════════════════════════════════════════════");
  } else {
    const prismaError = await capture(() => runCases(createRepositories("prisma"), "prisma", false));
    if (prismaError) {
      const message = prismaError.message;
      const unreachable =
        /Can't reach database server|ECONNREFUSED|ENOTFOUND|getaddrinfo|Timed out fetching|terminating connection/i.test(
          message,
        );
      if (unreachable) {
        console.log("");
        console.log("  ════════════════════════════════════════════════════════");
        console.log("   Postgres unreachable — the Prisma half was NOT verified");
        console.log(`   ${message.split("\n")[0]}`);
        console.log("  ════════════════════════════════════════════════════════");
        if (!ALLOW_SKIP) {
          console.log("");
          console.log("  Re-run with a reachable DATABASE_URL, or pass --allow-skip to");
          console.log("  acknowledge an offline database deliberately.");
          console.log("");
          console.log("=== token-consume-unknown-id: NOT VERIFIED (Postgres down) ===");
          process.exit(1);
        }
        console.log("");
        console.log("  --allow-skip given: the Prisma half is SKIPPED, not passed.");
      } else {
        // Anything else is the finding, not a connectivity problem. Print the
        // WHOLE message — Prisma buries the actionable line several down.
        failed += 1;
        console.log("");
        console.log("  FAIL: the Prisma half threw outside a case:");
        console.log(message.split("\n").map((l) => `    ${l}`).join("\n"));
      }
    }
  }

  console.log(`\n=== token-consume-unknown-id: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("FAIL golden-token-consume-unknown-id — a one-shot token can be 'consumed' against no row.");
    process.exit(1);
  }
  console.log("PASS golden-token-consume-unknown-id: consuming an id that does not exist is refused on both substrates.");
}

main().catch((err) => {
  console.error("\nFAIL golden-token-consume-unknown-id:", err instanceof Error ? err.message : err);
  process.exit(1);
});
