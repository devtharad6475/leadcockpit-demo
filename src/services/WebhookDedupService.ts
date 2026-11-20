/**
 * WebhookDedupService — inbound message-id deduplication (Session 6 I-3 fix).
 *
 * THE PROBLEM (audit S6 I-3):
 *   Meta's WhatsApp Cloud webhook contract EXPLICITLY says: "expect duplicate
 *   webhook deliveries; dedup on message.id." Meta retries delivery on any
 *   non-200, any network blip, any slow ack. The previous code processed every
 *   delivery unconditionally, so a single inbound message could create:
 *     - duplicate Reply records
 *     - duplicate AutoReplyLog drafts
 *     - duplicate Tickets (one per inbound complaint)
 *     - DUPLICATE DNC REGISTRATIONS — a customer who re-consented could be
 *       silently re-blocked if a stale webhook replayed after the owner
 *       removed them via /consent/:leadId/remove-dnc.
 *
 * THE FIX (root cause, one chokepoint):
 *   processWhatsAppCloudWebhook calls hasProcessedMessageId() at the top of
 *   its message loop and `continue`s if true; recordProcessedMessageId()
 *   persists the id BEFORE the heavy work. This service is the single place
 *   that owns dedup state, so JSON and Prisma runtimes both go through it.
 *
 * I-6 (Stage 6, 2026-07-30 CLOSED): the dedup log now PERSISTS in BOTH JSON
 * and Prisma runtimes. Previously Prisma's readAll/mutateAll dropped the
 * collection, so production dedup was inactive (a server restart wiped the
 * log). The fix added a ProcessedWebhookMessage Prisma model + migration +
 * readAll/mutateAll wiring. Pinned by golden:webhook-dedup-prisma.
 *
 * The dedup is keyed on (workspaceId, providerMessageId) — Meta's message.id
 * is globally unique, but we scope by workspace for hygiene + so two tenants
 * that somehow share an id (shouldn't happen) don't collide.
 */
import { uid, timestamp } from "@/lib/db";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type ProcessedMessageOutcome = "processed" | "ignored" | "blocked" | "duplicate_skipped";

/** How many dedup entries are kept. Meta retries for minutes to hours, not years. */
const DEDUP_LOG_CAP = 10_000;

/**
 * Returns true iff this providerMessageId has already been processed for the
 * workspace. Call this BEFORE doing any heavy work (LLM, ticket, DNC).
 */
export async function hasProcessedMessageId(
  workspaceId: string,
  providerMessageId: string,
  repos: RepositoryBundle,
): Promise<boolean> {
  if (!providerMessageId) return false;
  // 2026-09-24: one indexed lookup where the substrate offers it. The readAll
  // below loads the whole database on Postgres; it stays only for bundles
  // (test doubles) that have not implemented the lookup.
  if (repos.hasProcessedWebhookMessage) return repos.hasProcessedWebhookMessage(workspaceId, providerMessageId);
  const data = await repos.readAll?.();
  // I-6 (Session 7, 2026-07-28 → CLOSED Stage 6, 2026-07-30): previously, if
  // readAll returned no processedWebhookMessageIds collection (Prisma mode
  // before the fix), dedup silently no-opped + this block fired a loud WARNING.
  // The fix wired ProcessedWebhookMessage into Prisma's readAll + mutateAll +
  // a migration, so both runtimes now persist the dedup log. We still fail
  // LOUDLY if the collection is unexpectedly missing (build-right "No Silent
  // Failures") — that would now indicate a regression, not a known gap.
  if (data && !Array.isArray(data.processedWebhookMessageIds)) {
    console.error(
      "[WebhookDedupService] WARNING: processedWebhookMessageIds is missing from readAll — " +
        "inbound webhook dedup is INACTIVE. This is unexpected (both JSON and Prisma runtimes " +
        "persist it since 2026-07-30) and indicates a regression. Meta duplicate deliveries may " +
        "create duplicate leads/replies/tickets until this is fixed.",
    );
  }
  const seen = (data?.processedWebhookMessageIds || []).some(
    (m) => m.workspaceId === workspaceId && m.providerMessageId === providerMessageId,
  );
  return seen;
}

/**
 * Record that a providerMessageId has been processed. MUST be called before
 * the heavy work so a crash mid-processing still leaves the id recorded (we
 * would rather skip a real message on replay than process it twice).
 *
 * Idempotent: recording the same id twice does not create a duplicate row.
 * Returns true only for the call that recorded it first — the caller that
 * gets true does the work. Two deliveries of one message arriving together
 * both pass hasProcessedMessageId; only one of them gets true here (break
 * test, 2026-09-26).
 */
export async function recordProcessedMessageId(
  workspaceId: string,
  providerMessageId: string,
  outcome: ProcessedMessageOutcome,
  fromPhone: string | undefined,
  repos: RepositoryBundle,
): Promise<boolean> {
  if (!providerMessageId) return true;
  let overCap = false;
  let inserted = false;
  if (repos.recordProcessedWebhookMessage) {
    const result = await repos.recordProcessedWebhookMessage({ workspaceId, providerMessageId, fromPhone, processedAt: timestamp(), outcome });
    if (result.total > DEDUP_LOG_CAP) await repos.trimProcessedWebhookMessages?.(DEDUP_LOG_CAP);
    return result.inserted;
  }
  await repos.mutateAll?.((data) => {
    (data.processedWebhookMessageIds ||= []);
    // Defensive dedup: don't insert a second row for the same id.
    const exists = data.processedWebhookMessageIds.some(
      (m) => m.workspaceId === workspaceId && m.providerMessageId === providerMessageId,
    );
    if (exists) return;
    inserted = true;
    data.processedWebhookMessageIds.push({
      id: uid("whmsg"),
      workspaceId,
      providerMessageId,
      fromPhone,
      processedAt: timestamp(),
      outcome,
    });
    overCap = data.processedWebhookMessageIds.length > DEDUP_LOG_CAP;
  });
  // N-BUG-4 (2026-09-05). The cap used to be a `.slice(-10_000)` on the line
  // above, inside the mutateAll. That trims a JSON array and is discarded whole
  // on Postgres, whose snapshot writer is upsert-only — so the real table has
  // never been trimmed once and grows without bound. The trim now goes through
  // the repository bundle, which deletes on the substrate it is running on.
  // Same rule as before: keep the most recent 10,000, because the dedup window
  // that matters is Meta's retry window — minutes to hours, not years.
  if (overCap) await repos.trimProcessedWebhookMessages?.(DEDUP_LOG_CAP);
  return inserted;
}
