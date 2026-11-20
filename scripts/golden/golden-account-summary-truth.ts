/**
 * golden-account-summary-truth.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Settings → "Who you are and how this workspace is set up", read on the live
 * deployment while signed in as the owner with a real password:
 *
 *   Current user          Demo Owner              ← it was Dev Prayag Tharad
 *   Sign-in               Demo mode — no password needed
 *   Production login      Not switched on yet     ← it was on
 *   Where data is stored  A file on this machine  ← it was Neon Postgres
 *
 * Four of five rows false, because every one of them was a hardcoded string.
 * The panel whose entire job is telling an owner how their workspace is set up
 * was describing a different one — the developer's laptop, months earlier.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the exact live workspace. Every row matches what the system
 *   actually reports.
 *
 *   CASE B — the demo workspace still reads as demo. This is not "always say
 *   production"; it is "say what is true".
 *
 *   CASE C — an unanswered call must never produce a confident claim. The bug
 *   was confidence, so a missing answer says so instead of guessing.
 *
 *   CASE D — a signed-out visitor is not called "Demo Owner".
 *
 *   CASE E — the words "Demo Owner" and "A file on this machine" can only ever
 *   appear when the system actually says so, for any combination of inputs.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { accountSummaryRows, UNKNOWN } from "@/lib/account-summary";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

/** Exactly what /api/auth/status and /api/health returned on the live site. */
const LIVE = {
  authMode: "production",
  user: { id: "user_5aac", email: "owner@example.com", name: "Dev Prayag Tharad", role: "owner" },
  loaded: true,
  persistenceProvider: "prisma",
  workspaceName: "Default Workspace",
  formatRole: (role: string) => role.charAt(0).toUpperCase() + role.slice(1),
};

test("CASE A — the live workspace is described as it actually is", () => {
  const rows = accountSummaryRows(LIVE);
  assert.strictEqual(rows["Current user"], "Dev Prayag Tharad", "the screen said 'Demo Owner' to the person whose name it knew");
  assert.strictEqual(rows["Sign-in"], "Email and password", "they had just typed a password to get here");
  assert.strictEqual(rows["Production login"], "On", "it said 'Not switched on yet' while switched on");
  assert.strictEqual(rows["Where data is stored"], "A PostgreSQL database", "it said 'A file on this machine' about a Neon database");
  assert.strictEqual(rows.Role, "Owner");
  assert.strictEqual(rows.Workspace, "Default Workspace");
});

test("CASE B — a demo workspace still reads as a demo workspace", () => {
  const rows = accountSummaryRows({ authMode: "demo", loaded: true, persistenceProvider: "json", workspaceName: "Demo workspace" });
  assert.strictEqual(rows["Sign-in"], "Demo mode — no password needed");
  assert.strictEqual(rows["Production login"], "Not switched on yet");
  assert.strictEqual(rows["Where data is stored"], "A file on the server",
    "the JSON substrate is a file on the SERVER — 'this machine' is the browser the owner is sitting at");
});

test("CASE C — an unanswered call says so instead of guessing", () => {
  const rows = accountSummaryRows({ loaded: false, persistenceProvider: "" });
  for (const key of ["Current user", "Role", "Sign-in", "Production login", "Where data is stored"]) {
    assert.strictEqual(rows[key], UNKNOWN, `${key} must not assert anything before the system has answered`);
  }
});

test("CASE D — a signed-out visitor is not given a name", () => {
  const rows = accountSummaryRows({ authMode: "production", loaded: true, persistenceProvider: "prisma" });
  assert.strictEqual(rows["Current user"], "Not signed in");
  assert.strictEqual(rows.Role, "Unknown");
});

test("CASE E — the two false claims can only appear when they are true", () => {
  const modes = ["production", "demo", undefined];
  const providers = ["prisma", "json", ""];
  const loadedStates = [true, false];
  const wrong: string[] = [];
  for (const authMode of modes) {
    for (const persistenceProvider of providers) {
      for (const loaded of loadedStates) {
        const rows = accountSummaryRows({ authMode, persistenceProvider, loaded, user: loaded ? { name: "Real Person", role: "owner" } : undefined });
        const printed = Object.values(rows).join(" | ");
        if (printed.includes("Demo Owner")) wrong.push(`"Demo Owner" printed for ${authMode}/${persistenceProvider}/${loaded}`);
        if (printed.includes("this machine")) wrong.push(`"this machine" printed for ${authMode}/${persistenceProvider}/${loaded}`);
        if (persistenceProvider === "prisma" && printed.includes("A file on")) {
          wrong.push(`called Postgres a file for ${authMode}/${loaded}`);
        }
        if (authMode !== "production" && loaded && printed.includes("Email and password")) {
          wrong.push(`claimed password sign-in in ${authMode} mode`);
        }
      }
    }
  }
  assert.deepStrictEqual(wrong, [], "these two sentences were shown to an owner for whom neither was true");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-account-summary-truth — N-BUG (the setup panel must describe THIS workspace)\n");
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
  console.log(`account-summary-truth: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
