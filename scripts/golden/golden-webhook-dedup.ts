/**
 * golden-webhook-dedup.ts — WebhookDedupService contract pin (Session 7, 2026-07-28).
 *
 * WHY THIS TEST EXISTS:
 *   WebhookDedupService was DARK (the caller WhatsAppWebhookService IS tested via
 *   golden:webhook-replay-dedup, but the service's own contract had no direct
 *   test). It is the chokepoint that stops Meta's duplicate webhook deliveries
 *   from creating duplicate leads/replies/tickets/DNC registrations (Session 6
 *   I-3). This golden pins the service's own behavior directly.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — hasProcessedMessageId: a freshly-seeded id is "seen"; an unseen id
 *     is not. Workspace-scoped (id seen in WS_A is NOT seen in WS_B).
 *   CASE B — recordProcessedMessageId then hasProcessedMessageId: the SAME id
 *     becomes seen (round-trip).
 *   CASE C — idempotency: recording the SAME (workspaceId, providerMessageId)
 *     twice does NOT create a duplicate row (count unchanged).
 *   CASE D — the 10,000-row cap: the store trims to the newest 10,000 (a flood
 *     of unique ids never grows unbounded).
 *   CASE E — outcome is recorded ("processed" / "duplicate_skipped" / etc.).
 *   CASE F — the "dedup is INACTIVE" warning is still armed, and no longer
 *     fires on a healthy store. It used to fire on every store that had not
 *     yet processed a webhook, which is exactly when dedup has nothing to do.
 *
 * I-6 (Session 7): this golden proves the JSON-mode contract. The Prisma path
 * requires a ProcessedWebhookMessage Prisma model + readAll/mutateAll wiring
 * (separately tracked) — without it, dedup silently no-ops in production. This
 * test documents that the JSON contract is correct so the Prisma fix has a
 * clear spec to match.
 *
 * Run: `npm run golden:webhook-dedup`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readSource } from "./_helpers/read-source";
import { createRepositories, type RepositoryBundle } from "@/repositories";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS_A = `ws_golden_dedup_a_${RUN}`;
const WS_B = `ws_golden_dedup_b_${RUN}`;

async function cleanup(repos: RepositoryBundle, ...ws: string[]) {
  // Best-effort: clear the dedup rows for these workspaces.
  try {
    await repos.mutateAll?.((data) => {
      data.processedWebhookMessageIds = (data.processedWebhookMessageIds || []).filter(
        (m) => !ws.includes(m.workspaceId),
      );
    });
  } catch { /* best effort */ }
}

async function main() {
  const { hasProcessedMessageId, recordProcessedMessageId } = await import("@/services/WebhookDedupService");
  const repos = createRepositories("json");
  // NOTE: signature is recordProcessedMessageId(workspaceId, providerMessageId,
  // outcome, fromPhone, repos) — outcome BEFORE fromPhone (verified from source).

  // Safe accessor: readAll is optional on the bundle; guard the undefined case.
  const dedupRows = async () => (await repos.readAll?.())?.processedWebhookMessageIds ?? [];

  // CASE A — hasProcessedMessageId is workspace-scoped + correct.
  {
    await recordProcessedMessageId(WS_A, "wamid.AAA", "processed", "+919999999999", repos);
    const seenA = await hasProcessedMessageId(WS_A, "wamid.AAA", repos);
    assert.strictEqual(seenA, true, "CASE A: seeded id is seen in its workspace");
    const seenB = await hasProcessedMessageId(WS_B, "wamid.AAA", repos);
    assert.strictEqual(seenB, false, "CASE A: same id is NOT seen in a different workspace (scoped)");
    const unseen = await hasProcessedMessageId(WS_A, "wamid.UNSEEN", repos);
    assert.strictEqual(unseen, false, "CASE A: an unseeded id is not seen");
    console.log("  CASE A OK: hasProcessedMessageId is correct + workspace-scoped.");
  }

  // CASE B — round-trip: record then has-seen.
  {
    const before = await hasProcessedMessageId(WS_A, "wamid.BBB", repos);
    assert.strictEqual(before, false, "CASE B: not seen before recording");
    await recordProcessedMessageId(WS_A, "wamid.BBB", "processed", "+918888888888", repos);
    const after = await hasProcessedMessageId(WS_A, "wamid.BBB", repos);
    assert.strictEqual(after, true, "CASE B: seen after recording (round-trip)");
    console.log("  CASE B OK: record→has-seen round-trip works.");
  }

  // CASE C — idempotency: recording the same (ws, id) twice creates ONE row.
  {
    await recordProcessedMessageId(WS_A, "wamid.CCC", "processed", "+917777777777", repos);
    const countAfterFirst = (await dedupRows()).filter(
      (m) => m.workspaceId === WS_A && m.providerMessageId === "wamid.CCC",
    ).length;
    await recordProcessedMessageId(WS_A, "wamid.CCC", "duplicate_skipped", "+917777777777", repos);
    const countAfterSecond = (await dedupRows()).filter(
      (m) => m.workspaceId === WS_A && m.providerMessageId === "wamid.CCC",
    ).length ?? 0;
    assert.strictEqual(countAfterFirst, 1, "CASE C: one row after first record");
    assert.strictEqual(countAfterSecond, 1, `CASE C: still ONE row after duplicate record (idempotent), got ${countAfterSecond}`);
    console.log("  CASE C OK: duplicate record is idempotent (no duplicate row).");
  }

  // CASE D — the dedup log really trims, and keeps the NEWEST entries.
  //
  // 2026-09-05 (N-BUG-4). This case used to be a STATIC proof: it read this
  // service's own source and grepped it for `slice(-10_000)` and
  // `length > 10_000`. That is a check on the SHAPE of one line of code, and
  // the shape it insisted on was the broken one — `.slice()` trims a JavaScript
  // array, and on the Postgres substrate that array is a throwaway copy whose
  // removals are discarded by an upsert-only writer. So this golden was green
  // for as long as the production table was never trimmed at all, and would
  // have gone RED the moment anyone fixed it. It did.
  //
  // A source grep cannot tell the two apart, so this is now a runtime proof.
  // The cap is a parameter, so the behaviour is provable with five rows instead
  // of the 10,002 that made a runtime proof impractical before. The production
  // number is asserted separately, because a small-N test cannot exercise it.
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/services/WebhookDedupService.ts"), "utf8");
    assert.ok(/DEDUP_LOG_CAP\s*=\s*10[_\s]*000/.test(src), "CASE D: the production cap is still 10,000");
    assert.ok(/length\s*>\s*DEDUP_LOG_CAP/.test(src), "CASE D: the trim fires when the log EXCEEDS the cap, so exactly 10,000 is allowed");

    for (let index = 0; index < 5; index++) {
      await recordProcessedMessageId(WS_B, `wamid.CAP.${index}`, "processed", undefined, repos);
    }
    const seeded = (await dedupRows()).filter((m) => m.workspaceId === WS_B);
    assert.strictEqual(seeded.length, 5, `CASE D: five rows have to be stored before trimming proves anything, got ${seeded.length}`);

    const removed = await repos.trimProcessedWebhookMessages!(2);
    assert.ok(removed >= 3, `CASE D: the trim must report what it removed, got ${removed}`);

    const kept = (await dedupRows()).filter((m) => m.workspaceId === WS_B).map((m) => m.providerMessageId);
    assert.strictEqual(kept.length, 2, `CASE D: trimming to 2 must leave 2 rows, got ${kept.length}`);
    assert.ok(kept.includes("wamid.CAP.4"), "CASE D: the NEWEST entry must survive — a cap that kept the oldest would forget exactly the messages Meta is still retrying");
    assert.ok(!kept.includes("wamid.CAP.0"), "CASE D: the OLDEST entry must be the one dropped");
    console.log("  CASE D OK: the log really trims to the newest N, and the production cap is still 10,000.");
  }

  // CASE E — outcome + fromPhone + processedAt are recorded.
  {
    await recordProcessedMessageId(WS_A, "wamid.EEE", "blocked", "+916666666666", repos);
    const row = (await dedupRows()).find(
      (m) => m.workspaceId === WS_A && m.providerMessageId === "wamid.EEE",
    );
    assert.ok(row, "CASE E: row exists");
    assert.strictEqual(row.outcome, "blocked", `CASE E: outcome recorded as "blocked", got "${row.outcome}"`);
    assert.strictEqual(row.fromPhone, "+916666666666", "CASE E: fromPhone recorded");
    assert.ok(row.processedAt, "CASE E: processedAt recorded");
    console.log("  CASE E OK: outcome + fromPhone + processedAt recorded.");
  }

  // CASE F — the "dedup is INACTIVE" warning must be TRUE when it fires.
  //
  // 2026-09-08. hasProcessedMessageId logs "inbound webhook dedup is INACTIVE
  // ... indicates a regression" whenever readAll() returns something that is
  // not an array. JSON's readAll is readData(), and readData did not initialise
  // this collection: a store that had simply never processed a webhook printed
  // that warning on every call, while dedup was in fact working (the first
  // delivery has nothing to match, and the write creates the array).
  //
  // A false alarm on the loudest line in the service is not cosmetic. On
  // Postgres the same message means Meta's retries are creating duplicate
  // leads, replies, tickets and DNC re-blocks — and an operator who has learned
  // to scroll past it will scroll past that one too.
  //
  // The obvious wrong fix is to delete the warning, which is why this case
  // asserts the warning still exists and still guards the same condition.
  {
    const db = readSource("src/lib/db.ts");
    const shapeAt = db.indexOf("function ensureDataShape");
    assert.ok(shapeAt > 0, "CASE F: ensureDataShape must still exist — this case reads it");
    assert.ok(
      db.indexOf("data.processedWebhookMessageIds ||= [];", shapeAt) > shapeAt,
      "CASE F: ensureDataShape must initialise processedWebhookMessageIds, or every store that has not yet seen a webhook is reported as a regression",
    );
    assert.ok(
      !db.includes("      return structuredClone(seedData);"),
      "CASE F: the fresh-store returns must go through ensureDataShape too, or a brand-new store is the one case that skips normalisation",
    );

    const svc = readSource("src/services/WebhookDedupService.ts");
    assert.ok(
      svc.includes("!Array.isArray(data.processedWebhookMessageIds)") && svc.includes("dedup is INACTIVE"),
      "CASE F: the warning must still be present and still guard the same condition — the fix was to make it true, not to silence it",
    );

    // And behaviourally: a healthy dedup cycle must not emit it.
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      await hasProcessedMessageId(WS_A, "wamid.QUIET", repos);
      await recordProcessedMessageId(WS_A, "wamid.QUIET", "processed", undefined, repos);
      await hasProcessedMessageId(WS_A, "wamid.QUIET", repos);
    } finally {
      console.error = realError;
    }
    assert.deepStrictEqual(
      errors.filter((e) => e.includes("INACTIVE")),
      [],
      `CASE F: a working dedup cycle must not claim it is inactive, got: ${errors.join(" | ")}`,
    );
    console.log("  CASE F OK: the INACTIVE warning is still armed, and no longer fires on a healthy store.");
  }

  await cleanup(repos, WS_A, WS_B);
  console.log("\nPASS golden-webhook-dedup: WebhookDedupService contract pinned (scoped + round-trip + idempotent + 10k cap + outcome + honest INACTIVE warning).");
}

main().catch((err) => {
  console.error("\nFAIL golden-webhook-dedup:", err.message);
  process.exit(1);
});
