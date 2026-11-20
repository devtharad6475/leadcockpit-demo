/**
 * isolate-json-data.ts — preload that redirects JSON-substrate reads/writes
 * to a process-unique temp directory, WITHOUT forcing PERSISTENCE_PROVIDER.
 *
 * ─── WHY THIS IS A SEPARATE FILE FROM force-json-provider.ts ───────────────
 *
 * `force-json-provider.ts` does two things: pins `PERSISTENCE_PROVIDER=json`
 * AND isolates the JSON data directory. That's correct for an ordinary logic
 * golden, which only ever touches one substrate.
 *
 * `golden-substrate-parity.ts` deliberately touches BOTH substrates in one
 * process — it needs the isolation half without the provider-pinning half,
 * because pinning `PERSISTENCE_PROVIDER=json` would fight its own explicit
 * `createRepositories("prisma")` call for the Prisma pass. Sharing the file
 * would have meant either forking it or teaching it to notice which half of
 * itself was running — this preload is the smaller, honest fix.
 *
 * ─── WHY THIS MUST BE A PRELOAD, NOT CODE INSIDE THE GOLDEN'S main() ───────
 *
 * `src/lib/db.ts` reads `process.env.LEADGEN_DATA_DIR` into a MODULE-LEVEL
 * `const dataDir = ...`, evaluated once when the module is first imported.
 * ES module imports are hoisted, so a golden's own top-level
 * `import { createRepositories } from "../../src/repositories"` runs BEFORE
 * a single line of that golden's `main()` function body — including a line
 * that sets `process.env.LEADGEN_DATA_DIR`. By the time `main()` runs, the
 * path is already frozen.
 *
 * This bit `golden-substrate-parity.ts` itself on its first real use: it set
 * `LEADGEN_DATA_DIR` inside `main()`, which had no effect, so `db.ts` kept
 * resolving to the real `.leadgen-data/app-data.json` — the SHARED demo
 * file — and every run left `sp-<timestamp>-*` junk rows in it (50 rows
 * after 2 runs, workspaces/profiles/campaigns/tickets/templates, none of
 * which its `cleanup()` removed because cleanup only ever called
 * `repos.lead.deleteById`, relying on a cascade the JSON substrate doesn't
 * implement).
 *
 * `--import` (Node) / tsx's preload equivalent runs THIS file's top-level
 * code before the golden's own module graph is evaluated, so setting the
 * env var here actually lands before `db.ts` reads it.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/isolate-json-data.ts scripts/golden/golden-substrate-parity.ts
 */
import pathMod from "node:path";
// N-DATA-2: the scratch root used to be os.tmpdir()/leadgen-golden-data, which
// nothing ever cleaned and which had grown to 8,206 directories. It now lives
// inside the project, so the mess is ours to sweep -- see golden-scratch.ts for
// why cleanup happens at the START of the next run rather than at the end of
// this one, and why the old OS-temp directories are deliberately left alone.
import { ensureScratchRoot } from "./golden-scratch";
const tempRoot = ensureScratchRoot();
process.env.LEADGEN_DATA_DIR = pathMod.join(tempRoot, `substrate-parity-${process.pid}-${Date.now()}`);
