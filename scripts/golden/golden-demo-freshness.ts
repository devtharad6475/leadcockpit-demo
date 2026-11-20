/**
 * Golden test — the demo dataset must never quietly change what it
 * demonstrates (N-OBS-1).
 *
 * WHY THIS EXISTS (raised 2026-08-20 S11-1 as an observation, closed 2026-08-24 S15-1)
 * -----------------------------------------------------------------------------------
 * `seed-demo.ts` stamps the demo's replies with the moment it runs, and
 * N-DATA-9 derives each lead's `lastInboundAt` from them. Both correct. But the
 * file it writes is static and Meta's 24-hour customer-service window is not,
 * so the SAME file demonstrates the free-text WhatsApp reply path on the day it
 * is seeded and the template-required path on every day after.
 *
 * Nothing errors when that happens. The refusal is the product behaving
 * correctly. That is exactly what makes it a trap — measured on 2026-08-24, the
 * checked-in demo file's newest customer message was 161.9 hours old, so anyone
 * opening it would have concluded free-text replies do not work.
 *
 * THE RULE, now in one place (src/lib/demo-freshness.ts):
 *
 *   A demo dataset is DEMONSTRABLE only while at least one lead's WhatsApp
 *   window is open with enough time left to outlast a meeting. When it is not,
 *   the reader must be told in words and given the command that fixes it.
 *
 * Hand-computed BEFORE the assertions (the Golden Thread):
 *
 *   CASE A — the timeline. One lead, last inbound at T. Judged at T+0h, +1h,
 *     +22h, +23h (60 min left, under the 90-minute floor), +24h and +48h.
 *     Hand-computed demonstrable: true · true · true · FALSE · false · false.
 *     The +23h row is the one that matters: technically inside the window,
 *     practically a demo that dies mid-meeting.
 *
 *   CASE B — one copy of the 24-hour rule. `demo-freshness.ts` must import
 *     `WHATSAPP_WINDOW_MS` from the module that enforces the rule in
 *     production, and must not carry its own literal for it.
 *
 *   CASE C — every not-demonstrable verdict names a fix, the fix is a command
 *     that actually changes the data (a bare `npm run seed:demo` is a DRY RUN
 *     and would leave a hurried operator exactly where they started), and that
 *     npm script really exists in package.json.
 *
 *   CASE D — degenerate input never throws and never reads as fine: no leads,
 *     leads with no inbound at all, and an unparseable timestamp.
 *
 *   CASE E — the real demo file on disk, judged and reported. Asserts the
 *     verdict is self-consistent rather than asserting it is fresh, because a
 *     golden that fails once a day is a golden nobody trusts. Freshness itself
 *     is a deliberate pre-demo action: `npm run demo:check`.
 *
 *   CASE F — that pre-demo action really refuses. Builds a deliberately stale
 *     dataset in a temp dir, runs `scripts/check-demo-freshness.ts` against it
 *     as a real subprocess, and requires a NON-ZERO exit plus the fix command
 *     in the output.
 *
 * Test isolation (Gate #8): CASE F writes only inside an os.tmpdir() folder it
 * creates and removes. Nothing else writes anywhere.
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-demo-freshness.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  demoFreshness,
  demoFreshnessReport,
  DEMO_REFRESH_COMMAND,
  DEMO_MIN_WINDOW_MINUTES,
  type DemoLeadLike,
} from "@/lib/demo-freshness";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const HOUR = 3_600_000;
const T = Date.parse("2026-08-24T09:00:00.000Z");
const oneLead = (at: string): DemoLeadLike[] => [{ id: "lead_demo_1", companyName: "Demo Buyer", lastInboundAt: at }];
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

function main() {
  // ─── CASE A: the timeline, hand-computed ───────────────────────────────────
  {
    const at = new Date(T).toISOString();
    const timeline: Array<{ hours: number; demonstrable: boolean; why: string }> = [
      { hours: 0, demonstrable: true, why: "just seeded — a full 24h window" },
      { hours: 1, demonstrable: true, why: "23h left" },
      { hours: 22, demonstrable: true, why: "2h left, still outlasts a meeting" },
      { hours: 23, demonstrable: false, why: `60 min left, under the ${DEMO_MIN_WINDOW_MINUTES}-minute floor` },
      { hours: 24, demonstrable: false, why: "window closed exactly" },
      { hours: 48, demonstrable: false, why: "a day past the window — the demo it was seeded as no longer exists" },
    ];
    for (const row of timeline) {
      const state = demoFreshness(oneLead(at), T + row.hours * HOUR);
      assert(
        state.demonstrable === row.demonstrable,
        `CASE A: at T+${row.hours}h demonstrable=${state.demonstrable}, hand-computed ${row.demonstrable} (${row.why}). ` +
        `Reported: ${state.headline}`,
      );
      assert(
        state.hoursSinceNewestInbound === row.hours,
        `CASE A: at T+${row.hours}h the age reads ${state.hoursSinceNewestInbound}h. An operator uses this number to decide whether to re-seed.`,
      );
    }
    // The floor is what makes T+23h fail. Prove it is the floor doing it and
    // not the window, or the case above proves nothing about the floor.
    const justInside = demoFreshness(oneLead(at), T + 23 * HOUR);
    assert(
      justInside.minutesOfWindowRemaining === 60 && justInside.leadsWithOpenWindow === 1,
      `CASE A: at T+23h the WhatsApp window is still open (60 min, 1 lead) — got ` +
      `${justInside.minutesOfWindowRemaining} min / ${justInside.leadsWithOpenWindow} lead(s). ` +
      "The T+23h verdict must come from the meeting-length floor, not from a closed window.",
    );
    console.log(`✅ CASE A — demonstrable at T+0/1/22h, refused at T+23h (${justInside.minutesOfWindowRemaining} min left), T+24h and T+48h`);
  }

  // ─── CASE B: one copy of the 24-hour rule ──────────────────────────────────
  {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "lib", "demo-freshness.ts"), "utf8");
    // Strip comments first — this file documents the rule it must not duplicate,
    // and a golden that reads its own documentation is the S11-1 lesson.
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("//");
      })
      .join("\n");
    assert(
      /import\s*\{[^}]*WHATSAPP_WINDOW_MS[^}]*\}\s*from\s*"\.\/whatsapp-window"/.test(code),
      "CASE B: demo-freshness.ts must import WHATSAPP_WINDOW_MS from ./whatsapp-window, so the demo check and the production send gate " +
      "can never disagree about when the window closes",
    );
    assert(
      !/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(code),
      "CASE B: demo-freshness.ts has its own literal copy of the 24-hour window. Two copies of a rule drift, and this one would drift " +
      "silently — the demo would call itself fresh while the product refused the send",
    );
    console.log("✅ CASE B — the 24-hour rule is imported from whatsapp-window.ts, not re-typed");
  }

  // ─── CASE C: a refusal that cannot be acted on is not a refusal ────────────
  {
    const stale = demoFreshness(oneLead(new Date(T).toISOString()), T + 48 * HOUR);
    assert(!stale.demonstrable, "CASE C: setup — a 48h-old dataset must not be demonstrable");
    assert(stale.fix.includes(DEMO_REFRESH_COMMAND), `CASE C: a stale verdict must carry the fix command. Got fix="${stale.fix}"`);
    assert(
      DEMO_REFRESH_COMMAND.includes("--force"),
      `CASE C: DEMO_REFRESH_COMMAND is "${DEMO_REFRESH_COMMAND}". Without --force the seeder prints "Dry run" and changes NOTHING, ` +
      "so an operator following this instruction would show the same stale demo and never learn why",
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert(pkg.scripts["seed:demo"], "CASE C: DEMO_REFRESH_COMMAND names `seed:demo`, which is not in package.json");
    assert(
      pkg.scripts["demo:check"] === "tsx scripts/check-demo-freshness.ts",
      `CASE C: the pre-demo check must be one command anyone can run. package.json has demo:check="${pkg.scripts["demo:check"]}"`,
    );
    const fresh = demoFreshness(oneLead(new Date(T).toISOString()), T);
    assert(fresh.fix === "", `CASE C: a healthy demo must not tell anyone to fix anything. Got fix="${fresh.fix}"`);
    console.log(`✅ CASE C — every stale verdict names "${DEMO_REFRESH_COMMAND}", and a healthy one asks for nothing`);
  }

  // ─── CASE D: degenerate input ──────────────────────────────────────────────
  {
    const empty = demoFreshness([], T);
    assert(!empty.demonstrable && empty.newestInboundAt === null, "CASE D: an empty dataset must never read as demonstrable");
    assert(empty.fix !== "", "CASE D: an empty dataset must say what to do about it");

    const noInbound = demoFreshness([{ id: "lead_a" }, { id: "lead_b", companyName: "Nobody" }], T);
    assert(
      !noInbound.demonstrable && noInbound.hoursSinceNewestInbound === null,
      "CASE D: leads that have never received a customer message cannot demonstrate the reply flow",
    );

    const garbage = demoFreshness([{ id: "lead_c", lastInboundAt: "not-a-date" }], T);
    assert(
      !garbage.demonstrable && garbage.newestInboundAt === null,
      "CASE D: an unparseable timestamp must be ignored, not turned into NaN hours on an operator's screen. " +
      `Got newestInboundAt=${garbage.newestInboundAt}, hours=${garbage.hoursSinceNewestInbound}`,
    );
    console.log("✅ CASE D — no leads, no inbound, and an unparseable timestamp all refuse safely");
  }

  // ─── CASE E: the real demo file ────────────────────────────────────────────
  {
    const file = path.join(process.cwd(), ".leadgen-data", "app-data.json");
    assert(fs.existsSync(file), `CASE E: no demo dataset at ${file} — run ${DEMO_REFRESH_COMMAND}`);
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { leads?: DemoLeadLike[] };
    const state = demoFreshness(data.leads ?? [], Date.now());
    // Deliberately NOT asserting freshness: this file ages by design, and a
    // golden that goes red because a day passed teaches everyone to ignore it.
    // What must always hold is that the verdict agrees with itself.
    assert(
      state.demonstrable === (state.leadsWithOpenWindow > 0 && state.minutesOfWindowRemaining >= DEMO_MIN_WINDOW_MINUTES),
      `CASE E: the verdict contradicts its own numbers — demonstrable=${state.demonstrable} with ` +
      `${state.leadsWithOpenWindow} open window(s) and ${state.minutesOfWindowRemaining} min left`,
    );
    assert(
      (state.fix === "") === state.demonstrable,
      `CASE E: a fix must be present exactly when the demo is not demonstrable. demonstrable=${state.demonstrable}, fix="${state.fix}"`,
    );
    assert(state.headline.trim() !== "", "CASE E: the verdict must always say something a human can read");
    console.log(`✅ CASE E — real demo file: ${demoFreshnessReport(state).split("\n")[0]}`);
  }

  // ─── CASE F: the pre-demo check really refuses ─────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-fresh-"));
    try {
      const stale = new Date(Date.now() - 9 * 24 * HOUR).toISOString();
      fs.writeFileSync(
        path.join(dir, "app-data.json"),
        JSON.stringify({ leads: [{ id: "lead_stale", companyName: "Nine Days Ago", lastInboundAt: stale }] }),
        "utf8",
      );
      let exitCode = 0;
      let output = "";
      try {
        // node + tsx's own entry point, NOT `npx ... { shell: true }`: on Windows
        // that needs a shell, and a shell here concatenates an OS temp path
        // straight into a command line (Node's DEP0190). Spawning the resolved
        // .mjs directly keeps `dir` an argument instead of shell text.
        output = execFileSync(process.execPath, [TSX_CLI, "scripts/check-demo-freshness.ts"], {
          cwd: process.cwd(),
          env: { ...process.env, LEADGEN_DATA_DIR: dir },
          encoding: "utf8",
        });
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        exitCode = e.status ?? -1;
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      assert(
        exitCode !== 0,
        `CASE F: the demo check exited ${exitCode} on a nine-day-old dataset. A check that passes on stale data is worse ` +
        `than no check — it certifies the trap. Output:\n${output}`,
      );
      assert(
        output.includes(DEMO_REFRESH_COMMAND),
        `CASE F: the refusal must print "${DEMO_REFRESH_COMMAND}". Output:\n${output}`,
      );
      assert(/STALE/.test(output), `CASE F: the refusal must be readable at a glance. Output:\n${output}`);
      console.log(`✅ CASE F — demo:check exited ${exitCode} on a nine-day-old dataset and printed the fix command`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\n✅ ALL CASES PASSED — golden-demo-freshness");
}

main();
