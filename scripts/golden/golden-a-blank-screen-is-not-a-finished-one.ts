/**
 * Golden test — "we do not know yet" is never rendered as "you are finished".
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo while the container was 502ing under a burst of
 * answer saves. The Questions screen said:
 *
 *   "Every business area is answered · 0 of 0 done
 *    The AI has an answer for every business area it was stuck on."
 *
 * A retry moments later said:
 *
 *   "5 business areas still need your answer · 7 of 12 done"
 *
 * Nothing had been answered in between. The screen had no notion of "not
 * loaded": `groups` starts as `[]`, and the progress line branched on
 * `openGroupCount === 0`, so the empty INITIAL state and a genuinely finished
 * workspace rendered the same sentence. The error EmptyState existed and was
 * correct, but it only covered a load that rejected — it did nothing for the
 * window before the first load returns, which on a slow or failing container is
 * exactly when an operator is looking.
 *
 * This is the same family as the dry-run claim fixed earlier this session: a
 * reassuring sentence reachable when the product does not actually know. The
 * operator's next action follows from it — they stop answering questions, and
 * the AI stays blocked on the ones they were never shown.
 *
 *   CASE A — the screen tracks whether data has ever arrived, separately from
 *     whether a load failed. Two different unknowns, two different states.
 *
 *   CASE B — that flag is set only on the success path, after the state it
 *     describes has landed. Setting it in a `finally`, or before the awaits,
 *     would make it true while the counts are still initial state.
 *
 *   CASE C — nothing renders the progress line until the flag is true. This is
 *     the assertion that would have caught the live defect: adding a flag means
 *     nothing unless the claim depends on it.
 *
 *   CASE D — an empty result and a completed one say different things. Having
 *     nothing to finish is not the same as having finished it.
 *
 *   CASE E — the failure EmptyState still exists and still wins. This fix must
 *     not swallow a real error into a permanent spinner.
 *
 * Substrate: static read of the screen. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const SCREEN = "src/app/sections/QuestionsFromAI.tsx";
const CLAIM = "Every business area is answered.";

function main() {
  console.log("=== GOLDEN: a blank screen is not a finished one ===\n");

  const screen = readSource(SCREEN);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /const \[loaded, setLoaded\] = useState\(false\)/.test(screen),
      `CASE A: ${SCREEN} has no "has anything arrived yet" state, so empty initial state renders as a result`,
    );
    assert(
      /const \[loadError, setLoadError\]/.test(screen),
      `CASE A: ${SCREEN} must still track load failure separately — "failed" and "not yet" are different`,
    );
    console.log("✅ CASE A — not-loaded and failed-to-load are separate states");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const loadFn = screen.slice(screen.indexOf("async function load()"));
    const body = loadFn.slice(0, loadFn.indexOf("\n  }"));
    assert(/setLoaded\(true\)/.test(body), `CASE B: load() never records that it succeeded`);
    // It must come after the state it vouches for.
    assert(
      body.indexOf("setGroups(") < body.indexOf("setLoaded(true)"),
      `CASE B: setLoaded runs before the data is in state — the counts would still be initial values`,
    );
    assert(
      !/finally[\s\S]*setLoaded\(true\)/.test(body),
      `CASE B: setLoaded in a finally would mark a FAILED load as loaded`,
    );
    console.log("✅ CASE B — it is set last, and only when the load actually succeeded");
  }

  // ---------------------------------------------------------------- CASE C
  {
    assert(
      /if \(!loaded && !loadError\)/.test(screen),
      `CASE C: nothing gates rendering on whether data arrived — the claim is still reachable from initial state`,
    );
    // The gate must sit before the claim, or it gates nothing.
    assert(
      screen.indexOf("if (!loaded && !loadError)") < screen.indexOf(CLAIM),
      `CASE C: the not-loaded gate must return before "${CLAIM}" can render`,
    );
    console.log("✅ CASE C — the progress line cannot render before data arrives");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /progressGroups\.length === 0/.test(screen),
      `CASE D: ${SCREEN} does not distinguish "nothing to answer" from "all answered"`,
    );
    assert(
      /No business areas are waiting on you yet\./.test(screen),
      `CASE D: an empty set must say it is empty, not claim completion`,
    );
    // The completion claim must sit on a branch that requires a non-empty set.
    const claimAt = screen.indexOf(CLAIM);
    const guard = screen.slice(Math.max(0, claimAt - 700), claimAt);
    assert(
      /progressGroups\.length === 0/.test(guard),
      `CASE D: "${CLAIM}" is not guarded by the set being non-empty`,
    );
    console.log("✅ CASE D — having nothing to do reads differently from having finished");
  }

  // ---------------------------------------------------------------- CASE E
  {
    assert(
      /if \(loadError\) \{/.test(screen),
      `CASE E: the load-failure branch was removed — a real error would now sit in a spinner forever`,
    );
    assert(
      /title="Couldn't load"/.test(screen),
      `CASE E: the failure state must still tell the operator it failed`,
    );
    console.log("✅ CASE E — a real failure still reports as a failure");
  }

  console.log("\n=== GOLDEN PASSED (A-E) ===");
}

main();
