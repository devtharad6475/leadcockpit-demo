/**
 * golden-operator-script-env.ts — N-ENV-2.
 *
 * WHY THIS TEST EXISTS
 *
 *   `npm run bootstrap:owner` is the FIRST command a new operator runs. It
 *   creates their account. Until 2026-08-26 it worked on a developer's laptop
 *   and refused to run inside a container, with a message that sent the
 *   operator looking for a setting that was already in their config file:
 *
 *       ERROR: AUTH_SESSION_SECRET must be set and at least 32 characters
 *
 *   The cause was not the script. A standalone `tsx` script does not load
 *   `.env`; these two got it as a SIDE EFFECT of importing Prisma, because the
 *   Prisma client loads `.env` when it is imported — unless `DATABASE_URL` is
 *   already set, in which case it assumes the environment is configured and
 *   does nothing. A container supplies `DATABASE_URL` as an environment
 *   variable. That is the entire bug: the one variable a deployment always sets
 *   is the variable that switches off the loading of all the others.
 *
 *   Nobody chose that dependency and no file named it, which is why it survived.
 *   `scripts/_helpers/load-env-first.ts` now makes it explicit, and this golden
 *   is what stops it becoming implicit again.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat)
 *
 *   Both cases run the real script as a real child process, with `DATABASE_URL`
 *   pre-set — the container condition — and `AUTH_MODE=production`, and with
 *   NOTHING else supplied. Everything the script needs must therefore come from
 *   `.env` or not at all.
 *
 *   CASE A — bootstrap-owner gets PAST env validation and stops at the first
 *     ARGUMENT check. `--email <valid-email> is required` is the proof: env
 *     validation runs before argument validation in that script, so reaching
 *     the argument error means every environment check passed.
 *
 *   CASE B — bootstrap-admin, identically.
 *
 *   CASE C — THE PRECEDENCE GUARD. A value already in the real environment must
 *     beat the file. The child is given a deliberately too-short
 *     AUTH_SESSION_SECRET; the script must REJECT it. If the loader overwrote
 *     the real environment with `.env`'s valid 64-character value, the script
 *     would sail past and CASE A's guarantee would be worthless — it would be
 *     proving that `.env` always wins, which is the opposite of what an
 *     operator running a one-off command expects.
 *
 *   CASE D — the scripts still need `.env` for a reason. It asserts the child
 *     is genuinely NOT being handed the secret in its environment, so CASE A
 *     cannot pass by accident on an inherited value.
 *
 *   WHAT THIS GOLDEN DELIBERATELY DOES NOT DO. It never supplies `--email`, so
 *   both scripts exit at argument validation and NOTHING is created. The
 *   database URL it passes is unroutable by construction (port 1, a name that
 *   exists nowhere) and is never reached, because both scripts exit before they
 *   connect. No account, no workspace, no credential, no connection.
 *
 * MUTATION-TESTED 2026-08-26, every mutation compiling clean under tsc and all
 * sources restored byte-identical (sha256 verified) afterwards:
 *   m1 SHIPPING: bootstrap-owner drops the load-env-first import   -> CASE A fails
 *   m2 SHIPPING: bootstrap-admin drops the load-env-first import   -> CASE B fails
 *   m3 SHIPPING: the loader stops honouring an existing env value  -> CASE C fails
 * 3 of 3 caught, no equivalents. All three mutate shipping scripts rather than
 * the test, which is the point: each one restores the exact defect N-ENV-2 was.
 *
 * Run: npx tsx scripts/golden/golden-operator-script-env.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { spawnSync } from "node:child_process";

/**
 * Unroutable by construction (N-SAFETY-1): port 1, a database name that exists
 * nowhere, and a password that is a literal statement of what it is not. Its
 * only job is to be PRESENT, because presence is what makes Prisma skip loading
 * `.env`. Neither script gets far enough to open a connection.
 */
const CONTAINER_DATABASE_URL = "postgresql://golden:not-a-real-password@127.0.0.1:1/leadgen-does-not-exist";

/**
 * The child's environment, built by NAME rather than inherited, so a variable
 * that happens to be set in the suite's own shell cannot make a case pass.
 * `PATH` is kept because npx needs it; `SystemRoot`/`ComPrec` keep Node happy on
 * Windows.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "NODE_PATH"];
  const env: Record<string, string> = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.AUTH_MODE = "production";
  env.DATABASE_URL = CONTAINER_DATABASE_URL;
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

function run(script: string, extra: Record<string, string> = {}): string {
  const result = spawnSync("npx", ["tsx", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: true,
    env: childEnv(extra),
    timeout: 120_000,
  });
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

let failures = 0;

function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    console.log(`${name} pass`);
    return;
  }
  console.log(`${name} FAIL — ${detail}`);
  failures += 1;
}

async function main() {
  // ── CASE D — the child really is missing the secret ──────────────────────
  const built = childEnv();
  check(
    "CASE D",
    !built.AUTH_SESSION_SECRET && !built.ENCRYPTION_KEY,
    `the child env already carries AUTH_SESSION_SECRET/ENCRYPTION_KEY, so CASE A and B would prove nothing about .env`,
  );

  // ── CASE A — bootstrap-owner ─────────────────────────────────────────────
  const owner = run("scripts/bootstrap-owner.ts");
  check(
    "CASE A",
    /--email <valid-email> is required/.test(owner) && !/AUTH_SESSION_SECRET must be set/.test(owner),
    `bootstrap-owner did not get past environment validation with DATABASE_URL pre-set. It said:\n     ${owner.trim().split("\n")[0]}`,
  );

  // ── CASE B — bootstrap-admin ─────────────────────────────────────────────
  const admin = run("scripts/bootstrap-admin.ts");
  check(
    "CASE B",
    /--email <valid-email> is required/.test(admin) && !/SESSION_SECRET.*must be set/.test(admin),
    `bootstrap-admin did not get past environment validation with DATABASE_URL pre-set. It said:\n     ${admin.trim().split("\n")[0]}`,
  );

  // ── CASE C — the real environment beats the file ─────────────────────────
  const shortSecret = run("scripts/bootstrap-owner.ts", { AUTH_SESSION_SECRET: "too-short" });
  check(
    "CASE C",
    /AUTH_SESSION_SECRET must be set and at least 32 characters/.test(shortSecret),
    `a deliberately invalid AUTH_SESSION_SECRET in the real environment was overwritten by .env. The loader must never overwrite a value the operator set.`,
  );

  console.log("");
  if (failures === 0) {
    console.log("=== OPERATOR SCRIPT ENV: 4/4 CASES PASS ✅ (bootstrap scripts read .env even when DATABASE_URL is pre-set) ===");
    process.exit(0);
  }
  console.log(`=== OPERATOR SCRIPT ENV: ${failures} CASE(S) FAILED ❌ ===`);
  process.exit(1);
}

main().catch((error) => {
  console.error("GOLDEN CRASHED:", error);
  process.exit(1);
});
