/**
 * atomic-rename.ts — the last step of an atomic file write, made survivable on
 * Windows.
 *
 * WHAT WENT WRONG (N-DATA-5, found 2026-08-19 during the e2e sweep)
 * -----------------------------------------------------------------
 * `writeData()` writes a temp file and renames it over `app-data.json`. On
 * Windows that rename intermittently fails:
 *
 *     EPERM: operation not permitted, rename
 *       '.leadgen-data-e2e/app-data.21408.<ts>.<rand>.tmp'
 *       -> '.leadgen-data-e2e/app-data.json'
 *
 * and the operator sees a 500. It is not a permissions problem: the process
 * owns both files. Windows refuses the rename while ANY other handle is open
 * on the destination without FILE_SHARE_DELETE — antivirus, a file indexer, or
 * (in this repo, reliably) the dev server's own recursive watcher, because the
 * data directory lives inside the project tree.
 *
 * The write is therefore not broken, only BLOCKED — and blocked for a few
 * hundred milliseconds at a time. The previous policy retried 5 times with
 * 50/100/150/200ms backoff, a total budget of 500ms, which was not enough: the
 * error above was still reaching users.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * A retry policy nobody has watched fail proves nothing, and the failure it
 * has to survive (an external process holding a handle at exactly the wrong
 * moment) cannot be summoned on demand. So the policy takes its `rename` and
 * `sleep` as arguments: a golden can hand it a rename that fails N times and
 * assert the exact thing that matters — that N transient failures are survived,
 * that a non-transient error is NOT retried, and that the budget is what the
 * comment above says it is.
 */

/**
 * Codes that mean "someone else is holding the file right now", as opposed to
 * "this rename is never going to work". Retrying anything else just delays a
 * real error — a full disk or a missing directory does not heal by waiting.
 */
export const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Backoff schedule in milliseconds, one entry per RETRY (so the number of
 * attempts is this length + 1). Starts tight because most collisions clear
 * almost immediately, then settles at 500ms so a longer lock is waited out
 * rather than escalated into a 500.
 *
 * Total budget: 3.075s. That is a deliberately unpleasant stall — but a write
 * that takes three seconds and succeeds beats one that fails in half a second
 * and loses the operator's edit.
 */
export const RENAME_BACKOFF_MS = [25, 50, 75, 100, 150, 200, 250, 375, 500, 500, 500, 350];

export type RenameFn = (from: string, to: string) => Promise<void>;
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type RenameWithRetryOptions = {
  rename: RenameFn;
  sleep?: SleepFn;
  /** Called once per retry, so the caller can log a write that had to fight. */
  onRetry?: (attempt: number, waitMs: number, error: unknown) => void;
};

export type RenameOutcome = {
  /** How many times rename() was called. 1 means it worked first time. */
  attempts: number;
  /** Total time spent waiting between attempts. */
  waitedMs: number;
};

/**
 * Renames `from` over `to`, waiting out transient Windows file locks.
 *
 * Throws the LAST error seen, not a wrapper: whoever reads the log needs the
 * real code and the real paths. A non-transient error is rethrown immediately
 * without a single millisecond of backoff.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  { rename, sleep = defaultSleep, onRetry }: RenameWithRetryOptions,
): Promise<RenameOutcome> {
  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return { attempts: attempt, waitedMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const retriesLeft = attempt <= RENAME_BACKOFF_MS.length;
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || !retriesLeft) throw error;
      const waitMs = RENAME_BACKOFF_MS[attempt - 1];
      onRetry?.(attempt, waitMs, error);
      waitedMs += waitMs;
      await sleep(waitMs);
    }
  }
}
