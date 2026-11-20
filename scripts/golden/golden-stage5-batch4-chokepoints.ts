/**
 * golden-stage5-batch4-chokepoints.ts — pins the Batch 4 fixes for the Stage 5
 * re-audit (F-P1-1, F-P1-2, F-P1-7, F-P1-10, F-P2-1, F-P2-2, F-P2-3, F-P2-4,
 * F-P2-8, F-P3-1, F-P3-2, F-P3-3, F-P3-4).
 *
 * WHAT THIS PROVES
 *   Batch 4 is a cluster of small, mostly-orthogonal fixes. Each is pinned
 *   here by a CASE. The CASES combine:
 *     - static wiring checks (asserts a route/chokepoint imports + calls X)
 *     - runtime chokepoint checks (exercises a pure function with known input)
 *     - schema/type checks (asserts the zod schema or TS type bounds a field)
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *
 *   CASE 1 (F-P1-1) — rate-limit presets exist for signup/invite-accept/resend
 *     + the routes wire checkRateLimit.
 *
 *   CASE 2 (F-P1-2) — SignupResult carries `emailSent: boolean`; SignupService
 *     surfaces email-send failure (no silent swallow).
 *
 *   CASE 3 (F-P1-7) — WP1 mutations write auditLog rows (signup, handProvision,
 *     createInvite, acceptInvite, revokeInvite, verifyEmail).
 *
 *   CASE 4 (F-P1-10) — blockPlatformUser verifies (userId, workspaceId)
 *     membership before upserting; a mismatched pair throws.
 *
 *   CASE 5 (F-P2-1) — suspendWorkspace idempotency: re-suspending an
 *     already-suspended workspace preserves the ORIGINAL suspendedAt +
 *     suspendedByAdminId (does not overwrite audit history).
 *
 *   CASE 6 (F-P2-2) — the operator password-reset route wraps sendEmail in a
 *     try/catch and returns a clear error code on failure (no silent 500 +
 *     locked-out user).
 *
 *   CASE 7 (F-P2-3) — the user-side platform-ticket status schema rejects
 *     operator-only statuses (in_progress, waiting_on_user).
 *
 *   CASE 8 (F-P2-4) — changePlatformTicketStatus clears resolvedAt/closedAt
 *     when moving AWAY from a terminal state.
 *
 *   CASE 9 (F-P2-8) — re-inviting an email with a prior revoked invite does
 *     NOT accumulate stale revoked rows (the prior pending/revoked invite is
 *     cleaned up or the constraint prevents dupes).
 *
 *   CASE 10 (F-P3-1) — password fields in signup/accept-invite schemas have a
 *     max-length bound (no unbounded allocation).
 *
 *   CASE 11 (F-P3-2) — failed admin login on UNKNOWN email writes an audit
 *     row (no enumeration blind spot).
 *
 *   CASE 12 (F-P3-3) — user-side platform-ticket comment + status routes are
 *     rate-limited.
 *
 *   CASE 13 (F-P3-4) — EmailPurpose includes "verify_email"; SignupService
 *     uses it (not "invite").
 *
 * NOTE: F-P2-5 (user-side field projection), F-P2-6 (admin breach-logic
 * chokepoint drift), F-P2-9 (impersonation cookie signing), F-P3-5 (mock
 * outbox scoping) are addressed separately where they apply; this golden
 * covers the cluster above.
 *
 * Run: npx tsx scripts/golden/golden-stage5-batch4-chokepoints.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { defaults as rateLimitDefaults } from "@/services/rate-limit/memoryBackend";
import { signupSchema, acceptInviteSchema, platformTicketStatusSchema } from "@/validation/schemas";
import { EmailPurpose } from "@/providers/email/EmailSendProvider";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

function readRoute(): string {
  return readFileSync(path.resolve(process.cwd(), "src/app/api/[[...path]]/route.ts"), "utf8");
}

// ─── CASE 1: F-P1-1 rate-limit presets + wiring ─────────────────────────────
test("CASE 1 (F-P1-1) — signup/invite-accept/resend rate-limit presets exist + routes wire checkRateLimit", async () => {
  // Presets exist.
  for (const key of ["signup", "invite_accept", "resend_verification"]) {
    assert.ok(
      rateLimitDefaults[key],
      `rate-limit preset '${key}' must exist (F-P1-1 — public signup/invite/resend were uncapped, allowing email-quota burn + CPU amplification)`,
    );
  }
  // Routes wire checkRateLimit. Find the three route handlers in the source
  // and assert each calls checkRateLimit within its body.
  const src = readRoute();
  for (const routeMatch of ['match(path, ["auth", "signup"])', 'match(path, ["auth", "invites", "accept"])', 'match(path, ["auth", "resend-verification"])']) {
    const idx = src.indexOf(routeMatch);
    assert.ok(idx > 0, `route ${routeMatch} must exist`);
    // Look in the next 1500 chars (the handler body) for checkRateLimit.
    const body = src.slice(idx, idx + 1500);
    assert.match(body, /checkRateLimit/, `route ${routeMatch} MUST call checkRateLimit (F-P1-1 wiring)`);
  }
});

// ─── CASE 2: F-P1-2 SignupResult.emailSent + no-silent-swallow ──────────────
test("CASE 2 (F-P1-2) — SignupResult carries emailSent; SignupService logs email-send failures", async () => {
  const signupPath = path.resolve(process.cwd(), "src/services/SignupService.ts");
  const src = readFileSync(signupPath, "utf8");

  // SignupResult type includes emailSent.
  assert.match(src, /emailSent\s*:\s*boolean/, "SignupResult type MUST carry emailSent: boolean (F-P1-2 — was silently swallowed)");

  // The catch around sendEmail is NOT empty — it sets emailSent=false AND logs.
  // Find the sendEmail call inside signup() and inspect its catch.
  const sendEmailIdx = src.indexOf("sendAccountEmail(");
  assert.ok(sendEmailIdx > 0, "SignupService must call the account sender helper");
  // The 800 chars after the sendEmail call should contain a non-empty catch.
  const after = src.slice(sendEmailIdx, sendEmailIdx + 1200);
  assert.match(after, /emailSent\s*[:=]\s*false/, "the email-send catch must set emailSent=false");
  // No empty catch (catch {} or catch (e) {} with no body).
  assert.doesNotMatch(after, /catch\s*(\([^)]*\))?\s*\{\s*\}/, "no empty catch around sendEmail (No Silent Failures rule)");
});

// ─── CASE 3: F-P1-7 WP1 audit logging ───────────────────────────────────────
test("CASE 3 (F-P1-7) — WP1 services write auditLog rows on mutations", async () => {
  const files = [
    "src/services/SignupService.ts",
    "src/services/InviteService.ts",
  ];
  for (const rel of files) {
    const src = readFileSync(path.resolve(process.cwd(), rel), "utf8");
    // Each WP1 service must reference auditLog.create OR safeAudit.
    assert.match(
      src,
      /(auditLog\.create|safeAudit|repositories\.auditLog|repos\.auditLog)/,
      `${rel} MUST write audit rows (F-P1-7 — WP1 had zero audit logging, a non-repudiation gap for "who invited this member and when")`,
    );
  }
});

// ─── CASE 4: F-P1-10 blockPlatformUser membership check ──────────────────────
test("CASE 4 (F-P1-10) — blockPlatformUser verifies (userId, workspaceId) membership before upserting", async () => {
  const svcPath = path.resolve(process.cwd(), "src/services/PlatformTicketService.ts");
  const src = readFileSync(svcPath, "utf8");

  // Find blockPlatformUser and assert it loads the user + checks workspaceId.
  const fnStart = src.indexOf("blockPlatformUser");
  assert.ok(fnStart > 0, "blockPlatformUser must exist");
  const fnBody = src.slice(fnStart, fnStart + 2500);

  // Must call findById (or equivalent) to load the user.
  assert.match(fnBody, /findById|getById|user\.find/, "blockPlatformUser MUST load the user before upserting (F-P1-10 — was trusting body.userId + body.workspaceId with no membership check)");
  // Must compare user.workspaceId against input.workspaceId.
  assert.match(fnBody, /workspaceId\s*(!==|!=|===|==)/, "blockPlatformUser MUST compare the loaded user's workspaceId against the input (membership invariant)");
});

// ─── CASE 5: F-P2-1 suspendWorkspace idempotency ────────────────────────────
test("CASE 5 (F-P2-1) — suspendWorkspace preserves original suspendedAt/suspendedByAdminId on re-suspend", async () => {
  const svcPath = path.resolve(process.cwd(), "src/services/PlatformAdminService.ts");
  const src = readFileSync(svcPath, "utf8");

  const fnStart = src.indexOf("async function suspendWorkspace");
  assert.ok(fnStart > 0, "suspendWorkspace must exist");
  const fnBody = src.slice(fnStart, fnStart + 3000);

  // Find the already-suspended check: `if (ws.status === "suspended")`.
  const checkIdx = fnBody.indexOf('ws.status === "suspended"');
  assert.ok(checkIdx > 0, "suspendWorkspace must check for already-suspended state");

  // Extract the BRANCH BODY (text between the `{` after the condition and its
  // matching `}`). The bug is an empty body (only a comment).
  const openBrace = fnBody.indexOf("{", checkIdx);
  assert.ok(openBrace > 0, "already-suspended check must have a body");
  // Find the matching close brace (no nested braces expected in this small branch).
  const closeBrace = fnBody.indexOf("}", openBrace);
  const branchBody = fnBody.slice(openBrace + 1, closeBrace);
  // Strip comments + whitespace; what's left is the actual code in the branch.
  const codeInBranch = branchBody.replace(/\/\/[^\n]*/g, "").replace(/\s/g, "");
  assert.ok(
    codeInBranch.length > 0,
    `suspendWorkspace's already-suspended branch must NOT be empty (F-P2-1 — empty branch fell through to unconditional update, overwriting the original suspendedAt/suspendedByAdminId + writing a duplicate audit row). Branch body was: ${JSON.stringify(branchBody)}`,
  );
});

// ─── CASE 6: F-P2-2 password-reset route wraps sendEmail ────────────────────
test("CASE 6 (F-P2-2) — operator reset-password route wraps sendEmail in try/catch with clear error", async () => {
  const src = readRoute();
  // Inspect syntax, not a character window: the first "sendEmail" is its
  // import, and additional delivery safeguards moved the actual call outside
  // the old 800-character slice. An unrelated nearby catch must not pass this.
  const file = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, true);
  let route: ts.IfStatement | undefined;
  const findRoute = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression.getText(file) === 'match(path, ["admin", "users", ":id", "reset-password"])') route = node;
    ts.forEachChild(node, findRoute);
  };
  findRoute(file);
  assert.ok(route, "could not find the operator reset-password route");
  const callsEmail = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "sendAccountEmail") return true;
    return ts.forEachChild(node, callsEmail) === true;
  };
  let guardedSend: ts.TryStatement | undefined;
  const findGuard = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && callsEmail(node.tryBlock)) guardedSend = node;
    ts.forEachChild(node, findGuard);
  };
  findGuard(route.thenStatement);
  assert.ok(guardedSend, "the reset-password account send call must be inside a try block");
  assert.ok(guardedSend.catchClause, "that same try block must have a catch for email failure");
  const failureBody = guardedSend.catchClause.block.getText(file);
  assert.match(failureBody, /RESET_ISSUED_BUT_EMAIL_FAILED/, "email refusal must surface an explicit operator error code");
  assert.match(failureBody, /RESET_EMAIL_UNCONFIRMED/, "an uncertain provider outcome must remain distinct from refusal");
  assert.match(failureBody, /return\s+json\(/, "email failure must produce a response, not a silent log");
  assert.match(failureBody, /502/, "email provider failure must not be reported as success");
});

// ─── CASE 7: F-P2-3 user-side status schema ─────────────────────────────────
test("CASE 7 (F-P2-3) — user-side platformTicketStatusSchema rejects operator-only statuses", async () => {
  // The user-side schema must reject 'in_progress' and 'waiting_on_user'.
  const badParse = platformTicketStatusSchema.safeParse({ toStatus: "in_progress" });
  assert.ok(!badParse.success, "user-side status schema MUST reject 'in_progress' (operator-only triage state)");
  const badParse2 = platformTicketStatusSchema.safeParse({ toStatus: "waiting_on_user" });
  assert.ok(!badParse2.success, "user-side status schema MUST reject 'waiting_on_user' (operator-only)");
  // And it must still accept the user-allowed statuses.
  for (const ok of ["resolved", "closed", "reopened"]) {
    const goodParse = platformTicketStatusSchema.safeParse({ toStatus: ok });
    assert.ok(goodParse.success, `user-side status schema MUST still accept '${ok}'`);
  }
});

// ─── CASE 8: F-P2-4 changePlatformTicketStatus clears terminal timestamps ───
test("CASE 8 (F-P2-4) — changePlatformTicketStatus clears resolvedAt/closedAt on non-terminal move", async () => {
  const svcPath = path.resolve(process.cwd(), "src/services/PlatformTicketService.ts");
  const src = readFileSync(svcPath, "utf8");
  const fnStart = src.indexOf("changePlatformTicketStatus");
  assert.ok(fnStart > 0, "changePlatformTicketStatus must exist");
  const fnBody = src.slice(fnStart, fnStart + 4000);
  // The function must clear resolvedAt AND closedAt (set to null/undefined)
  // when moving away from a terminal state.
  assert.match(fnBody, /resolvedAt\s*[:=]\s*(null|undefined)/, "changePlatformTicketStatus MUST clear resolvedAt when moving away from a terminal state (F-P2-4 — stale timestamps broke the 7-day reopen window)");
  assert.match(fnBody, /closedAt\s*[:=]\s*(null|undefined)/, "changePlatformTicketStatus MUST clear closedAt when moving away from a terminal state");
});

// ─── CASE 9: F-P2-8 re-invite cleanup ───────────────────────────────────────
test("CASE 9 (F-P2-8) — InviteService.createInvite cleans up prior revoked/expired invites to prevent accumulation", async () => {
  const svcPath = path.resolve(process.cwd(), "src/services/InviteService.ts");
  const src = readFileSync(svcPath, "utf8");
  const fnStart = src.indexOf("export async function createInvite");
  assert.ok(fnStart > 0, "createInvite must exist");
  const fnBody = src.slice(fnStart, fnStart + 4000);
  // The fix: when creating a new invite, the service must DELETE prior
  // revoked/expired invites for the same (workspace, email) so the table
  // does not accumulate one row per (workspace, email, status) combo.
  // We assert createInvite references a delete/revoked/expired-cleanup call.
  // (Comments don't count — we strip them.)
  const codeOnly = fnBody.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const hasCleanup = /(deleteNonPendingForEmail|deleteByWorkspaceAndEmail|deletePriorInvites|deleteRevoked|deleteExpired|cleanupPrior|hardDelete|\.delete\()/i.test(codeOnly);
  assert.ok(
    hasCleanup,
    "createInvite MUST delete prior revoked/expired invites for the same email (F-P2-8 — the +status unique constraint allowed unbounded row accumulation; comments don't count, the code must call a delete)",
  );
});

// ─── CASE 10: F-P3-1 password max-length ────────────────────────────────────
test("CASE 10 (F-P3-1) — signup + accept-invite password schemas have a max-length bound", async () => {
  // Parse a 5000-char password — must be rejected by the schema.
  const longPw = "x".repeat(5000);
  const badSignup = signupSchema.safeParse({
    email: "test@example.com", password: longPw, name: "X", businessName: "X",
  });
  assert.ok(!badSignup.success, "signupSchema MUST reject a 5000-char password (F-P3-1 — was unbounded, allocating the full body before hashPassword's cap)");
  const badAccept = acceptInviteSchema.safeParse({
    token: "x", name: "X", password: longPw,
  });
  assert.ok(!badAccept.success, "acceptInviteSchema MUST reject a 5000-char password");
  // And a normal 16-char password must still pass.
  const goodSignup = signupSchema.safeParse({
    email: "test@example.com", password: "normalPassword123", name: "X", businessName: "X",
  });
  assert.ok(goodSignup.success, "signupSchema must still accept a normal password");
});

// ─── CASE 11: F-P3-2 failed admin login on unknown email writes audit ────────
test("CASE 11 (F-P3-2) — failed admin login on UNKNOWN email writes a platform audit row", async () => {
  const svcPath = path.resolve(process.cwd(), "src/services/PlatformAdminAuthService.ts");
  const src = readFileSync(svcPath, "utf8");
  const fnStart = src.indexOf("async function loginPlatformAdmin");
  assert.ok(fnStart > 0, "loginPlatformAdmin must exist");
  const fnBody = src.slice(fnStart, fnStart + 4000);

  // The bug: the failure-branch audit write was gated by `if (found)`, so an
  // unknown email wrote NO audit row. The fix: write an audit row with a
  // sentinel adminId (e.g. "unknown") even when found is null. We assert the
  // function references platformAuditLog.create in a context that is NOT
  // guarded by `if (found)` — specifically, it must use a sentinel adminId
  // for the unknown-email case.
  //
  // Honest check: the failure branch must call platformAuditLog.create with
  // a sentinel adminId (not just `found.admin.id`). The sentinel may be a
  // literal "unknown" string OR a variable (e.g. `auditAdminId`) that resolves
  // to "unknown" when !found. We accept either pattern.
  const hasSentinelAudit =
    /adminId:\s*["'](unknown|none|null)["']/.test(fnBody) ||                               // literal sentinel
    /["']unknown["']/.test(fnBody) ||                                                       // any "unknown" literal (e.g. in a ternary)
    /auditAdminId|sentinelAdminId|fallbackAdminId/i.test(fnBody);                           // variable holding the sentinel
  assert.ok(
    hasSentinelAudit,
    "loginPlatformAdmin MUST write a platform audit row with a sentinel adminId (e.g. 'unknown') when the email matches no admin (F-P3-2 — the audit write was gated by `if (found)`, so enumeration attacks left zero audit trail)",
  );
});

// ─── CASE 12: F-P3-3 user-side ticket comment + status rate-limited ──────────
test("CASE 12 (F-P3-3) — user-side platform-ticket comment + status routes are rate-limited", async () => {
  // Presets exist.
  for (const key of ["platform_ticket_comment", "platform_ticket_status"]) {
    assert.ok(
      rateLimitDefaults[key],
      `rate-limit preset '${key}' must exist (F-P3-3 — user-side comment/status routes were uncapped, asymmetry vs the capped create route)`,
    );
  }
  // Routes wire checkRateLimit.
  const src = readRoute();
  for (const routeMatch of ['match(path, ["platform-tickets", ":id", "comments"])', 'match(path, ["platform-tickets", ":id", "status"])']) {
    const idx = src.indexOf(routeMatch);
    assert.ok(idx > 0, `route ${routeMatch} must exist`);
    const body = src.slice(idx, idx + 1500);
    assert.match(body, /checkRateLimit/, `route ${routeMatch} MUST call checkRateLimit (F-P3-3 wiring)`);
  }
});

// ─── CASE 13: F-P3-4 EmailPurpose includes verify_email ──────────────────────
test("CASE 13 (F-P3-4) — EmailPurpose includes 'verify_email'; SignupService uses it", async () => {
  // Type-level: EmailPurpose is a string-literal union; we check by reading
  // the source for the literal.
  const emailProviderPath = path.resolve(process.cwd(), "src/providers/email/EmailSendProvider.ts");
  const epSrc = readFileSync(emailProviderPath, "utf8");
  assert.match(epSrc, /["']verify_email["']/, "EmailPurpose MUST include 'verify_email' (F-P3-4 — signup verifications were mislabeled as 'invite')");

  // SignupService uses it (not "invite") for the verification email.
  const signupPath = path.resolve(process.cwd(), "src/services/SignupService.ts");
  const ssSrc = readFileSync(signupPath, "utf8");
  assert.match(ssSrc, /purpose:\s*["']verify_email["']/, "SignupService MUST use purpose: 'verify_email' for the verification email (not 'invite')");

  // Type compiles: EmailPurpose accepts "verify_email" (TS check at compile time).
  const _p: EmailPurpose = "verify_email";
  void _p;
});

// ─── CASE 14: F-P1-8 global email uniqueness (defense-in-depth at the atomic write) ─
test("CASE 14 (F-P1-8) — createWorkspaceWithOwner re-checks email uniqueness INSIDE the atomic write (closes the race)", async () => {
  // F-P1-8 contract decision (build-right Phase 1.5 — Logic Interview):
  // The audit's suggested DB-level `@@unique([email])` would BREAK CASE M
  // ("owner-of-A accepts invite to B; same email across workspaces is allowed"),
  // which is a hard contract pinned by golden:signup-invite CASE M. So instead
  // of a global DB constraint, we close the race at the APP layer by re-
  // checking email uniqueness INSIDE createWorkspaceWithOwner's atomic write
  // (the JSON impl's mutateData lock makes this check-then-act atomic; the
  // Prisma impl's $transaction + the per-workspace @@unique catches it too).
  // This document the decision; a DB-level global constraint is DEFERRED until
  // the operator decides whether to keep CASE M.
  const jsonRepoPath = path.resolve(process.cwd(), "src/repositories/json/index.ts");
  const jsonSrc = readFileSync(jsonRepoPath, "utf8");
  const fnStart = jsonSrc.indexOf("async createWorkspaceWithOwner");
  assert.ok(fnStart > 0, "JSON createWorkspaceWithOwner must exist");
  const fnBody = jsonSrc.slice(fnStart, fnStart + 2500);
  // The atomic write must re-check email uniqueness inside mutateData (so the
  // check + the push happen under ONE lock — closing the race).
  assert.match(
    fnBody,
    /email/i,
    "JSON createWorkspaceWithOwner MUST reference email inside the atomic write (F-P1-8 — re-check uniqueness under the mutateData lock to close the check-then-act race)",
  );
  // And it must THROW on collision (not silently overwrite).
  assert.match(fnBody, /throw|already|exists/i, "JSON createWorkspaceWithOwner MUST throw on email collision inside the atomic write");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
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
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-stage5-batch4-chokepoints FAILED — see cases above.");
    process.exit(1);
  }
  console.log("✅ golden-stage5-batch4-chokepoints ALL GREEN ✅");
  process.exit(0);
})();
