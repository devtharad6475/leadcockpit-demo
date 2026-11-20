/**
 * ONE place that decides whether the demo dataset is still DEMONSTRABLE
 * (N-OBS-1).
 *
 * THE TRAP THIS EXISTS TO CLOSE (raised 2026-08-20 S11-1, closed 2026-08-24 S15-1)
 * -----------------------------------------------------------------------------
 * `scripts/seed-demo.ts` stamps every seeded reply with `timestamp()` — the
 * moment the seeder runs. That is correct: the demo is honest about its own
 * clock, and N-DATA-9 derives each lead's `lastInboundAt` from those replies so
 * the screen and the data agree.
 *
 * But the seeded file is then STATIC, and the WhatsApp 24-hour
 * customer-service window is not. Meta's rule (see `whatsapp-window.ts`) is
 * that free-text replies are allowed only within 24 hours of the customer's
 * last inbound message. So a demo dataset seeded on Monday demonstrates the
 * free-text path on Monday and a DIFFERENT product on Tuesday: every WhatsApp
 * reply is refused as out-of-window and the operator can only send templates.
 *
 * Nothing is broken when that happens — the refusal is the correct behaviour —
 * which is exactly what makes it a trap. There is no error, no warning, and no
 * way for whoever opens the demo to know they are looking at the wrong half of
 * the product. Measured on 2026-08-24: the checked-in demo file's newest
 * inbound was 161.2 hours old, i.e. 6.7 days past the window.
 *
 * The rule, stated once:
 *
 *   A demo dataset is DEMONSTRABLE only while at least one lead's WhatsApp
 *   window is still open. Once no window is open, the demo silently changes
 *   what it demonstrates, and whoever is about to show it must be TOLD, in
 *   words, with the command that fixes it.
 *
 * This module answers that question and nothing else. It takes `now` as an
 * argument rather than reading the clock, so the answer is testable at any
 * point on the timeline instead of only "whenever the test happened to run".
 *
 * Pinned by scripts/golden/golden-demo-freshness.ts.
 */

import { WHATSAPP_WINDOW_MS } from "./whatsapp-window";

/** The command that makes a stale JSON demo demonstrable again. */
export const DEMO_REFRESH_COMMAND = "npm run seed:demo -- --force";

/**
 * N-OBS-2 (2026-08-24): the command above only rewrites the JSON file. It does
 * NOT touch Postgres, which is what `PERSISTENCE_PROVIDER=prisma` ships on, so
 * printing it to someone whose demo lives in Postgres sends them to re-seed the
 * wrong store and come back with the same stale demo. Naming the substrate in
 * the advice is the whole point: advice that cannot work is worse than none,
 * because it gets followed.
 *
 * Not `seed:demo:prisma`. That seeder REFUSES on this database, correctly: the
 * demo rows here were migrated in from JSON and are not its own `seed_*` rows,
 * and its own `--force` warns "Expect a unique-constraint failure if an order
 * number collides" and would leave the database half-written. The refresh script
 * moves the existing conversation forward on the clock instead, which is what a
 * stale demo actually needs.
 */
export const DEMO_REFRESH_COMMAND_PRISMA = "npm run demo:refresh:prisma -- --apply";

/**
 * How long before the window actually closes we start warning. A demo with 40
 * minutes left is technically fine and practically a hand-grenade: the meeting
 * outlasts it. Refuse to call that fresh.
 */
export const DEMO_MIN_WINDOW_MINUTES = 90;

export type DemoLeadLike = {
  id: string;
  companyName?: string;
  lastInboundAt?: string;
};

export type DemoFreshness = {
  /** True only when the demo still shows the free-text WhatsApp path. */
  demonstrable: boolean;
  /** Newest inbound timestamp across every lead, or null when none has one. */
  newestInboundAt: string | null;
  /** Age of that newest inbound, in hours. Null when there is no inbound at all. */
  hoursSinceNewestInbound: number | null;
  /** Minutes left on the widest still-open window. 0 when every window is shut. */
  minutesOfWindowRemaining: number;
  /** How many leads can still receive a free-text WhatsApp reply right now. */
  leadsWithOpenWindow: number;
  /** One line naming the state. */
  headline: string;
  /** What the reader should do about it. Empty when there is nothing to do. */
  fix: string;
};

/**
 * Is this demo dataset still showing the product the demo is meant to show?
 *
 * @param leads  every lead in the demo workspace
 * @param now    the instant to judge against (ms since epoch)
 */
export function demoFreshness(
  leads: readonly DemoLeadLike[],
  now: number,
  refreshCommand: string = DEMO_REFRESH_COMMAND,
): DemoFreshness {
  let newestInboundAt: string | null = null;
  let openCount = 0;
  let widestRemainingMs = 0;

  for (const lead of leads) {
    const at = lead.lastInboundAt;
    if (!at) continue;
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) continue;
    if (!newestInboundAt || at > newestInboundAt) newestInboundAt = at;

    // Same 24h rule the product enforces, not a second copy of it.
    const remainingMs = parsed + WHATSAPP_WINDOW_MS - now;
    if (remainingMs > 0) {
      openCount += 1;
      if (remainingMs > widestRemainingMs) widestRemainingMs = remainingMs;
    }
  }

  const minutesOfWindowRemaining = Math.floor(widestRemainingMs / 60_000);
  const hoursSinceNewestInbound = newestInboundAt
    ? Math.round(((now - Date.parse(newestInboundAt)) / 3_600_000) * 10) / 10
    : null;

  if (!newestInboundAt) {
    return {
      demonstrable: false,
      newestInboundAt: null,
      hoursSinceNewestInbound: null,
      minutesOfWindowRemaining: 0,
      leadsWithOpenWindow: 0,
      headline: "No lead in the demo has ever received a customer message, so the WhatsApp reply flow cannot be shown at all.",
      fix: `Seed the demo dataset: ${refreshCommand}`,
    };
  }

  if (openCount === 0) {
    return {
      demonstrable: false,
      newestInboundAt,
      hoursSinceNewestInbound,
      minutesOfWindowRemaining: 0,
      leadsWithOpenWindow: 0,
      headline:
        `The demo is ${hoursSinceNewestInbound}h old and every WhatsApp 24-hour window in it has closed. ` +
        "It now demonstrates the template-required path, not the free-text reply path — nothing is broken, but it is a different demo.",
      fix: `Re-seed before showing it: ${refreshCommand}`,
    };
  }

  if (minutesOfWindowRemaining < DEMO_MIN_WINDOW_MINUTES) {
    return {
      demonstrable: false,
      newestInboundAt,
      hoursSinceNewestInbound,
      minutesOfWindowRemaining,
      leadsWithOpenWindow: openCount,
      headline:
        `The demo's last open WhatsApp window closes in ${minutesOfWindowRemaining} minutes. ` +
        "It will change what it demonstrates part-way through a meeting.",
      fix: `Re-seed before showing it: ${refreshCommand}`,
    };
  }

  const hours = Math.floor(minutesOfWindowRemaining / 60);
  return {
    demonstrable: true,
    newestInboundAt,
    hoursSinceNewestInbound,
    minutesOfWindowRemaining,
    leadsWithOpenWindow: openCount,
    headline:
      `Demo is demonstrable: ${openCount} lead(s) can still be answered with a free-text WhatsApp reply, ` +
      `${hours}h ${minutesOfWindowRemaining % 60}m left on the widest window.`,
    fix: "",
  };
}

/** The same answer as a line a human can read in a terminal. */
export function demoFreshnessReport(state: DemoFreshness): string {
  const mark = state.demonstrable ? "OK" : "STALE";
  const lines = [`[demo freshness] ${mark} — ${state.headline}`];
  if (state.newestInboundAt) {
    lines.push(`  newest customer message: ${state.newestInboundAt} (${state.hoursSinceNewestInbound}h ago)`);
    lines.push(`  leads still inside the 24h window: ${state.leadsWithOpenWindow}`);
  }
  if (state.fix) lines.push(`  ${state.fix}`);
  return lines.join("\n");
}
