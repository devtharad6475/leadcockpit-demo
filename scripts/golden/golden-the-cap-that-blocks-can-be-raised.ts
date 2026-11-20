/**
 * Golden test — the spend cap that blocks every AI call can be raised by the
 * owner it blocks.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo, mid-simulation, when all AI work stopped.
 * `/api/ai/provider-health` returned:
 *
 *   status:   "blocked"
 *   headline: "Your own AI usage cap has been reached, so no model calls are
 *              being made."
 *   action:   "Raise the token cap in AI Settings, or wait for the daily reset."
 *   reason:   "budget_exhausted"
 *
 * AI Settings had no such control, and no route accepted a cap. The read side
 * shipped — `AIUsageLimitRepository.getByWorkspace`, four cap fields, four
 * `current*` counters, and a health check that reads all eight — but the write
 * side was never built. So the product blocked every model call, told the owner
 * exactly where to go and undo it, and there was nothing there. The only way out
 * was a direct database write, which an owner cannot do.
 *
 *   CASE A — the blocking message still points at AI Settings. If the wording
 *     ever moves elsewhere, the rest of this golden is aimed at the wrong screen
 *     and should be re-aimed rather than silently passing.
 *
 *   CASE B — a write route exists for the cap, not only a read route.
 *
 *   CASE C — EVERY cap the health check can block on is settable through that
 *     route. This is the property that actually matters: one unsettable cap is
 *     enough to wedge the workspace exactly as it was wedged here, and a fix
 *     that shipped three of the four fields would pass CASE B.
 *
 *   CASE D — AI Settings renders the control the message names, and it writes to
 *     that route. A route with no screen leaves the owner in the same place.
 *
 * Substrate: static read of the route and the screen, plus the health service's
 * own field list. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const HEALTH = "src/services/ProviderHealthService.ts";
const ROUTE = "src/app/api/[[...path]]/route.ts";
const SCREEN = "src/app/sections/AISettingsSection.tsx";

function main() {
  console.log("=== GOLDEN: the cap that blocks every AI call can be raised ===\n");

  const health = readSource(HEALTH);
  const route = readSource(ROUTE);
  const screen = readSource(SCREEN);

  // ---------------------------------------------------------------- CASE A
  {
    const blocked = health.match(/action:\s*"Raise the (?:token|spend) cap in AI Settings[^"]*"/g) || [];
    assert(
      blocked.length >= 2,
      `CASE A: expected the token-cap and spend-cap blocks to both send the owner to AI Settings, found ${blocked.length} in ${HEALTH}`,
    );
    console.log(`✅ CASE A — the blocking message sends the owner to AI Settings (${blocked.length} places)`);
  }

  // ---------------------------------------------------------------- CASE B
  {
    assert(
      /if \(match\(path, \["ai", "usage-limits"\]\)\)/.test(route),
      `CASE B: ${ROUTE} has no /api/ai/usage-limits branch`,
    );
    assert(
      /upsertForWorkspace\(workspaceId/.test(route),
      `CASE B: ${ROUTE} never writes the cap — a read-only route leaves the owner blocked`,
    );
    console.log("✅ CASE B — the cap has a write route, not only a read route");
  }

  // ---------------------------------------------------------------- CASE C
  {
    // Every cap the health check compares usage against. Taken from the service
    // itself so a fifth cap added later is covered without touching this golden.
    const capsThatBlock = Array.from(
      new Set((health.match(/usage\.(daily|monthly)(Token|Cost)Limit/g) || []).map((hit) => hit.replace("usage.", ""))),
    );
    assert(
      capsThatBlock.length === 4,
      `CASE C setup: expected 4 blocking caps in ${HEALTH}, found ${capsThatBlock.length} (${capsThatBlock.join(", ")})`,
    );
    const unsettable = capsThatBlock.filter((field) => !new RegExp(`${field}:\\s*z\\.number\\(`).test(route));
    assert(
      unsettable.length === 0,
      `CASE C: ${unsettable.join(", ")} can block every AI call but cannot be raised through ${ROUTE}`,
    );
    console.log(`✅ CASE C — all ${capsThatBlock.length} blocking caps are settable: ${capsThatBlock.join(", ")}`);
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /\/api\/ai\/usage-limits/.test(screen),
      `CASE D: ${SCREEN} never talks to /api/ai/usage-limits — the message names a screen with no control on it`,
    );
    assert(
      /method:\s*"PUT"/.test(screen.slice(screen.indexOf("/api/ai/usage-limits"))),
      `CASE D: ${SCREEN} reads the cap but never saves one`,
    );
    for (const field of ["dailyTokenLimit", "monthlyTokenLimit", "dailyCostLimit", "monthlyCostLimit"]) {
      assert(screen.includes(field), `CASE D: ${SCREEN} has no field for ${field}`);
    }
    console.log("✅ CASE D — AI Settings shows all four caps and saves them");
  }

  // ---------------------------------------------------------------- CASE E
  {
    // Emptying the box is the fastest way out of a block, and it is the case
    // that silently fails: both substrates read `undefined` as "leave this
    // column alone" — the JSON repository's assignUpdate skips it, Prisma's
    // update ignores it — so a cleared cap sent as undefined reports success
    // and leaves the workspace blocked by the cap it just removed.
    // Anchor on capSchema: the path appears in both the read and the write
    // branch, and the read branch comes first.
    const branch = route.slice(route.indexOf("const capSchema"));
    const patchLine = branch.slice(0, branch.indexOf("upsertForWorkspace"));
    assert(
      !/value === null \? undefined/.test(patchLine),
      `CASE E: ${ROUTE} sends a cleared cap as undefined, which both repositories ignore — the cap would keep blocking`,
    );
    assert(
      /value === null \? 0/.test(patchLine),
      `CASE E: ${ROUTE} must send a cleared cap as 0, the value the health check reads as "no cap"`,
    );
    assert(
      /value > 0 \? String\(value\)/.test(screen),
      `CASE E: ${SCREEN} must show a stored 0 as an empty box, or "no cap" reads back as a cap of nothing`,
    );
    console.log("✅ CASE E — clearing a cap actually clears it, and reads back empty");
  }

  console.log("\n=== GOLDEN PASSED (A-E) ===");
}

main();
