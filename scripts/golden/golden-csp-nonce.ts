/**
 * GOLDEN — the app must actually BOOT in a production build (P0-CSP).
 *
 * Found 2026-08-24, by the first browser run ever made against `next start`
 * instead of `next dev`.
 *
 * src/middleware.ts mints a fresh CSP nonce per request and names it in the
 * `script-src` of the response header. Next only stamps that nonce onto the
 * inline bootstrap scripts it emits when it renders a page PER REQUEST. Every
 * route was statically prerendered, so the HTML shipped with no nonce at all
 * while the header still demanded one. The browser then blocked all six inline
 * scripts, React never hydrated, and the whole product was a dead shell: it
 * painted, nothing was clickable, and it made ZERO API calls.
 *
 * Measured on the served HTML before the fix:
 *     inline <script> tags: 6      nonce= attributes: 0
 * and after:
 *     inline <script> tags: 5      nonce= attributes: 19, all matching the header
 *
 * `next dev` renders every request dynamically, so dev was always fine. This
 * only ever appears in a production build — which is exactly what the Docker
 * image ships. The bug was invisible for as long as nobody ran the built thing.
 *
 * WHAT THIS GOLDEN CAN AND CANNOT DO. It scans source, so it holds the three
 * structural conditions the fix depends on. It does NOT re-measure the served
 * HTML — that needs a real build plus a running server, and it lives in
 * scripts/probes/tenant-production-browser.ts, whose count guard fails the run
 * if the shell makes fewer than 8 API calls (i.e. if hydration is dead again).
 * Run that probe before shipping a build; this golden is the cheap tripwire
 * that catches the specific edit that would reintroduce it.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

const APP_DIR = path.join(process.cwd(), "src", "app");
const LAYOUT = path.join(APP_DIR, "layout.tsx");
const MIDDLEWARE = path.join(process.cwd(), "src", "middleware.ts");

/** S11-1 / S14-1 lesson: scan CODE, not the comments that describe it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const read = (p: string) => stripComments(fs.readFileSync(p, "utf8"));

/** Every page.tsx / layout.tsx under src/app, recursively. */
function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, found);
    else if (/^(page|layout)\.tsx$/.test(entry.name)) found.push(full);
  }
  return found;
}

test("CASE A — the root layout forces per-request rendering, which is what makes the nonce real", () => {
  const src = read(LAYOUT);

  assert.match(
    src,
    /import\s*\{[^}]*\bheaders\b[^}]*\}\s*from\s*["']next\/headers["']/,
    "src/app/layout.tsx no longer imports headers() from next/headers. That import is not decoration: reading a " +
      "request header is what opts every route under this layout out of static prerendering, and static " +
      "prerendering is what shipped HTML with no CSP nonce and left the app unable to hydrate.",
  );

  assert.match(
    src,
    /await\s+headers\s*\(\s*\)/,
    "src/app/layout.tsx imports headers() but never awaits a call to it. An unused import does not opt the route " +
      "into dynamic rendering — the CALL is what does. Without it every page is prerendered at build time with " +
      "no nonce, the CSP blocks all inline scripts, and the production build boots into a dead shell.",
  );
});

test("CASE B — middleware mints one nonce and uses the SAME one in both places", () => {
  const src = read(MIDDLEWARE);

  assert.match(
    src,
    /requestHeaders\.set\(\s*["']x-nonce["']/,
    "middleware no longer forwards the nonce on the x-nonce REQUEST header. Next reads that header to decide what " +
      "to stamp on its inline scripts; without it the scripts go out unstamped.",
  );

  assert.match(
    src,
    /script-src[^\n]*nonce-\$\{nonce\}/,
    "middleware no longer names the nonce in script-src. A CSP without the nonce blocks the very scripts the " +
      "nonce exists to allow.",
  );

  // One source of truth for the value. Two independently generated nonces
  // would never match, and the failure looks exactly like the P0: everything
  // stamped, everything still blocked.
  const mints = src.match(/const\s+nonce\s*=/g) ?? [];
  assert.equal(
    mints.length,
    1,
    `middleware assigns \`nonce\` ${mints.length} times; expected exactly 1. The request header and the CSP must ` +
      "carry the same value — if they are minted separately they can never match, and every inline script is " +
      "blocked while the code looks correct.",
  );
});

test("CASE C — script-src never falls back to 'unsafe-inline'", () => {
  const src = read(MIDDLEWARE);

  // The tempting "fix" when scripts are blocked is to allow inline scripts.
  // It does make the symptom disappear, and it throws away the entire reason
  // the CSP is there: any injected <script> then executes too.
  const scriptSrcLines = src
    .split("\n")
    .filter((line) => line.includes("script-src"));
  assert.ok(scriptSrcLines.length > 0, "middleware no longer sets script-src at all.");

  for (const line of scriptSrcLines) {
    assert.doesNotMatch(
      line,
      /unsafe-inline/,
      "script-src now allows 'unsafe-inline'. That silences the blocked-script errors by permitting EVERY inline " +
        `script, including an injected one — it is the opposite of the fix. Offending line: ${line.trim()}`,
    );
  }
});

test("CASE D — no route quietly opts back into static rendering", () => {
  // Property, not shape: sweep every route file rather than naming the seven
  // that exist today. A page added later is covered without anyone
  // remembering this golden exists.
  const files = routeFiles(APP_DIR);
  assert.ok(
    files.length >= 5,
    `only ${files.length} route files found under src/app — expected at least 5. Too few means this sweep has ` +
      "lost its subject and is passing vacuously.",
  );

  const offenders: string[] = [];
  for (const file of files) {
    const src = read(file);
    if (/export\s+const\s+dynamic\s*=\s*["']force-static["']/.test(src)) offenders.push(`${file} (force-static)`);
    if (/export\s+const\s+revalidate\s*=/.test(src)) offenders.push(`${file} (revalidate)`);
  }

  assert.deepEqual(
    offenders,
    [],
    "these route files opt back into static/cached rendering, which strips the per-request CSP nonce and " +
      `returns the app to the dead-shell state:\n  ${offenders.join("\n  ")}`,
  );
});

after(() => {
  console.log(
    "\n  NOTE: this golden proves the three structural conditions the nonce depends on. It does NOT re-measure the\n" +
      "  served HTML. The runtime proof is scripts/probes/tenant-production-browser.ts, run against a real\n" +
      "  `next build` + `next start` — its count guard fails if the shell makes fewer than 8 API calls, which is\n" +
      "  what a hydration failure looks like from the outside.\n",
  );
});
