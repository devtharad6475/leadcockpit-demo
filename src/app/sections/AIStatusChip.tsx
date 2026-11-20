/**
 * AI status chip (header).
 *
 * ── HISTORY, AND WHY THE SHAPE CHANGED ──────────────────────────────────────
 * 2026-08-17 — born as a CARD pinned to the bottom of the sidebar. The four
 * autonomy switches used to live eight clicks deep in AI Settings, and an
 * operator who lets the AI run unattended needs to know, at all times and
 * without navigating, what it is currently allowed to do — and be able to stop
 * it in one click. That requirement was right and still holds.
 *
 * 2026-08-31 (N-UI-3) — the CEO reported the cost of that shape: the card ate
 * roughly a third of the sidebar's height, so opening a nav group left no room
 * to see the screens inside it. The requirement was never "a card"; it was
 * "always visible, and stoppable in one click". A header CHIP satisfies both
 * and costs no vertical space at all:
 *
 *   - KNOWING costs ZERO clicks. The chip is in the header, so it is on every
 *     screen, and it reads its state in words, not just a colour.
 *   - STOPPING costs ONE click. The Pause button renders ONLY when something
 *     is actually running — the button is absent exactly when it would do
 *     nothing, so the header stays quiet on a normal day.
 *   - The four per-job rows are NOT lost. They move back to AI Settings, which
 *     already renders the same four switches from the same endpoint — the card
 *     was duplicating that list, not owning it. The chip links straight there.
 *
 * Deliberately NOT a popover: this app has no popover primitive, and the
 * Dropdown primitive is a MENU (role="menu"), which is the wrong semantics for
 * a status panel. Adding a dependency to hide two facts behind a click would
 * have made the important half — knowing — cost more, not less.
 *
 * Data + writes go to the SAME endpoint AI Settings uses
 * (/api/agent-autonomous/settings), so this chip and that screen can never
 * disagree. No new backend.
 *
 * 2026-09-08 (N-BUG) — the CEO found the hole in all of the above: this chip
 * reported which jobs were switched ON, and had no idea whether the API key
 * behind them worked. When a provider balance hits zero, LLMService quietly
 * swaps in the mock provider, replies drop to canned text, and classification
 * drops to the keyword floor — while this chip goes on saying "AI running 6/6"
 * on every screen. The owner is told everything is fine and finds out from a
 * customer.
 *
 * So the chip now asks a second question — /api/ai/provider-health, derived
 * from the AgentRun history — and health OUTRANKS the switches, because "the
 * jobs are enabled" is worthless news when the model behind them is not
 * answering. There is nothing to switch back on after a top-up: every call
 * still tries the real provider first, so the next success flips this back on
 * its own.
 */
"use client";
import React, { useCallback, useEffect, useState } from "react";
import { ConfirmModal } from "@/components/ui";
import { api } from "@/lib/api-client";
import { workspaceId } from "@/app/page";
// N-UI-6 — the four jobs are named in ONE place (src/lib/ai-autonomy-jobs.ts)
// so this chip and the AI Settings screen can never call the same switch by
// two different names.
import { AUTONOMY_JOBS, AUTONOMY_CHANGED_EVENT, countAutomatic, notifyAutonomyChanged } from "@/lib/ai-autonomy-jobs";

type ProviderHealth = {
  status: "healthy" | "degraded" | "blocked" | "unknown";
  headline: string;
  action: string;
  reason: string;
  degradedCalls: number;
  /** When the trouble began. Present only when there IS trouble to point at. */
  since?: string;
};

/**
 * How often to re-ask whether the model is answering. A balance runs out
 * mid-day, not on page load, so a chip that only checks once would keep the
 * old lie on screen for as long as the tab stays open. Two minutes is often
 * enough that nobody works a whole conversation on stale news, and rare enough
 * to be invisible — it is one small read of recent runs.
 */
const HEALTH_POLL_MS = 120_000;

export function AIStatusChip({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await api<Record<string, unknown>>("/api/agent-autonomous/settings"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the AI's settings");
    }
  }, []);

  // Deliberately separate from `load`, and deliberately silent on failure: if
  // the health read itself breaks, the chip falls back to what it always said
  // rather than replacing a working header with an error. A missing answer here
  // is not evidence of a problem with the AI.
  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api<ProviderHealth>("/api/ai/provider-health"));
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { load(); loadHealth(); }, 0);
    const poll = window.setInterval(() => { loadHealth(); }, HEALTH_POLL_MS);
    // Re-read whenever anything else changes these settings — otherwise this
    // chip keeps claiming "AI paused" after the AI Settings screen has switched
    // a job to automatic, and the two disagree until the page is reloaded.
    window.addEventListener(AUTONOMY_CHANGED_EVENT, load);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener(AUTONOMY_CHANGED_EVENT, load);
    };
  }, [load, loadHealth]);

  async function pauseAll() {
    setSaving(true);
    try {
      // One POST carrying EVERY job — the route merges a partial body, so
      // sending them together is a single atomic "stop everything".
      //
      // Built from AUTONOMY_JOBS rather than typed out: a hand-written list
      // here would still say "all four jobs stopped" after a fifth job was
      // added, and would quietly leave that fifth one running.
      await api("/api/agent-autonomous/settings", {
        method: "POST",
        body: AUTONOMY_JOBS.reduce<Record<string, unknown>>(
          (body, job) => ({ ...body, [job.field]: "manual" }),
          { workspaceId },
        ),
      });
      await load();
      notifyAutonomyChanged(); // so an open AI Settings screen updates too
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't pause the AI");
    } finally {
      setSaving(false);
      setConfirmPause(false);
    }
  }

  // Unreadable settings must not render as "AI is paused" — that would be a
  // confident claim about autonomy we cannot actually verify. Say we don't
  // know, and make saying so clickable.
  if (error) {
    return (
      <button
        type="button"
        onClick={() => load()}
        title={`${error} — click to try again`}
        className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-bg px-2.5 py-1.5 text-xs font-semibold text-danger-fg transition-colors hover:opacity-90"
      >
        <span className="h-2 w-2 rounded-full bg-danger-fg" aria-hidden="true" />
        AI status unknown
      </button>
    );
  }

  if (!settings) {
    return <div className="h-8 w-28 animate-pulse rounded-lg border border-border-default bg-surface-muted" aria-hidden="true" />;
  }

  const autoCount = countAutomatic(settings);
  const running = autoCount > 0;

  // Health outranks the switches. "AI running 6/6" is not merely unhelpful when
  // the model is not answering — it is the false comfort that keeps an owner
  // from topping up. `unknown` (the AI has not run yet) is not a problem and
  // must not raise an alarm about a workspace that simply started today.
  const unwell = health && (health.status === "blocked" || health.status === "degraded");
  const blocked = health?.status === "blocked";
  // An old failure with nothing attempted since. Not an outage to shout about —
  // but not nothing either, so it is kept where an owner can find it rather than
  // dropped. `since` is what separates this from a workspace that simply has
  // never run the AI, which has nothing to report at all.
  const stale = health?.status === "unknown" && Boolean(health.since);

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenSettings}
          // The chip says what is true in words. Colour alone would fail an
          // operator who cannot distinguish green from grey.
          title={
            unwell
              ? `${health!.headline}${health!.action ? ` ${health!.action}` : ""} Replies fall back to safe canned text until it recovers. Click to open AI Settings.`
              : stale
                ? `${health!.headline}${health!.action ? ` ${health!.action}` : ""} Click to open AI Settings and test the connection.`
                : running
                ? `The AI is running ${autoCount} of ${AUTONOMY_JOBS.length} jobs on its own. Click to change what it may do.`
                : "You approve everything. Nothing runs unattended. Click to change what the AI may do."
          }
          className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            blocked
              ? "border-danger-border bg-danger-bg text-danger-fg hover:opacity-90"
              : unwell
                ? "border-warning-border bg-warning-bg text-warning-fg hover:opacity-90"
                : running
                  ? "border-success-border bg-success-bg text-success-fg hover:opacity-90"
                  : "border-border-default bg-surface text-muted hover:bg-surface-muted"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              blocked
                ? "bg-danger-fg ring-4 ring-danger-fg/20"
                : unwell
                  ? "bg-warning-fg ring-4 ring-warning-fg/20"
                  : running
                    ? "bg-success-fg ring-4 ring-success-fg/20"
                    : "bg-muted ring-4 ring-muted/15"
            }`}
            aria-hidden="true"
          />
          {/* The word the owner needs is the PROBLEM, not the count. A chip
              reading "AI running 6/6" beside a dead key is the bug. */}
          {blocked
            ? (health!.reason === "out_of_balance" ? "AI out of credit" : health!.reason === "budget_exhausted" ? "AI cap reached" : "AI not answering")
            : unwell
              ? "AI degraded"
              : running
                ? `AI running ${autoCount}/${AUTONOMY_JOBS.length}`
                : "AI paused"}
        </button>

        {/* Rendered ONLY when something is actually running: a stop button that
            can never do anything is noise on every screen, every day. */}
        {running ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => setConfirmPause(true)}
            title="Stop everything the AI does on its own"
            className="rounded-lg border border-danger-border bg-danger-bg px-2.5 py-1.5 text-xs font-semibold text-danger-fg transition-colors hover:opacity-90 disabled:opacity-45"
          >
            Pause AI
          </button>
        ) : null}
      </div>

      <ConfirmModal
        open={confirmPause}
        onClose={() => setConfirmPause(false)}
        onConfirm={pauseAll}
        title="Pause everything the AI does on its own?"
        confirmLabel="Pause the AI"
        tone="danger"
        loading={saving}
      >
        All four jobs switch to manual: it stops finding leads, planning campaigns, building your
        ideal-customer list, and replying on WhatsApp. Work already in your queue stays there. You
        can switch any of them back on from AI Settings.
      </ConfirmModal>
    </>
  );
}
