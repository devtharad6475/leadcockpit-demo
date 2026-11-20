/**
 * golden-user-errors-are-not-500.ts — a message for the person is not a
 * server fault (2026-09-26 break test).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The API's error handler guesses a 4xx from words in the message ("not
 * found", "cannot"…). Anything else became HTTP 500 with "Something went wrong
 * on our side. Nothing you did caused it." — and an operator alert. The break
 * test found "Fill in your business profile first", "Approve a campaign
 * first", "Attach a file", "No model slots were sent…" and ~25 more all
 * reaching the owner that way: untrue, and hiding the one thing to do next.
 *
 * Those now throw NeedsActionError (src/lib/user-errors.ts), which the handler
 * shows as written with a 4xx. This golden fails when a plain Error whose
 * message is plainly addressed to the person is thrown in src/services or
 * src/lib again, and checks the handler maps NeedsActionError correctly.
 *
 * Run: npx tsx scripts/golden/golden-user-errors-are-not-500.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NeedsActionError } from "@/lib/user-errors";

// Wording that only makes sense as an instruction to the person.
const ADDRESSED_TO_PERSON = /\b(is required|are required|are both required|must be at least|select at least|add a |answer the question|is empty|already running|already converted|does not match|no model slots were sent|attach a file|fill in your|already been converted|requires permission|already cancelled|approve this lead|exceeds cancellable|references unknown line|canceled by the user)\b/i;

// Checks a developer wiring the code wrongly would hit, never a person using
// the product (the encryption key helpers): these ARE server faults.
const INTERNAL = /^["`](deriveWorkspaceKey:|Failed to decrypt workspace-scoped secret)/;

const files: string[] = [];
const walk = (dir: string) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (!/generated/.test(full)) walk(full); }
    else if (/\.tsx?$/.test(name)) files.push(full);
  }
};
walk("src/services");
walk("src/lib");

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ✅ ${name}`); } catch (error) { failed++; console.error(`  ❌ ${name}\n     ${(error as Error).message.split("\n").join("\n     ")}`); }
};

console.log("golden-user-errors-are-not-500 — a message for the person is not a server fault\n");

check("CASE A — no plain Error carries a message addressed to the person", () => {
  const offenders: string[] = [];
  for (const file of files) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const thrown = /throw new Error\((`[^`]*`|"[^"]*"|'[^']*')/.exec(line);
      if (thrown && ADDRESSED_TO_PERSON.test(thrown[1]) && !INTERNAL.test(thrown[1])) offenders.push(`${file}:${index + 1} ${thrown[1].slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], "these reach the owner as 'something went wrong on our side' — throw NeedsActionError instead");
});

check("CASE B — the API handler shows NeedsActionError as written, with its 4xx", () => {
  const route = fs.readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
  const handler = route.slice(route.indexOf("function errorToResponse("));
  const firstBranch = handler.slice(0, handler.indexOf("MalformedBodyError"));
  assert.ok(/error instanceof NeedsActionError/.test(firstBranch), "errorToResponse must check NeedsActionError before its guessing");
  assert.ok(/error\.statusCode/.test(firstBranch), "the status must come from the error, not a guess");
  const must = route.slice(route.indexOf("function must<T>("), route.indexOf("function must<T>(") + 300);
  assert.ok(/NeedsActionError/.test(must), "must() — 'fill in your profile first' and friends — must throw NeedsActionError");
});

check("CASE C — NeedsActionError keeps its message and its status", () => {
  const error = new NeedsActionError("Approve a campaign first.");
  assert.equal(error.statusCode, 409);
  assert.equal(error.message, "Approve a campaign first.");
  assert.ok(error instanceof Error, "callers that catch Error still catch it");
  assert.equal(new NeedsActionError("x", 400).statusCode, 400);
});

console.log(`\nuser-errors-are-not-500: ${3 - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
if (failed) process.exit(1);
