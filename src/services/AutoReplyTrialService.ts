/**
 * D-2026-09-27-b (CEO) — automatic replies to customers who message first.
 *
 * Which kinds of question the AI may answer by itself, and the trial record
 * that decides whether a kind is proven. Plan: docs/planning/AUTO-REPLY-PLAN.md.
 *
 *   - Only the TICKABLE kinds can ever be switched on. Everything else —
 *     price, payment, delivery, returns, complaints, abuse, custom orders,
 *     export, bulk/hot orders, opt-outs, anything unknown — is locked
 *     (AGENTS.md "Sensitive topics require human review").
 *   - A kind is PROVEN when the owner reviewed at least TRIAL_MIN_REVIEWED
 *     AI drafts of that kind in the last TRIAL_WINDOW_DAYS days and sent at
 *     least TRIAL_MIN_UNCHANGED_SHARE of them without changing a word. The
 *     approve path already records an edit (`ownerEdited`, N5), so the trial
 *     is simply the approval queue the owner uses today.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, AutoReplyPause, WhatsAppAgentSettings } from "@/lib/types";
import { NeedsActionError } from "@/lib/user-errors";
import { displayReplyClassification } from "@/lib/display-labels";

export const AUTO_REPLY_TOPICS = [
  "greeting",
  "catalogue_request",
  "location_question",
  "moq_request",
  "sample_request",
] as const;
export type AutoReplyTopic = (typeof AUTO_REPLY_TOPICS)[number];

export const TRIAL_MIN_REVIEWED = 10;
export const TRIAL_MIN_UNCHANGED_SHARE = 0.9;
export const TRIAL_WINDOW_DAYS = 60;

/**
 * The master switch: automatic mode AND at least one kind ticked. Only then
 * does an incoming webhook allow a real send at all; decideAutoReply still
 * judges every single message.
 */
export function autoRepliesSwitchedOn(settings: Pick<WhatsAppAgentSettings, "enabled" | "mode" | "autoReplyTopics"> | undefined): boolean {
  if (!settings?.enabled) return false;
  if (settings.mode !== "safe_auto_reply" && settings.mode !== "automatic") return false;
  return (settings.autoReplyTopics ?? []).some(isAutoReplyTopic);
}

export function isAutoReplyTopic(value: string): value is AutoReplyTopic {
  return (AUTO_REPLY_TOPICS as readonly string[]).includes(value);
}

export type TopicTrialRecord = {
  topic: AutoReplyTopic;
  /** Drafts the owner acted on (sent or rejected) in the window. */
  reviewed: number;
  sentUnchanged: number;
  sentChanged: number;
  rejected: number;
  /** Replies this kind already sent by itself in the window. */
  sentByAi: number;
  proven: boolean;
};

/**
 * Pure: the trial record for every tickable kind, from the reply logs.
 * Automatic sends are not counted as reviewed — only the owner's own decisions
 * are evidence.
 */
export function computeTrialRecords(logs: AutoReplyLog[], now: Date = new Date(), pauses: AutoReplyPause[] = []): TopicTrialRecord[] {
  const since = now.getTime() - TRIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return AUTO_REPLY_TOPICS.map((topic) => {
    let sentUnchanged = 0;
    let sentChanged = 0;
    let rejected = 0;
    let sentByAi = 0;
    // 2026-09-28 — a kind the system switched off after a bad result starts a
    // fresh trial: only drafts made after the switch-off count.
    const pausedAt = Date.parse(pauses.find((p) => p.topic === topic)?.pausedAt || "");
    const from = Number.isFinite(pausedAt) ? Math.max(since, pausedAt) : since;
    for (const log of logs) {
      if (logCategory(log) !== topic) continue;
      // 2026-09-27 (review A3): the draft's own date, not updatedAt — adding an
      // internal note bumped updatedAt and pulled an old approval back into the
      // window.
      const when = Date.parse(log.createdAt || log.updatedAt || "");
      if (!Number.isFinite(when) || when < from) continue;
      // 2026-09-28 — the owner's mark on an automatic reply IS the owner's
      // decision, so it is evidence: "looked fine" counts as sent unchanged,
      // "should not have sent" counts as a rejection.
      if (log.status === "auto_sent" && log.ownerVerdict === "should_not_have_sent") { sentByAi++; rejected++; continue; }
      if (log.status === "auto_sent" && log.ownerVerdict === "looked_fine") { sentByAi++; sentUnchanged++; continue; }
      if (log.status === "auto_sent") sentByAi++;
      // 2026-09-27 (review W9): an approval that never reached the customer
      // (the 24-hour window was closed, the send failed) is not evidence.
      else if (log.status === "approved" && log.sendStatus !== "blocked" && log.sendStatus !== "failed") (log.ownerEdited ? sentChanged++ : sentUnchanged++);
      else if (log.status === "rejected") rejected++;
    }
    const reviewed = sentUnchanged + sentChanged + rejected;
    const proven = reviewed >= TRIAL_MIN_REVIEWED && sentUnchanged / reviewed >= TRIAL_MIN_UNCHANGED_SHARE;
    return { topic, reviewed, sentUnchanged, sentChanged, rejected, sentByAi, proven };
  });
}

/** The kind the send decision used (newer logs), else the stored classification. */
export function logCategory(log: AutoReplyLog): string | undefined {
  const decided = log.retrievedContext?.decisionCategory;
  return typeof decided === "string" && decided ? decided : log.classification;
}

export async function getTrialRecords(workspaceId: string, repos: RepositoryBundle, now: Date = new Date()): Promise<TopicTrialRecord[]> {
  const settings = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
  return computeTrialRecords(await repos.autoReplyLog.listByWorkspace(workspaceId), now, settings?.autoReplyPaused ?? []);
}

/**
 * The owner's ticked kinds, checked: unknown or locked kinds are refused, and
 * a kind can only be newly switched on once the trial proves it. A kind that
 * was already on stays allowed (the owner is not locked out of a saved choice
 * by a quiet month).
 */
export async function validateAutoReplyTopics(
  workspaceId: string,
  requested: unknown,
  alreadyOn: string[],
  repos: RepositoryBundle,
): Promise<AutoReplyTopic[]> {
  if (!Array.isArray(requested)) return alreadyOn.filter(isAutoReplyTopic);
  const wanted = [...new Set(requested.map((value) => String(value)))];
  const locked = wanted.filter((value) => !isAutoReplyTopic(value));
  if (locked.length) {
    throw new NeedsActionError("That kind of question always waits for you — the AI can't answer it by itself.", 400);
  }
  const records = await getTrialRecords(workspaceId, repos);
  const notProven = wanted.filter((topic) => !alreadyOn.includes(topic) && !records.find((record) => record.topic === topic)?.proven);
  const paused = ((await repos.whatsAppAgentSettings.getByWorkspace(workspaceId))?.autoReplyPaused ?? [])
    .filter((p) => notProven.includes(p.topic));
  if (paused.length) {
    throw new NeedsActionError(
      `The system switched "${topicLabel(paused[0].topic)}" off: ${paused[0].reason} It can reply by itself again after a fresh trial — ${TRIAL_MIN_REVIEWED} drafts reviewed since then, ${Math.round(TRIAL_MIN_UNCHANGED_SHARE * 100)}% sent without changes.`,
      400,
    );
  }
  if (notProven.length) {
    throw new NeedsActionError(
      `Review at least ${TRIAL_MIN_REVIEWED} AI drafts of this kind first, and send ${Math.round(TRIAL_MIN_UNCHANGED_SHARE * 100)}% of them without changes — then it can reply by itself.`,
      400,
    );
  }
  return wanted as AutoReplyTopic[];
}

/**
 * How many replies the AI has sent by itself to this customer since the owner
 * last acted in the conversation (sent or rejected a draft). Drafts still
 * waiting do not reset the count — otherwise a held message between two
 * automatic ones would let the AI carry on past the cap.
 */
export function automaticRepliesInARow(logsForLead: AutoReplyLog[]): number {
  const newestFirst = [...logsForLead].sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
  let count = 0;
  for (const log of newestFirst) {
    if (log.status === "approved" || log.status === "rejected") break;
    if (log.status === "auto_sent") count++;
  }
  return count;
}

// ───────────────────────────────────────────────────────────────────────────
// 2026-09-28 — trial de-proving (review 2026-09-27 §1 proposal 5).
//
// A kind proven in the trial is switched off again, for that company only,
// when a real result says the automatic replies went wrong:
//   - the customer complains, or asks not to be contacted, within
//     DEPROVE_WINDOW_DAYS after an automatic reply of that kind; or
//   - the owner marks an automatic reply of that kind "should not have sent"
//     (no time limit — the owner is judging that exact reply).
// Only a kind that is still ticked is switched off. The owner is told why in
// "Needs you"; ticking it again needs a fresh trial counted from the
// switch-off (computeTrialRecords). Nothing here ever sends anything.
// ───────────────────────────────────────────────────────────────────────────

export const DEPROVE_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

export function topicLabel(topic: string): string {
  return displayReplyClassification(topic).toLowerCase();
}

/**
 * Pure: the ticked kinds this customer's automatic replies in the
 * DEPROVE_WINDOW_DAYS before `at` belong to, with the replies as evidence.
 */
export function kindsToSwitchOff(logsForLead: AutoReplyLog[], ticked: string[], at: Date): Map<string, AutoReplyLog[]> {
  const out = new Map<string, AutoReplyLog[]>();
  const from = at.getTime() - DEPROVE_WINDOW_DAYS * DAY_MS;
  for (const log of logsForLead) {
    if (log.status !== "auto_sent") continue;
    const when = Date.parse(log.createdAt || "");
    if (!Number.isFinite(when) || when < from || when > at.getTime()) continue;
    const topic = logCategory(log);
    if (!topic || !ticked.includes(topic)) continue;
    out.set(topic, [...(out.get(topic) ?? []), log]);
  }
  return out;
}

function daysPhrase(fromIso: string, to: Date): string {
  const days = Math.max(0, Math.floor((to.getTime() - Date.parse(fromIso)) / DAY_MS));
  return days === 0 ? "the same day as" : `${days} day${days === 1 ? "" : "s"} after`;
}

async function applyPauses(workspaceId: string, settings: WhatsAppAgentSettings, pauses: AutoReplyPause[], repos: RepositoryBundle): Promise<AutoReplyPause[]> {
  if (!pauses.length) return [];
  const topics = new Set(pauses.map((p) => p.topic));
  await repos.whatsAppAgentSettings.upsertForWorkspace(workspaceId, {
    ...settings,
    autoReplyTopics: (settings.autoReplyTopics ?? []).filter((t) => !topics.has(t)),
    autoReplyPaused: [...(settings.autoReplyPaused ?? []).filter((p) => !topics.has(p.topic)), ...pauses],
  });
  for (const pause of pauses) {
    try {
      await repos.auditLog.create({
        workspaceId,
        eventType: "auto_reply.kind_switched_off",
        actorUserId: "system",
        entityType: "whatsapp_agent_settings",
        entityId: pause.topic,
        payload: pause as unknown as Record<string, unknown>,
      });
    } catch (error) {
      // The kind is already off; a failed audit write must not undo that.
      console.warn(`[auto-reply-trial] audit write failed for switch-off of ${pause.topic}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return pauses;
}

/**
 * A complaint or an opt-out from this customer: switch off every ticked kind
 * the AI answered by itself for them in the last DEPROVE_WINDOW_DAYS days.
 * Never throws (it runs inside the inbound message path).
 */
export async function switchOffAfterBadResult(
  workspaceId: string,
  input: { leadId: string; trigger: "complaint" | "opted_out"; at?: string },
  repos: RepositoryBundle,
): Promise<AutoReplyPause[]> {
  try {
    const settings = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
    const ticked = (settings?.autoReplyTopics ?? []).filter(isAutoReplyTopic);
    if (!settings || !ticked.length) return [];
    const at = input.at ? new Date(input.at) : new Date();
    const found = kindsToSwitchOff(await repos.autoReplyLog.listByLead(workspaceId, input.leadId), ticked, at);
    const pauses: AutoReplyPause[] = [...found].map(([topic, logs]) => {
      const latest = logs.map((l) => l.createdAt).sort().at(-1) || at.toISOString();
      const what = input.trigger === "complaint" ? "A customer complained" : "A customer asked not to be contacted";
      return {
        topic,
        pausedAt: at.toISOString(),
        trigger: input.trigger,
        reason: `${what} ${daysPhrase(latest, at)} the AI answered their ${topicLabel(topic)} by itself.`,
        leadId: input.leadId,
        evidenceLogIds: logs.map((l) => l.id),
      };
    });
    return await applyPauses(workspaceId, settings, pauses, repos);
  } catch (error) {
    console.warn(`[auto-reply-trial] switch-off after a bad result failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * The owner's mark on a reply the AI sent by itself. "should_not_have_sent"
 * switches that kind off if it is still ticked; either mark feeds the trial.
 */
export async function markAutomaticReply(
  workspaceId: string,
  logId: string,
  verdict: unknown,
  repos: RepositoryBundle,
  now: Date = new Date(),
): Promise<{ log: AutoReplyLog; switchedOff: AutoReplyPause[] }> {
  if (verdict !== "looked_fine" && verdict !== "should_not_have_sent") {
    throw new NeedsActionError("Choose \"looked fine\" or \"should not have sent\".", 400);
  }
  const log = await repos.autoReplyLog.getById(workspaceId, logId);
  if (!log) throw new NeedsActionError("That reply no longer exists.", 404);
  if (log.status !== "auto_sent") {
    throw new NeedsActionError("Only replies the AI sent by itself can be marked this way.", 409);
  }
  const updated = await repos.autoReplyLog.setOwnerVerdict(workspaceId, logId, verdict, now.toISOString());
  if (verdict !== "should_not_have_sent") return { log: updated, switchedOff: [] };
  const topic = logCategory(log);
  const settings = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
  if (!settings || !topic || !(settings.autoReplyTopics ?? []).includes(topic)) return { log: updated, switchedOff: [] };
  const switchedOff = await applyPauses(workspaceId, settings, [{
    topic,
    pausedAt: now.toISOString(),
    trigger: "owner_marked",
    reason: `You marked an automatic reply to a ${topicLabel(topic)} "should not have sent".`,
    leadId: log.leadId,
    evidenceLogIds: [log.id],
  }], repos);
  return { log: updated, switchedOff };
}

/** The owner has read the "switched off" notice. */
export async function acknowledgePause(workspaceId: string, topic: string, repos: RepositoryBundle): Promise<AutoReplyPause | undefined> {
  const settings = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
  const pause = settings?.autoReplyPaused?.find((p) => p.topic === topic);
  if (!settings || !pause) throw new NeedsActionError("That notice is no longer there.", 404);
  if (pause.seenAt) return pause;
  const seen = { ...pause, seenAt: new Date().toISOString() };
  await repos.whatsAppAgentSettings.upsertForWorkspace(workspaceId, {
    ...settings,
    autoReplyPaused: (settings.autoReplyPaused ?? []).map((p) => (p.topic === topic ? seen : p)),
  });
  return seen;
}
