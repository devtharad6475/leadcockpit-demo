/**
 * golden-quote-revise-api.ts — pins F-DATA-5 (2026-08-17, CEO decision D5).
 *
 * WHAT WAS WRONG
 *   `supersedeQuote` (OrderService.ts:240) shipped 2026-07-21 with a passing
 *   golden (golden:quote-order CASE C) and ZERO production call sites. So the
 *   docs/LOGIC.md rule "a new quote supersedes the old one" was written, typed,
 *   tested — and never executed by the product. Meanwhile the generic status
 *   route let ANY caller set status="superseded" by hand, which retires a quote
 *   with no replacement and no `supersedesQuoteId` link: exactly the price
 *   history the status exists to record is the thing that got lost.
 *
 * THE DECISION IT PINS (docs/CEO-LOOP-STATUS.md, D5)
 *   Supersession is an EXPLICIT revise action, never automatic on new-quote
 *   creation (one lead may legitimately hold several live quotes for different
 *   products), and never available on a committed quote.
 *
 * HAND-WRITTEN CONTRACT (anti-cheat — each case names the exact regression it
 * would catch):
 *
 *   CASE A — actual POST /quotes/:id/revise saves a linked replacement.
 *     Catches: the wiring being reverted, leaving supersedeQuote dead again.
 *
 *   CASE B — /revise refuses an accepted or converted quote with HTTP 409
 *     and refuses an already-superseded one with409, without saving anything.
 *     Week3 now uses the shared NEEDS_ACTION envelope instead of the former
 *     QUOTE_COMMITTED / QUOTE_ALREADY_SUPERSEDED codes; state-conflict status
 *     and explanatory business messages remain part of the contract.
 *     Catches: a revision rewriting a price the customer already agreed to, and
 *     a double-click producing two replacements for one original.
 *
 *   CASE C — failed input preserves the original and document numbering;
 *     concurrent requests create exactly one replacement. Week3 upgraded
 *     separate ordered writes to one atomic repository save, so the stronger
 *     saved-outcome contract replaces the obsolete source-code write order.
 *
 *   CASE D — /revise links the replacement back via supersedesQuoteId and calls
 *     the shared atomic boundary. A failed builder leaves no mutated original
 *     or spare successor. The pure supersedeQuote contract remains inCASE G.
 *
 *   CASE E — POST /quotes/:id/status REFUSES toStatus="superseded" and points
 *     the caller at /revise — the same guard F-DATA-2 already applies to
 *     "converted".
 *     Catches: the API bypass that makes the whole rule optional.
 *
 *   CASE F — the Commercial UI no longer offers "superseded" in its manual
 *     "Mark as" dropdown, and does offer a Revise action.
 *     Catches: a UI that hands the owner a button the server now rejects.
 *
 *     REWRITTEN 2026-08-24 (S15-2). This case used to search Commercial.tsx for
 *     the literal array `["draft", "sent", "accepted", "rejected", "expired"]`
 *     and assert "superseded" was not inside it. N-DATA-12 then replaced that
 *     hardcoded array with `nextQuoteStatuses(status)` — the SAME map the
 *     server validates against — which is strictly better and made the golden
 *     go red on an improvement. The old assertion was pinning a code shape;
 *     what it was supposed to protect is a PROPERTY, so the property is now
 *     what gets checked: no quote status anywhere in the lifecycle may offer
 *     "superseded" (or "converted") as a manual destination, swept over every
 *     QuoteStatus rather than one hand-typed list, plus the UI must build its
 *     dropdown from that shared map instead of any literal of its own.
 *
 *   CASE G — behavioural, on the pure helper: supersedeQuote(old, new) retires
 *     the old quote and stamps the link on the new one WITHOUT mutating either
 *     input object (the route persists `updated.status` and the repo-returned
 *     replacement separately, so shared-reference mutation would corrupt the
 *     audit row's oldValues).
 *
 * Run: npm run golden:quote-revise-api
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Quote } from "@/lib/types";
import { createJsonRepos } from "./_helpers/provider";
import { defaultWorkspaceId } from "@/lib/db";

const repos = createJsonRepos();
async function post(pathParts: string[], body: unknown = {}) {
  const { POST } = await import("@/app/api/[[...path]]/route");
  const response = await POST(new Request(`http://localhost/api/${pathParts.join("/")}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as never, { params: Promise.resolve({ path: pathParts }) });
  return { status: response.status, body: await response.json() };
}
async function makeQuote(status: Quote["status"] = "sent") {
  return repos.quote.createWithNextQuoteNumber({
    workspaceId: defaultWorkspaceId, leadId: "", status, currencyCode: "INR", grandTotal: 150,
    lineItems: [{ id: "line", productName: "Measured item", quantity: 1.5, unit: "kg", unitPrice: 100, currencyCode: "INR", lineTotal: 150 }],
  });
}

const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function routeSrc(): string {
  return readFileSync(path.resolve(process.cwd(), "src/app/api/[[...path]]/route.ts"), "utf8");
}
function uiSrc(): string {
  return readFileSync(path.resolve(process.cwd(), "src/app/sections/Commercial.tsx"), "utf8");
}
/** The source text of one route handler: from its `match(...)` line to the next one. */
function handlerBody(src: string, matchExpr: string): string {
  const idx = src.indexOf(matchExpr);
  assert.ok(idx > 0, `route handler ${matchExpr} must exist in route.ts`);
  const rest = src.slice(idx + matchExpr.length);
  const next = rest.indexOf("\n  if (match(path,");
  return rest.slice(0, next > 0 ? next : 4000);
}

const REVISE_MATCH = 'match(path, ["quotes", ":id", "revise"])';
const STATUS_MATCH = 'match(path, ["quotes", ":id", "status"])';

// ─── CASE A ────────────────────────────────────────────────────────────────
test("CASE A — POST /api/quotes/:id/revise saves a linked replacement", async () => {
  const old = await makeQuote();
  const result = await post(["quotes", old.id, "revise"]);
  assert.equal(result.status, 200);
  const saved = await repos.quote.getById(defaultWorkspaceId, old.id);
  const replacement = await repos.quote.getById(defaultWorkspaceId, result.body.quote.id);
  assert.equal(saved?.status, "superseded");
  assert.equal(replacement?.status, "draft");
  assert.equal(replacement?.supersedesQuoteId, old.id);
  assert.equal(replacement?.grandTotal, 150);
  assert.equal(replacement?.lineItems[0].unitPrice, 100);
  assert.equal(replacement?.quoteNumber, old.quoteNumber + 1);
  const audit = (await repos.auditLog.listByWorkspace(defaultWorkspaceId)).find(event => event.eventType === "quote.superseded" && event.entityId === old.id);
  assert.ok(audit, "The saved revision must have an audit history entry");
  assert.equal((audit.payload.oldValuesJson as { status?: string }).status, "sent", "Audit must retain the true status before revision");
  const draft = await makeQuote("draft");
  assert.equal((await post(["quotes", draft.id, "revise"])).status, 200);
  const draftAudit = (await repos.auditLog.listByWorkspace(defaultWorkspaceId)).find(event => event.eventType === "quote.superseded" && event.entityId === draft.id);
  assert.equal((draftAudit?.payload.oldValuesJson as { status?: string })?.status, "draft", "Revision audit must distinguish draft from sent originals");
  console.log("  CASE A OK: actual POST saves the replacement and retires its linked original.");
});

// ─── CASE B ────────────────────────────────────────────────────────────────
test("CASE B — revise refuses committed (accepted/converted) and already-superseded quotes with 409", async () => {
  for (const status of ["accepted", "converted", "superseded"] as const) {
    const old = await makeQuote(status);
    const before = (await repos.quote.listByWorkspace(defaultWorkspaceId)).length;
    const result = await post(["quotes", old.id, "revise"]);
    assert.equal(result.status, 409, `${status} must remain a state conflict`);
    assert.equal(result.body.success, false);
    assert.equal(result.body.error.code, "NEEDS_ACTION");
    assert.match(result.body.error.message, status === "superseded" ? /already.*replaced/i : /preserve.*agreed price/i);
    assert.equal((await repos.quote.listByWorkspace(defaultWorkspaceId)).length, before, "A refused revision must leave no spare draft");
    assert.equal((await repos.quote.getById(defaultWorkspaceId, old.id))?.status, status);
  }
  console.log("  CASE B OK: committed or superseded quotes return 409 with useful messages and no write.");
});

// ─── CASE C ────────────────────────────────────────────────────────────────
test("CASE C — failed revision keeps both state and numbering; concurrent saves make one replacement", async () => {
  const old = await makeQuote();
  const before = (await repos.quote.listByWorkspace(defaultWorkspaceId)).length;
  const failed = await post(["quotes", old.id, "revise"], { lineItems: [{ productName: "Measured item", quantity: -1, unitPrice: 100 }] });
  assert.equal(failed.status, 400);
  assert.equal((await repos.quote.listByWorkspace(defaultWorkspaceId)).length, before);
  assert.equal((await repos.quote.getById(defaultWorkspaceId, old.id))?.status, "sent");
  const attempts = await Promise.all(Array.from({ length: 3 }, () => post(["quotes", old.id, "revise"])));
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409, 409]);
  const replacements = (await repos.quote.listByWorkspace(defaultWorkspaceId)).filter(quote => quote.supersedesQuoteId === old.id);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].quoteNumber, old.quoteNumber + 1, "A rejected request must not consume a document number");
  assert.equal((await repos.quote.getById(defaultWorkspaceId, old.id))?.status, "superseded");
  console.log("  CASE C OK: invalid input leaves the original intact; concurrent retries save one uniquely numbered successor.");
});

// ─── CASE D ────────────────────────────────────────────────────────────────
test("CASE D — the replacement links back, and the transition uses the shared atomic boundary", async () => {
  const body = handlerBody(routeSrc(), REVISE_MATCH);
  assert.match(body, /supersedesQuoteId: oldQuote\.id/, "the replacement MUST carry supersedesQuoteId = the original's id (this link IS the price history)");
  assert.match(body, /repos\.quote\.reviseAtomically/, "Revision must use the shared repository transaction, not disconnected writes");
  // No hand-rolled second copy of the transition.
  assert.ok(
    !/status:\s*"superseded"\s*[,}]/.test(body.replace(/newValuesJson[\s\S]*?\},/g, "")),
    'the revise route must NOT inline `status: "superseded"` — the transition belongs to supersedeQuote() so there is exactly one copy of the rule',
  );
  assert.match(body, /quote\.superseded/, "the revision must be audit-logged (action: quote.superseded) — it changes money-relevant state");
  const original = await makeQuote();
  const before = (await repos.quote.listByWorkspace(defaultWorkspaceId)).length;
  await assert.rejects(repos.quote.reviseAtomically(defaultWorkspaceId, original.id, async current => {
    current.notes = "Must not leak after failure";
    throw new Error("Injected revision failure");
  }), /Injected revision failure/);
  const saved = await repos.quote.getById(defaultWorkspaceId, original.id);
  assert.equal(saved?.status, "sent");
  assert.equal(saved?.notes, original.notes);
  assert.equal((await repos.quote.listByWorkspace(defaultWorkspaceId)).length, before);
  console.log("  CASE D OK: supersedesQuoteId link + shared atomic transition + audit row.");
});

// ─── CASE E ────────────────────────────────────────────────────────────────
test("CASE E — the generic status route refuses a hand-set superseded and points at /revise", async () => {
  const body = handlerBody(routeSrc(), STATUS_MATCH);
  assert.match(body, /toStatus === "superseded"/, 'POST /quotes/:id/status MUST reject toStatus="superseded" (F-DATA-5) — otherwise the API bypasses the whole rule and produces a retired quote with no successor');
  const idx = body.indexOf('toStatus === "superseded"');
  const guard = body.slice(idx, idx + 400);
  assert.match(guard, /revise/, "the rejection message must tell the caller to use /revise instead");
  // The sibling F-DATA-2 guard must still be there — this case must not have
  // been "fixed" by replacing one guard with the other.
  assert.match(body, /toStatus === "converted"/, "the F-DATA-2 converted guard must remain");
  console.log("  CASE E OK: status route rejects hand-set superseded, converted guard intact.");
});

// ─── CASE F ────────────────────────────────────────────────────────────────
test("CASE F — no quote status offers superseded as a manual destination, and the UI offers Revise", async () => {
  const { nextQuoteStatuses, QUOTE_TRANSITIONS } = await import("@/lib/status-transitions");

  // The property, swept over the WHOLE lifecycle rather than one hand-typed
  // list. `superseded` is set only by POST /quotes/:id/revise, which also
  // creates and links the replacement; `converted` only by /convert. Offering
  // either in a "Mark as" dropdown hands the owner a button the server rejects,
  // and — worse when it slipped through — a retired quote with no successor.
  const OWNER_MAY_NEVER_SET = ["superseded", "converted"] as const;
  const allStatuses = Object.keys(QUOTE_TRANSITIONS) as Array<keyof typeof QUOTE_TRANSITIONS>;
  assert.strictEqual(
    allStatuses.length, 7,
    `the quote lifecycle has ${allStatuses.length} statuses, this case hand-computed 7 — a NEW status must be swept here before it ships`,
  );
  for (const from of allStatuses) {
    for (const forbidden of OWNER_MAY_NEVER_SET) {
      assert.ok(
        !nextQuoteStatuses(from).includes(forbidden),
        `nextQuoteStatuses("${from}") offers "${forbidden}". The Commercial "Mark as" dropdown is built from this map, so that ` +
        `is a menu item the server answers with 409 — and for "superseded" it would retire a quote with no replacement and no price history`,
      );
    }
  }

  // And the UI must READ that map rather than keep a list of its own. A second
  // copy is how the dropdown and the server drifted apart in the first place.
  const ui = uiSrc();
  assert.match(
    ui, /import\s*\{[^}]*nextQuoteStatuses[^}]*\}\s*from\s*"@\/lib\/status-transitions"/,
    "Commercial.tsx must build the quote \"Mark as\" list from nextQuoteStatuses, the same map the server validates against",
  );
  const markAsIdx = ui.indexOf('aria-label="Update quote status"');
  assert.ok(markAsIdx > 0, 'the quote "Mark as" select must exist and be labelled');
  const selectBlock = ui.slice(Math.max(0, markAsIdx - 1200), markAsIdx + 400);
  const optionLiterals = selectBlock.match(/<option value="(?!")[^"]+"/g) ?? [];
  assert.deepStrictEqual(
    optionLiterals, [],
    `the quote "Mark as" select hardcodes option(s) ${JSON.stringify(optionLiterals)} instead of mapping nextQuoteStatuses — ` +
    "a hardcoded option is exactly how superseded got offered before",
  );

  assert.match(ui, /\/revise/, "the UI must call the revise endpoint");
  assert.match(ui, /reviseQuote/, "the UI must have a reviseQuote action");
  console.log(`  CASE F OK: none of the ${allStatuses.length} quote statuses offers superseded/converted; the UI reads the shared map and has Revise.`);
});

// ─── CASE G ────────────────────────────────────────────────────────────────
test("CASE G — supersedeQuote retires the old quote and links the new one without mutating its inputs", async () => {
  const { supersedeQuote } = await import("@/services/OrderService");
  const oldQuote = {
    id: "quote_old", workspaceId: "ws_t", quoteNumber: 9, leadId: "lead_t", status: "sent",
    lineItems: [], grandTotal: 5000, currencyCode: "INR",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  } as Quote;
  const newQuote = { ...oldQuote, id: "quote_new", quoteNumber: 10, status: "draft" as const, grandTotal: 4500 };

  const { updated, replacement } = supersedeQuote(oldQuote, newQuote);

  assert.strictEqual(updated.status, "superseded", "the original must be retired");
  assert.strictEqual(replacement.supersedesQuoteId, "quote_old", "the replacement must point back at the original");
  assert.strictEqual(replacement.grandTotal, 4500, "the replacement keeps its own total (4500) — the retirement must not copy the old price back over it");
  // Inputs untouched: the route audits oldQuote.status as oldValues AFTER
  // calling the helper. A mutating helper would log "superseded → superseded".
  assert.strictEqual(oldQuote.status, "sent", "supersedeQuote MUST NOT mutate the quote it was given — the route still needs the pre-change status for the audit row");
  assert.strictEqual(newQuote.supersedesQuoteId, undefined, "supersedeQuote MUST NOT mutate the replacement it was given");
  console.log("  CASE G OK: sent → superseded, link stamped, neither input mutated.");
});

// ─── runner ────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}\n     ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (of ${cases.length})`);
  process.exit(failed > 0 ? 1 : 0);
})();
