/**
 * ai-autonomy-jobs.ts — N-UI-6 (2026-08-31). The four jobs the AI can be
 * allowed to run on its own, named ONCE.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The same four switches were being described in two different vocabularies by
 * two different screens:
 *
 *   AI status card   →  "Finds new leads"   "Plans campaigns"   "Builds
 *                        ideal-customer list"   "Replies on WhatsApp"
 *   AI Settings      →  "Lead Discovery"    "Campaign Planner"  "ICP
 *                        Generator"            "WhatsApp Messages"
 *
 * Same backend field, same effect, two names — so an owner who pauses
 * "Finds new leads" in one place and then looks for it in the other cannot
 * tell whether they are looking at the same switch. Naming a thing twice is
 * how a system teaches its owner to distrust it.
 *
 * Everything that shows these switches now reads this list, so the two can
 * never drift again. The `field` values are the backend's, unchanged.
 */

export type AutonomyJob = {
  /** The field name on /api/agent-autonomous/settings. Not shown to anyone. */
  field: "discoveryMode" | "campaignPlannerMode" | "icpGeneratorMode" | "whatsappMode";
  /** What the AI does, in the owner's language. Never a system noun. */
  label: string;
  /** What actually happens when this is left to the AI. */
  detail: string;
};

export const AUTONOMY_JOBS: AutonomyJob[] = [
  {
    field: "discoveryMode",
    label: "Finds new leads",
    detail: "Searches for businesses that match your ideal customer and adds them to Lead Review.",
  },
  {
    field: "campaignPlannerMode",
    label: "Plans campaigns",
    detail: "Drafts the outreach plan — who to contact, in what order, with what message.",
  },
  {
    field: "icpGeneratorMode",
    label: "Builds your ideal-customer list",
    detail: "Works out which kinds of business are worth approaching, from your own catalogue and past orders.",
  },
  {
    field: "whatsappMode",
    label: "Replies on WhatsApp",
    detail: "Writes the reply to an incoming message. Sending it still waits for your approval.",
  },
];

/** The two settings each job can be in, in plain words rather than jargon. */
export const AUTONOMY_CHOICES = [
  { value: "manual", label: "I decide — ask me first" },
  { value: "automatic", label: "The AI does it on its own" },
];

/**
 * Broadcast that the autonomy settings just changed.
 *
 * WHY: the header chip reads these settings once when it mounts. Change a
 * switch on the AI Settings screen and the chip went on saying "AI paused"
 * while the server already said otherwise — the two screens disagreeing about
 * whether the AI is running unattended, which is the single fact this product
 * must never be vague about. Sharing the LABELS stopped them naming the switch
 * differently; this stops them reporting different VALUES.
 *
 * A DOM event rather than a store: it is one fact, read by two components that
 * never render together, and it needs no history. Guarded for the server render
 * pass, where `window` does not exist.
 */
export const AUTONOMY_CHANGED_EVENT = "leadgen:autonomy-changed";

export function notifyAutonomyChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AUTONOMY_CHANGED_EVENT));
}

/** How many of the four are currently left to the AI. */
export function countAutomatic(settings: Record<string, unknown> | null | undefined): number {
  if (!settings) return 0;
  return AUTONOMY_JOBS.filter((job) => String(settings[job.field] || "manual") === "automatic").length;
}
