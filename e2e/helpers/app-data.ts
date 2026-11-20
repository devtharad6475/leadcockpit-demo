/**
 * app-data.ts — read the workspace snapshot the way the RUNNING SERVER sees it.
 *
 * WHY THIS EXISTS (2026-09-08)
 * ---------------------------
 * Nine `depth-*.spec.ts` files each defined their own
 *
 *     function readAppData() { return JSON.parse(fs.readFileSync(DATA_FILE)); }
 *
 * and verified every button press by reading that file. On the JSON substrate
 * that is exactly right: the file IS the database.
 *
 * On Postgres it is not right, and it is not merely wrong — it is silent. The
 * button writes a row to Postgres; the assertion then reads a JSON file that
 * the run never touched, sees the pre-run value, and reports a failure that
 * describes the test harness rather than the product. Measured on 2026-09-08:
 * 50 of the 51 failures in the Postgres run were this, across all nine files.
 * Fifty behaviours that nobody could say were working or broken — and the
 * suite had been reporting them as failures every time it was pointed at the
 * substrate production actually runs on.
 *
 * The fix is to ask the SERVER what it stored, instead of guessing from a file.
 * `GET /api/data/export` returns the workspace's own collections through the
 * repository layer, so it answers correctly on either substrate. That also
 * makes the assertion stronger than it was: it now proves the value survived
 * the round trip through the real read path, not merely that something was
 * written to disk.
 *
 * WHY IT IS SYNCHRONOUS. The call sites are ordinary expressions inside
 * assertions — `expect(ticket(id).status).toBe("open")` — several hundred of
 * them. Making the read async would mean touching every one, and every edit is
 * a chance to weaken an assertion by accident. A child process that performs
 * the fetch and prints the body keeps all of those lines exactly as they are,
 * and the cost (one spawn per read) is paid only on the Postgres run.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { E2E_DATA_FILE } from "./data-dir";
import { E2E_TARGET, E2E_PORT } from "./e2e-target";

/** Runs in a child process: fetch the export and print it. */
const FETCH_SNAPSHOT = `
const url = process.argv[1];
fetch(url, { headers: { Cookie: "lc_demo=1" } })
  .then(async (response) => {
    const text = await response.text();
    if (!response.ok) {
      process.stderr.write("HTTP " + response.status + " from " + url + ": " + text.slice(0, 400));
      process.exit(1);
    }
    process.stdout.write(text);
  })
  .catch((error) => {
    process.stderr.write("request failed: " + String(error));
    process.exit(1);
  });
`;

export function readAppData(): any {
  if (E2E_TARGET !== "prisma") {
    // JSON substrate: the file is the database. Unchanged behaviour.
    return JSON.parse(fs.readFileSync(E2E_DATA_FILE, "utf8"));
  }

  const url = `http://localhost:${E2E_PORT}/api/data/export?workspaceId=workspace_demo`;
  let body: string;
  try {
    body = execFileSync(process.execPath, ["-e", FETCH_SNAPSHOT, url], {
      encoding: "utf8",
      // A seeded workspace exports a few MB; the default 1MB buffer truncates
      // it into a JSON parse error that names nothing useful.
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr || String(error);
    // 2026-09-08 — the first Postgres run hit this several hundred times and
    // died at HTTP 429: `export` is capped at 50 per 24 HOURS, a limit sized
    // for a human clicking Export, not for one call per assertion. The test
    // server now boots with RATE_LIMIT_SINGLE_USER=1 (playwright.config.ts),
    // which lifts every non-auth preset to 10,000/minute. If this reappears,
    // that variable is missing from the server's environment — do NOT cache
    // the snapshot to get around it: every one of these reads happens directly
    // after a write, and a cached read would report the pre-write value and
    // pass.
    const hint = /\b429\b/.test(detail)
      ? " The server answered 429: it was started WITHOUT RATE_LIMIT_SINGLE_USER=1, so /api/data/export is capped at 50 per day."
      : "";
    throw new Error(
      `readAppData(): could not read the workspace snapshot from the server on :${E2E_PORT}. ` +
        `On the Postgres target the snapshot comes from /api/data/export, not from a file.${hint} ${detail}`,
    );
  }

  const parsed = JSON.parse(body);
  // The endpoint wraps the collections: { exportedAt, mode, workspaceId, data }.
  const data = parsed.data ?? parsed;
  if (!data || typeof data !== "object") {
    throw new Error("readAppData(): the export returned no data object.");
  }
  return data;
}
