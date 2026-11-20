/**
 * GOLDEN — the browser must know WHICH CUSTOMER it is, and must not operate
 * until it does (P0-TENANT).
 *
 * THE BUG, AND WHY SOURCE-SCANNING IS THE RIGHT INSTRUMENT HERE
 * ------------------------------------------------------------
 * `src/app/page.tsx` used to open with:
 *
 *     export const workspaceId = "workspace_demo";
 *
 * and ~90 call sites across the screens send that value in the body of a write.
 * July's Cluster B fix, correctly, made the server reject with 403 any write
 * whose body names a workspace different from the session's. Run together
 * against the real resolver with a real customer's session:
 *
 *   body "workspace_demo" + session ws_acme_pipes -> 403 FORBIDDEN
 *   body "ws_acme_pipes"  + session ws_acme_pipes -> ok
 *
 * So under AUTH_MODE=production — what shipping to a client means — every save,
 * approve, send, edit and delete from the screens was refused. A month of
 * testing missed it because `.env` says AUTH_MODE="demo", and demo mode bypasses
 * the check, which makes the hardcoded value right by accident.
 *
 * This golden opens no browser and mounts no React. `page.tsx` is a client
 * component 4,700 lines long; importing it into node would drag in the whole
 * UI tree and prove nothing about ordering anyway. What actually broke here was
 * ORDER and OWNERSHIP — who is allowed to set the workspace, and what is allowed
 * to run before it is set. Those are structural properties, and structure is
 * exactly what source-scanning can hold. The behaviour of the server half is
 * already pinned by golden-workspace-scoping.
 *
 * CASE A  no screen hardcodes a tenant id as its operating workspace
 * CASE B  one writer, and only one, may set it
 * CASE C  boot adopts the workspace BEFORE it loads or renders anything
 * CASE D  the interactive login path adopts it too (the second door)
 * CASE E  a production session with no workspace is REFUSED, not defaulted
 * CASE F  nothing operable renders until the workspace is known
 * CASE G  signing out drops the identity
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import ts from "typescript";

const SHELL = path.join(process.cwd(), "src", "app", "page.tsx");
const SECTIONS_DIR = path.join(process.cwd(), "src", "app", "sections");

/** S11-1 / S14-1 lesson: scan CODE, not the comments that describe it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const shell = () => stripComments(fs.readFileSync(SHELL, "utf8"));

/** Index of the first match, or -1. Used for the ordering assertions. */
function at(src: string, re: RegExp): number {
  const m = re.exec(src);
  return m ? m.index : -1;
}

test("CASE A — no screen hardcodes a tenant id as the workspace it operates on", () => {
  const src = shell();

  assert.doesNotMatch(
    src,
    /export\s+const\s+workspaceId\s*=/,
    'src/app/page.tsx exports `workspaceId` as a const again. That is the P0 itself: a fixed value here is sent by ' +
      "~90 write call sites and 403s for every real customer, while demo mode hides it completely.",
  );

  // The demo id may exist as a NAMED DEFAULT, but never as the live value.
  //
  // The optional type annotation in this pattern is not decoration. The first
  // draft of this golden said `\bworkspaceId\s*=` and a mutation walked straight
  // through it: `export let workspaceId: string = "workspace_demo"` puts `: string`
  // between the name and the `=`, so the regex never matched and the golden
  // passed while the P0 was back in the file. Six of seven mutations were caught;
  // that one was not, which is the entire reason mutations are run at all.
  const assignments = src.match(/\bworkspaceId\s*(?::[^=;\n]+)?=\s*"[^"]+"/g) ?? [];
  assert.deepEqual(
    assignments,
    [],
    `the shell assigns a string literal straight to workspaceId (${assignments.join(", ")}). The only permitted ` +
      "writer is adoptWorkspaceId, which takes the value from the session.",
  );

  // And no SECTION may reintroduce one behind the shell's back.
  const offenders: string[] = [];
  for (const file of fs.readdirSync(SECTIONS_DIR).filter((f) => f.endsWith(".tsx"))) {
    const body = stripComments(fs.readFileSync(path.join(SECTIONS_DIR, file), "utf8"));
    if (/\bworkspaceId\s*=\s*"workspace_/.test(body)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these screens hardcode a workspace id of their own: ${offenders.join(", ")}. One screen quietly writing into ` +
      "another tenant is worse than the original bug, because the rest of the app looks correct.",
  );
});

test("CASE B — exactly one writer owns the workspace identity", () => {
  const src = shell();
  assert.match(
    src,
    /export\s+function\s+adoptWorkspaceId\s*\(/,
    "adoptWorkspaceId is gone. Without a single named writer there is no one place to audit, and the next person " +
      "to need the workspace will set it wherever is convenient.",
  );
  // Count assignments to the binding. Only the ones inside adoptWorkspaceId count.
  const writes = src.match(/^\s*workspaceId\s*=/gm) ?? [];
  assert.ok(
    writes.length > 0 && writes.length <= 2,
    `found ${writes.length} assignments to workspaceId. Expected them all inside adoptWorkspaceId (the session ` +
      "value, and the demo fallback). More than that means a second writer has appeared.",
  );
});

test("CASE C — boot adopts the workspace BEFORE it loads or renders anything", () => {
  const src = shell();
  const adopt = at(src, /adoptWorkspaceId\(status\.user\?\.workspaceId/);
  assert.notEqual(adopt, -1, "the boot effect no longer adopts the session's workspace. That is the original bug.");

  const load = at(src, /await loadAll\(freshTour\)/);
  assert.notEqual(load, -1, "the boot effect no longer calls loadAll — this assertion has lost its subject.");
  assert.ok(
    adopt < load,
    "boot calls loadAll BEFORE adopting the workspace. Ordering is the whole defect: loadAll issues reads " +
      "immediately and the sections mount straight after, so both would run against the wrong tenant.",
  );
});

test("CASE D — the interactive login path adopts the workspace too", () => {
  const src = shell();
  assert.match(
    src,
    /async function syncSessionWorkspace\s*\(/,
    "syncSessionWorkspace is gone. /api/auth/login returns only email and name, so without a follow-up status " +
      "call a freshly logged-in production user keeps whatever workspace the module started with.",
  );

  // Both doors, and in both the adopt must precede loadAll.
  for (const fn of ["realLogin", "realBootstrap"]) {
    const start = at(src, new RegExp(`async function ${fn}\\s*\\(`));
    assert.notEqual(start, -1, `${fn} is gone — this assertion has lost its subject.`);
    const body = src.slice(start, start + 1400);
    const adopt = at(body, /syncSessionWorkspace\(\)/);
    const load = at(body, /loadAll\(\)/);
    assert.notEqual(adopt, -1, `${fn} no longer adopts the session workspace, so every write it enables is 403'd.`);
    assert.ok(
      load === -1 || adopt < load,
      `${fn} loads data before it knows which customer it is.`,
    );
  }
});

test("CASE E — a production session with no workspace is REFUSED, never defaulted", () => {
  const src = shell();
  assert.match(
    src,
    /if\s*\(\s*!adoptWorkspaceId\(/,
    "nothing checks adoptWorkspaceId's return value any more. It returns false precisely when production produced " +
      "no workspace, and ignoring that puts a real customer's writes back on the demo tenant — the exact " +
      "cross-tenant accident the 403 exists to prevent.",
  );
  assert.match(
    src,
    /authMode !== "production"/,
    "adoptWorkspaceId no longer distinguishes production from demo, so the demo fallback would apply to real " +
      "customers as well.",
  );
});

test("CASE F — nothing operable renders until the workspace is known", () => {
  const src = shell();
  assert.match(
    src,
    /if\s*\(\s*!workspaceReady\s*\)/,
    "the workspaceReady gate is gone. That gate is what makes a module-level mutable workspaceId safe: it " +
      "guarantees none of the ~90 write handlers exist yet while the value is still unconfirmed.",
  );

  const gate = at(src, /if\s*\(\s*!workspaceReady\s*\)/);
  const mainReturn = at(src, /return \(\s*<main/);
  assert.ok(
    gate !== -1 && mainReturn !== -1 && gate < mainReturn,
    "the workspaceReady gate no longer sits above the main shell render, so the sections can mount before the " +
      "workspace is known.",
  );
});

test("CASE G — signing out drops this browser's customer identity", () => {
  const src = shell();
  const start = at(src, /function logout\s*\(/);
  assert.notEqual(start, -1, "logout is gone — this assertion has lost its subject.");
  // Check the actual function rather than an arbitrary character window: adding
  // cache clearing must not make a valid tenant reset disappear from this check.
  const parsed = ts.createSourceFile("page.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = "";
  const findLogout = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "logout") body = node.getText(parsed);
    ts.forEachChild(node, findLogout);
  };
  findLogout(parsed);
  assert.ok(body, "logout function could not be parsed");
  assert.match(
    body,
    /adoptWorkspaceId\(undefined,\s*"demo"\)/,
    "logout no longer resets the workspace. The binding is module-level and survives the component, so the next " +
      "person to sign in on this machine would inherit the previous user's tenant.",
  );
  assert.match(
    body,
    /setWorkspaceReady\(false\)/,
    "logout no longer closes the render gate, so the next session would render operable screens before it knew " +
      "which customer it was.",
  );
});

test("CASE H — EVERY door into the app opens the gate; none can hang on it", () => {
  const src = shell();

  // Property, not shape: sweep every place the shell decides someone is logged
  // in, rather than naming the three I happen to know about. A fourth door added
  // later is caught by this without anyone remembering to update the golden.
  //
  // This case exists because of a real hang. demoLogin set loggedIn without
  // touching the gate. On a normal boot that is harmless — the boot effect has
  // already opened it — but the boot effect FAILS CLOSED if /api/auth/status
  // errors, and that path never opens the gate while the login screen still
  // shows "Continue in Demo Mode" (it only hides that button in production).
  // Click it and the operator sits on "Opening your workspace…" with no way out.
  const OPENERS = /setWorkspaceReady\(true\)|syncSessionWorkspace\(\)|adoptWorkspaceId\(/;
  const LOOKBACK = 2000;

  const doors: number[] = [];
  const re = /setLoggedIn\(true\)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) doors.push(m.index);

  assert.ok(
    doors.length >= 4,
    `only ${doors.length} places set loggedIn — expected at least 4 (boot authenticated, boot demo-flag, demo ` +
      "login, real login, bootstrap). Too few means this sweep has lost its subject and is passing vacuously.",
  );

  const hangs = doors.filter((i) => !OPENERS.test(src.slice(Math.max(0, i - LOOKBACK), i)));
  assert.deepEqual(
    hangs,
    [],
    `${hangs.length} of ${doors.length} login paths set loggedIn without opening the workspace gate first ` +
      `(at character offsets ${hangs.join(", ")}). Each one strands the operator on the "Opening your ` +
      'workspace…" spinner permanently, because nothing after that point ever sets it.',
  );
});

after(() => {
  console.log(
    "\n    NOTE — this golden proves STRUCTURE, not a live request. It cannot tell you a real customer's write\n" +
      "    succeeds; only a run with AUTH_MODE=production can, and that is Stage 1's remaining work. What it holds\n" +
      "    is the ordering and ownership that broke: one writer, adopted before anything loads, on both login\n" +
      "    doors, refused rather than defaulted when absent, gated before render, and dropped on sign-out.",
  );
});
