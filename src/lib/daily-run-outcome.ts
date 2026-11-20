/**
 * daily-run-outcome.ts — what the scheduler's exit code means (2026-09-28).
 *
 * "Search is not connected — no new buyers found today" is put in a
 * workspace's run errors on purpose (LOGIC.md 2026-09-27 break test L1): the
 * morning summary must say it loudly instead of showing a quiet zero. But the
 * scheduler turned every run error into exit code 1, so a company that simply
 * has not connected search made the daily job "fail" every day — the host's
 * alerting cried wolf and a real failure next to it looked the same.
 *
 * THE RULE: a setup notice (today: search not connected) stays in the run
 * report and the morning summary exactly as before, is printed by the
 * scheduler as a loud "NEEDS SETUP" warning, and does not by itself make the
 * run fail. Any other error still exits 1.
 */
const SETUP_NOTICES: RegExp[] = [
  /search is not connected/i,
];

export function isSetupNotice(error: string): boolean {
  return SETUP_NOTICES.some((pattern) => pattern.test(error));
}

export type RunProblems = { failures: string[]; setupNotices: string[] };

export function splitRunProblems(errors: string[]): RunProblems {
  const failures: string[] = [];
  const setupNotices: string[] = [];
  for (const error of errors) (isSetupNotice(error) ? setupNotices : failures).push(error);
  return { failures, setupNotices };
}

/** 1 when any workspace had a real failure; 0 when the only problems were setup notices. */
export function schedulerExitCode(reports: Array<{ skipped?: string; errors: string[] }>): 0 | 1 {
  return reports.some((r) => !r.skipped && splitRunProblems(r.errors).failures.length > 0) ? 1 : 0;
}
