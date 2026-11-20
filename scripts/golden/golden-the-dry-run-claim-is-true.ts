/**
 * Golden test — the demo's safety panel does not promise "no message can leave
 * this machine" while a real WhatsApp number is attached.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found live, minutes after connecting a Meta test number to the demo through
 * the product's own Integrations screen. "Test connection" answered:
 *
 *   ✓ Connected. WhatsApp number +1 555-641-2188 (Test Number) is reachable.
 *
 * and /api/health, which feeds the pre-login "Demo safety boundaries" panel,
 * still said:
 *
 *   "WhatsApp": "Dry-run only — no message can leave this machine"
 *
 * `whatsappLive` was computed from two environment variables,
 * WHATSAPP_CLOUD_ACCESS_TOKEN and WHATSAPP_CLOUD_PHONE_NUMBER_ID. Those are
 * one of the TWO ways a number gets attached. The other is the Integrations
 * screen - "Paste your WhatsApp Business access token + phone number ID here"
 * - which stores them per workspace and sends through them. The panel never
 * looked there, so an operator who followed the product's own instructions got
 * a safety panel that was confidently wrong.
 *
 * N-OBS-2 fixed this same class in the other direction and left a note above
 * the code: "the day WhatsApp credentials are supplied the panel keeps
 * promising it while messages go to customers. A safety panel that cannot be
 * wrong is not a safety panel." The env-var path was fixed; the UI path
 * shipped later and was never added.
 *
 *   CASE A — the workspace credential store is consulted, not only the
 *     environment.
 *
 *   CASE B — a lookup that fails or hangs does not render as safe. "Unknown"
 *     and "no message can leave this machine" are not the same sentence, and
 *     the model-slot count directly above already sets this precedent.
 *
 *   CASE C — the check is bounded. This runs on an unauthenticated health
 *     endpoint; an unbounded credential lookup there is a way to hang the
 *     page that renders the boundaries.
 *
 *   CASE D — the reassuring string is reachable ONLY when nothing is attached
 *     by either route. This is the assertion that would have caught the live
 *     defect: it is not enough to add a lookup, the promise has to depend on
 *     it.
 *
 * Substrate: static read of the health route. No repository, no network.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ROUTE = "src/app/api/[[...path]]/route.ts";
const CLAIM = "Dry-run only — no message can leave this machine";

function main() {
  console.log("=== GOLDEN: the demo does not promise dry-run while a real number is attached ===\n");

  const route = readSource(ROUTE);
  const start = route.indexOf("const searchLive = Boolean(");
  assert(start > 0, `setup: could not locate the demo boundaries block in ${ROUTE}`);
  const block = route.slice(Math.max(0, start - 2500), start + 2500);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /WhatsAppCredentialService/.test(block),
      `CASE A: the boundaries block never consults the workspace credential store, so credentials saved through Integrations are invisible to it`,
    );
    assert(
      /view\.hasCredentials/.test(block),
      `CASE A: the block must read whether workspace credentials are actually stored`,
    );
    console.log("✅ CASE A — credentials saved through the UI are consulted, not just env vars");
  }

  // ---------------------------------------------------------------- CASE B
  {
    assert(
      /whatsappChecked/.test(block),
      `CASE B: nothing distinguishes "checked and clear" from "could not check"`,
    );
    assert(
      /!whatsappChecked\s*\n?\s*\?\s*"Could not be checked/.test(block),
      `CASE B: a failed lookup must say so rather than fall through to the reassuring string`,
    );
    console.log("✅ CASE B — a failed check reports unknown, never 'safe'");
  }

  // ---------------------------------------------------------------- CASE C
  {
    assert(
      /setTimeout\(\(\) => reject\(new Error\("timeout"\)\), \d+\)/.test(block),
      `CASE C: the credential lookup on this unauthenticated endpoint is unbounded`,
    );
    console.log("✅ CASE C — the lookup is time-bounded on a public endpoint");
  }

  // ---------------------------------------------------------------- CASE D
  {
    const claimAt = block.indexOf(CLAIM);
    assert(claimAt > 0, `CASE D setup: the dry-run claim is no longer in ${ROUTE} — re-aim this golden`);
    // The promise must sit on the false branch of BOTH gates: it is reachable
    // only when the check succeeded and nothing was found by either route.
    const guard = block.slice(Math.max(0, claimAt - 400), claimAt);
    assert(
      /whatsappLive/.test(guard) && /whatsappChecked/.test(guard),
      `CASE D: "${CLAIM}" is not guarded by both the liveness check and the checked flag — adding a lookup means nothing unless the promise depends on it`,
    );
    console.log("✅ CASE D — the reassuring line is reachable only when nothing is attached by either route");
  }

  console.log("\n=== GOLDEN PASSED (A-D) ===");
}

main();
