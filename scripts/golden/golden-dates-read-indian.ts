/**
 * golden-dates-read-indian.ts — 2026-09-29, owner walk-through NY1.
 *
 * Screens printed dates with the browser's own format, so a US-English browser
 * showed 8/24/2026 to an Indian owner. Every date on screen now goes through
 * src/lib/format-date.ts.
 *
 *   A — the format: "24 Aug" this year, "24 Aug 2025" otherwise, India time
 *       (a UTC evening is the next IST day), "24 Aug, 3:30 pm" with a time,
 *       blank for no date.
 *   B — no screen formats a date by itself: no bare toLocaleDateString(),
 *       no toLocaleString() on a Date, no toLocaleString(undefined, …).
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-dates-read-indian.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatDate, formatDateTime } from "@/lib/format-date";

const cases: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => cases.push([name, fn]);
const NOW = new Date("2026-09-29T06:00:00Z");

test("A — day, short month, India time", () => {
  assert.equal(formatDate("2026-08-24T10:00:00Z", NOW), "24 Aug");
  assert.equal(formatDate("2025-08-24T10:00:00Z", NOW), "24 Aug 2025", "another year shows the year");
  assert.equal(formatDate("2026-08-24T19:00:00Z", NOW), "25 Aug", "19:00 UTC is 00:30 IST the next day");
  assert.equal(formatDateTime("2026-08-24T10:00:00Z", NOW), "24 Aug, 3:30 pm");
  assert.equal(formatDate(undefined, NOW), "");
  assert.equal(formatDate("not a date", NOW), "");
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("B — no screen formats a date by itself", () => {
  const offenders: string[] = [];
  for (const path of [...files("src/app"), ...files("src/components")]) {
    readFileSync(path, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (/\.toLocaleDateString\(\s*\)/.test(line) || /\.toLocaleString\(\s*undefined/.test(line) || /new Date\([^)]*\)\.toLocaleString\(/.test(line)) {
        offenders.push(`${path}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `use formatDate / formatDateTime from @/lib/format-date:\n${offenders.join("\n")}`);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
