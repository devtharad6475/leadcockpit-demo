/**
 * isolate-standalone.ts — make a golden safe to run BY HAND (N-DATA-22).
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * Test isolation used to live entirely in the runner's launch flags. The suite
 * spawns every logic golden as
 *
 *     npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts <golden>
 *
 * and that preload is what points `LEADGEN_DATA_DIR` at a throwaway scratch
 * directory. Run the very same file the way its own header comment tells you to —
 *
 *     npx tsx scripts/golden/golden-kb-semantic.ts
 *
 * — and no preload loads, `LEADGEN_DATA_DIR` is unset, and `src/lib/db.ts`
 * resolves to `.leadgen-data/app-data.json`: the OPERATOR'S LIVE STORE. The
 * documented way to run one golden was the contaminating way.
 *
 * This is the root cause behind three separate cleanups (sessions 35, 37 and
 * 40). The session-40 occurrence was 155 rows — 6 stray workspaces from
 * golden-kb-semantic and 137 orphan AI-usage rows from golden-ai-usage, both
 * from ordinary standalone debugging runs. Reaping the residue treats the
 * symptom; the leak refills the moment anyone debugs a golden again.
 *
 * ── WHY THIS IS A SEPARATE, SMALLER PRELOAD ─────────────────────────────────
 * `force-json-provider.ts` would also have closed it, but it does two other
 * things — pins `PERSISTENCE_PROVIDER=json` and strips the platform AI keys.
 * Both are right for a runner-launched logic golden and both are extra blast
 * radius to hand to ~180 files at once. This preload does ONE thing, so
 * adopting it everywhere cannot change what any golden measures.
 *
 * ── WHY IT MUST BE THE FIRST IMPORT IN THE FILE ─────────────────────────────
 * `src/lib/db.ts` reads `LEADGEN_DATA_DIR` into a MODULE-LEVEL const, evaluated
 * once on first import. ES module dependencies evaluate in source order before
 * the importing module's own body, so this only lands if it is the first
 * `import` line — a line inside `main()` is far too late. Same reasoning as
 * `isolate-json-data.ts`, which documents the day that bit us.
 *
 * ── WHY THE GUARD, AND WHY IT IS NOT A NO-OP ────────────────────────────────
 * Under the runner `LEADGEN_DATA_DIR` is already set, so this does nothing at
 * all and the suite behaves exactly as before. It only acts on the standalone
 * path, which is precisely the path that had no protection. Deliberately NOT
 * an else-branch that overwrites: a harness that has chosen a directory on
 * purpose (`force-prisma-provider`, `isolate-json-data`) must keep it.
 */
import pathMod from "node:path";
import { ensureScratchRoot } from "./golden-scratch";

if (!process.env.LEADGEN_DATA_DIR) {
  process.env.LEADGEN_DATA_DIR = pathMod.join(
    ensureScratchRoot(),
    `standalone-${process.pid}-${Date.now()}`,
  );
  // N-TEST-13 (2026-08-27): redirecting the data DIRECTORY only protects the
  // JSON substrate. `.env` in this repo carries PERSISTENCE_PROVIDER="prisma",
  // so a hand-run golden used to send every write straight into the LIVE
  // Postgres while this redirect guarded a JSON file nobody was reading.
  //
  // Measured cost of that gap: 30 debris leads sitting in `workspace_demo` on
  // the ship database — six golden fixture companies, five copies each, from
  // five ordinary standalone runs of golden-status-transitions and
  // golden-lifecycle-timestamps, both of which write into the DEFAULT
  // workspace. Same defect as N-DATA-22, one substrate to the right: the
  // documented way to run one golden was still the contaminating way.
  //
  // Set INSIDE this guard on purpose. Every harness that chooses a substrate
  // deliberately — force-json-provider, force-prisma-provider, isolate-json-data
  // — sets LEADGEN_DATA_DIR itself, so none of them reaches this branch and a
  // PRISMA_GOLDEN run by the suite is untouched. Only the unprotected
  // standalone path is affected, which is exactly the path that had no
  // protection.
  process.env.PERSISTENCE_PROVIDER = "json";
}
