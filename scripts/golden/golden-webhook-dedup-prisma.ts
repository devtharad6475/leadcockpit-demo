/**
 * golden-webhook-dedup-prisma.ts — I-6 Prisma persistence pin (Stage 6, 2026-07-30).
 *
 * WHY THIS TEST EXISTS:
 *   The JSON-mode dedup contract is pinned by golden:webhook-dedup. But audit I-6
 *   found that in PRISMA mode the dedup collection was silently dropped —
 *   readAll returned no `processedWebhookMessageIds` + persistSnapshot never
 *   wrote them. So in production (Postgres) a server restart wiped the dedup
 *   log, and Meta's duplicate webhook deliveries could create duplicate
 *   leads/replies/tickets/DNC registrations. This golden pins the Prisma path.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — record then has: after recordProcessedMessageId, the SAME id is
 *     "seen" (round-trips through real Postgres, not just in-memory).
 *   CASE B — survives a fresh repository: a NEW createRepositories("prisma")
 *     bundle still sees the id (proves it PERSISTED to the DB, not memory).
 *   CASE C — workspace-scoped: id seen in WS_A is NOT seen in WS_B.
 *   CASE D — idempotent: recording twice does NOT create a duplicate row.
 *   CASE E — the WARNING is GONE (dedup is active; no console.error emitted).
 *
 * ISOLATION (build-right Gate #8): each run uses a unique RUN-tagged workspace
 * pair + cleans up its rows at the end so no debris is left for other tests.
 *
 * Env-gated: requires DATABASE_URL (real Neon). Same pattern as the other
 * prisma:* goldens. Run: `npm run golden:webhook-dedup-prisma`
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts: this is a
 * PERSISTENCE golden that needs `.env`'s DATABASE_URL (real Postgres). The suite
 * runner does NOT force JSON for it (unlike logic goldens).
 */
import assert from "node:assert";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { prisma } from "@/lib/prisma";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
// These workspace ids must exist as Workspace rows for the FK constraint. We
// create them via mutateAll (workspace create is idempotent-by-id upsert) and
// tear them down at the end.
const WS_A = `ws_golden_dedup_prisma_a_${RUN}`;
const WS_B = `ws_golden_dedup_prisma_b_${RUN}`;
const MSG = `wamid.golden.${RUN}`;

async function ensureWorkspaces(repos: RepositoryBundle) {
  // persistSnapshot does NOT write workspaces (they use the dedicated repo), so
  // we must create them via repos.workspace.create() to satisfy the FK on
  // processed_webhook_messages. Idempotent: skip if already present.
  for (const id of [WS_A, WS_B]) {
    const existing = await repos.workspace.getById(id);
    if (!existing) {
      await repos.workspace.create({
        id,
        name: `Golden Dedup Prisma ${id}`,
        status: "active",
        autonomyKillSwitch: false,
        autoSendToggle: false,
      });
    }
  }
}

async function cleanup(repos: RepositoryBundle) {
  // Gate #8 (test isolation): remove the dedup rows for these workspaces so the
  // table doesn't grow across runs. We clear via mutateAll (writes the filtered
  // list back) AND additionally hard-delete the workspace rows (cascade-deletes
  // any orphaned dedup rows via the FK). Both best-effort; the cascade is the
  // reliable path because mutateAll's readAll may be a cached snapshot.
  try {
    await repos.mutateAll?.((data) => {
      data.processedWebhookMessageIds = (data.processedWebhookMessageIds || []).filter(
        (m) => m.workspaceId !== WS_A && m.workspaceId !== WS_B,
      );
    });
  } catch {
    /* best effort */
  }
  // Hard-delete the workspace rows: the onDelete: Cascade on the dedup table
  // wipes any leftover dedup rows for these workspaces.
  for (const id of [WS_A, WS_B]) {
    try {
      await (prisma as unknown as { workspace: { deleteMany: (args: unknown) => Promise<unknown> } }).workspace.deleteMany({ where: { id } });
    } catch {
      /* best effort — Neon may be unreachable in some envs */
    }
  }
}

async function main() {
  const { hasProcessedMessageId, recordProcessedMessageId } = await import("@/services/WebhookDedupService");
  const repos = createRepositories("prisma");
  await ensureWorkspaces(repos);

  const dedupRows = async (ws: string) =>
    ((await repos.readAll?.())?.processedWebhookMessageIds || []).filter((m) => m.workspaceId === ws);

  let failures = 0;
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`  ✅ ${name}`);
    } catch (e) {
      console.log(`  ❌ ${name}`);
      console.log(`     ${(e as Error).message}`);
      failures++;
    }
  };

  try {
    console.log("golden-webhook-dedup-prisma — I-6 Prisma dedup persistence\n");

    // CASE A — record then has (round-trips through real Postgres).
    await recordProcessedMessageId(WS_A, MSG, "processed", "+910000000013", repos);
    const seenA = await hasProcessedMessageId(WS_A, MSG, repos);
    check("CASE A — after record, has() returns true (persisted round-trip)", () => assert.strictEqual(seenA, true));

    // CASE B — survives a fresh repository bundle (proves DB persistence, not memory).
    const freshRepos = createRepositories("prisma");
    const seenB = await hasProcessedMessageId(WS_A, MSG, freshRepos);
    check("CASE B — a NEW repo bundle still sees the id (persisted to DB, not memory)", () => assert.strictEqual(seenB, true));

    // CASE C — workspace-scoped: WS_B does NOT see WS_A's id.
    const seenC = await hasProcessedMessageId(WS_B, MSG, repos);
    check("CASE C — workspace-scoped (id in WS_A is NOT seen in WS_B)", () => assert.strictEqual(seenC, false));

    // CASE D — idempotent: record twice, still exactly 1 row for this id.
    await recordProcessedMessageId(WS_A, MSG, "processed", "+910000000013", repos);
    const rowsForId = (await dedupRows(WS_A)).filter((m) => m.providerMessageId === MSG);
    check("CASE D — recording twice creates exactly 1 row (idempotent)", () => assert.strictEqual(rowsForId.length, 1));

    // CASE E — the WARNING is gone: readAll now returns an ARRAY (dedup active).
    const data = await repos.readAll?.();
    check("CASE E — readAll returns an Array for processedWebhookMessageIds (WARNING condition gone)", () => {
      assert.ok(Array.isArray(data?.processedWebhookMessageIds), "expected an array — the I-6 WARNING condition would fire if this is undefined");
    });

    // CASE F (2026-09-24) — the check and the record never load or rewrite the
    // whole database. They used to call readAll / mutateAll, which on Postgres
    // read every table of every workspace once per incoming WhatsApp message.
    const guarded = new Proxy(repos, {
      get(target, prop, receiver) {
        if (prop === "readAll" || prop === "mutateAll") {
          return () => { throw new Error(`dedup called ${String(prop)} — whole-database access per message`); };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as RepositoryBundle;
    const MSG_F = `${MSG}_f`;
    let fError: unknown;
    let seenF: boolean | undefined;
    try {
      await recordProcessedMessageId(WS_A, MSG_F, "processed", "+910000000014", guarded);
      seenF = await hasProcessedMessageId(WS_A, MSG_F, guarded);
    } catch (e) { fError = e; }
    check("CASE F — dedup uses one indexed query, never a whole-database read or rewrite", () => {
      assert.strictEqual(fError, undefined, String(fError));
      assert.strictEqual(seenF, true);
    });

    // CASE G (2026-09-24) — two deliveries of the same message at the same
    // instant still leave exactly one row: the unique index decides, and the
    // loser is a quiet no-op, not an error.
    const MSG_G = `${MSG}_g`;
    const both = await Promise.allSettled([
      recordProcessedMessageId(WS_A, MSG_G, "processed", undefined, repos),
      recordProcessedMessageId(WS_A, MSG_G, "processed", undefined, repos),
    ]);
    const rowsG = (await dedupRows(WS_A)).filter((m) => m.providerMessageId === MSG_G);
    check("CASE G — a simultaneous double delivery records one row and throws nothing", () => {
      assert.deepStrictEqual(both.map((r) => r.status), ["fulfilled", "fulfilled"]);
      assert.strictEqual(rowsG.length, 1);
    });

    if (failures === 0) {
      console.log("\n✅ golden-webhook-dedup-prisma ALL GREEN ✅");
      console.log("  I-6 CLOSED: webhook dedup now persists in Prisma mode.");
      console.log("  A server restart no longer wipes the dedup log.");
    } else {
      console.log(`\n❌ ${failures} case(s) FAILED`);
    }
  } finally {
    await cleanup(repos);
  }
  // 2026-08-02 audit fix: explicit exit (matching every other Prisma golden —
  // prisma-commercial-parity, prisma-stage5-mappers, credential-session-version-
  // prisma, prisma-field-clearing). Without it Prisma's open connection pool
  // keeps the Node event loop alive and the test "hangs" past all-green, which
  // a CI timeout kills as a spurious failure (the suite saw this as exit 124).
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  } catch {
    /* best-effort disconnect */
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
