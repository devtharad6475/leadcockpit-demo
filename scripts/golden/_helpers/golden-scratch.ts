/**
 * Where a golden's throwaway data directory lives, and who cleans it up.
 *
 * WHY THIS FILE EXISTS (N-DATA-2, session 35).
 * Three preloads point `LEADGEN_DATA_DIR` at a fresh per-run directory so a
 * golden can never write to the operator's real store. That part works. What
 * none of them did was remove the directory afterwards, and they cannot: the
 * suite runner detects which goldens reached storage by watching for the
 * directory to APPEAR (see CENSUS_ROOT in run-all-goldens.ts), and it reads
 * that evidence in a `finally` after the child has already exited. A child
 * that deleted its own directory on the way out would leave the census
 * reporting "touched no substrate" for every JSON golden — a number that
 * still reads like a measurement while measuring nothing. So cleanup cannot
 * happen at the end of a run; it has to happen at the START of the next one,
 * once the previous run's evidence has been read and reported.
 *
 * WHY THE ROOT MOVED OUT OF THE OS TEMP DIRECTORY.
 * It used to be `os.tmpdir()/leadgen-golden-data`, which had accumulated
 * 8,206 directories. That path is outside this project, and the standing rule
 * on this system is that nothing outside the project folder gets deleted —
 * so a sweeper there would have been the wrong tool no matter how careful.
 * Putting the scratch root inside the project makes the mess ours to clean,
 * keeps it visible next to the code that creates it, and means the sweep
 * below can never reach a file this project did not write.
 *
 * The pre-existing directories under `os.tmpdir()` are deliberately LEFT
 * ALONE. They stop growing from here, and disposing of them is the operator's
 * call, not this script's.
 */
import fsSync from "node:fs";
import pathMod from "node:path";

/**
 * Project root. Goldens are normally launched with the repo root as cwd, but
 * "normally" is not a guarantee worth betting a recursive delete on, so walk
 * up until package.json is found and refuse to guess if it never is.
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fsSync.existsSync(pathMod.join(dir, "package.json"))) return dir;
    const parent = pathMod.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `golden-scratch: could not locate the project root from ${process.cwd()} — refusing to guess a directory to sweep.`,
  );
}

export const SCRATCH_ROOT = pathMod.join(findProjectRoot(), ".golden-scratch");

/** `run-<pid>-<ms>`, `prisma-golden-<pid>-<ms>`, `substrate-parity-<pid>-<ms>`. */
const SCRATCH_DIR = /^(?:run|prisma-golden|substrate-parity)-\d+-(\d+)$/;

/** Create the scratch root if absent and return it. */
export function ensureScratchRoot(): string {
  try {
    fsSync.mkdirSync(SCRATCH_ROOT, { recursive: true });
  } catch {
    /* already exists */
  }
  return SCRATCH_ROOT;
}

/**
 * Remove scratch directories older than `maxAgeMs`, and report how many went.
 *
 * Deliberately conservative in three ways, because this deletes recursively:
 * it only ever looks inside SCRATCH_ROOT, it only removes names matching the
 * exact pattern the preloads generate (so a file dropped there by hand
 * survives), and it uses the timestamp encoded in the NAME rather than the
 * filesystem mtime — a name this code wrote is stronger evidence of
 * provenance than a timestamp anything could have touched.
 *
 * The default age leaves the current run and anything from the last hour
 * intact, so a suite running in another terminal cannot have its evidence
 * pulled out from under it.
 */
export function sweepScratchRoot(maxAgeMs: number = 60 * 60 * 1000): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  const cutoff = Date.now() - maxAgeMs;
  let names: string[];
  try {
    names = fsSync.readdirSync(SCRATCH_ROOT);
  } catch {
    return { removed: 0, kept: 0 };
  }
  for (const name of names) {
    const match = SCRATCH_DIR.exec(name);
    if (!match) { kept++; continue; }
    if (Number(match[1]) >= cutoff) { kept++; continue; }
    try {
      fsSync.rmSync(pathMod.join(SCRATCH_ROOT, name), { recursive: true, force: true });
      removed++;
    } catch {
      // A directory still held open by a run that has not finished exiting is
      // not an error worth failing the suite over — the next sweep gets it.
      kept++;
    }
  }
  return { removed, kept };
}
