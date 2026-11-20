/**
 * golden-integration-create.ts — N-DATA-2. Pins `IntegrationRepository.create`
 * on BOTH substrates.
 *
 * // HYBRID_GOLDEN — runs one pass on JSON and one on Postgres in the same
 * process, so it needs the JSON isolation preload WITHOUT the provider pin:
 *   npx tsx --import ./scripts/golden/_helpers/isolate-json-data.ts scripts/golden/golden-integration-create.ts
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * `IntegrationRepository` had `listByWorkspace` and `update` and no create, on
 * either substrate. Integration rows only ever appeared via the seeder (which
 * writes the JSON file directly) or `persistSnapshot` (which does not cover
 * `integrations` at all) — so on Postgres there was no supported way to make
 * one. The JSON store holds 17 rows that the N-DATA-2 migration has to move.
 * Found by auditing every `repository`-policy collection for a write path
 * BEFORE writing the executor, rather than discovering the gaps one at a time
 * half way through a migration into the ship database.
 *
 * ─── WHAT IT PINS, AND WHY EACH CASE IS HERE ──────────────────────────────
 *
 * A  round-trip on both substrates — the row is really there afterwards.
 * B  the caller's id is honoured, not replaced by a generated one. The
 *    migration replays ids verbatim; if create invented one, the re-plan check
 *    that PROVES the migration worked (every row must come back `identical`,
 *    keyed on id) would report 1266 creates on a second run instead of zero.
 * C  createdAt / updatedAt are replayed verbatim, not stamped `now()`. Same
 *    reason: a row whose timestamps move on arrival is a row the re-plan check
 *    reports as changed, and it is also simply the wrong data.
 * D  duplicate id is refused on both.
 * E  duplicate provider inside one workspace is refused on both. This is the
 *    parity case that matters: Postgres declares `@@unique([workspaceId,
 *    provider])` and throws; JSON has no constraints of any kind, so without a
 *    hand-written guard the duplicate is ACCEPTED on the substrate the goldens
 *    run on and REJECTED on the substrate we ship on.
 * F  the same provider in a DIFFERENT workspace is allowed. Written because
 *    the obvious way to implement E — check the provider, forget the workspace
 *    — produces a guard that silently blocks every tenant after the first, and
 *    fails in a direction no one tests for.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail: string) {
  if (condition) {
    passed++;
    console.log(`    OK   ${label}`);
  } else {
    failed++;
    console.log(`    FAIL ${label} — ${detail}`);
  }
}

/** Runs a call that MUST throw. Returns the message, or undefined if it did not throw. */
async function expectThrow(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const FIXED_CREATED = "2026-01-02T03:04:05.000Z";
const FIXED_UPDATED = "2026-01-02T03:04:06.000Z";

async function runSubstrate(name: string, repos: RepositoryBundle) {
  const WS = `ws_int_${name}_${RUN}`;
  const WS_OTHER = `ws_int_${name}_other_${RUN}`;
  const ID = `integration_${name}_${RUN}`;

  console.log(`\n  === substrate: ${name} ===`);
  await repos.workspace.create({ id: WS, name: `Integration golden ${name}` });
  await repos.workspace.create({ id: WS_OTHER, name: `Integration golden other ${name}` });

  try {
    // ── A + B + C ────────────────────────────────────────────────────────
    const created = await repos.integration.create(WS, {
      id: ID,
      provider: "whatsapp_cloud",
      status: "not_connected",
      authType: "oauth_or_api_key",
      config: { mvpMode: "placeholder", manualFallback: true },
      createdAt: FIXED_CREATED,
      updatedAt: FIXED_UPDATED,
    });

    const listed = await repos.integration.listByWorkspace(WS);
    const found = listed.find((row) => row.id === ID);

    check(
      `${name} CASE A — the created integration is readable back`,
      !!found,
      `listByWorkspace(${WS}) returned ${listed.length} row(s) and none had id ${ID}`,
    );
    check(
      `${name} CASE A — fields round-trip`,
      found?.provider === "whatsapp_cloud" &&
        found?.status === "not_connected" &&
        found?.authType === "oauth_or_api_key" &&
        found?.config?.mvpMode === "placeholder" &&
        found?.config?.manualFallback === true,
      `got ${JSON.stringify({ provider: found?.provider, status: found?.status, authType: found?.authType, config: found?.config })}`,
    );
    check(
      `${name} CASE B — the caller's id is kept, not regenerated`,
      created.id === ID && found?.id === ID,
      `create returned id ${created.id}`,
    );
    check(
      `${name} CASE C — createdAt/updatedAt are replayed verbatim, not stamped now()`,
      found?.createdAt === FIXED_CREATED && found?.updatedAt === FIXED_UPDATED,
      `got createdAt=${found?.createdAt} updatedAt=${found?.updatedAt}, wanted ${FIXED_CREATED} / ${FIXED_UPDATED}`,
    );

    // ── D ────────────────────────────────────────────────────────────────
    const dupIdError = await expectThrow(() =>
      repos.integration.create(WS, { id: ID, provider: "gmail", config: {} }),
    );
    check(
      `${name} CASE D — a second row with the same id is refused`,
      dupIdError !== undefined,
      "create() returned normally; the duplicate id was accepted",
    );

    // ── E ────────────────────────────────────────────────────────────────
    const dupProviderError = await expectThrow(() =>
      repos.integration.create(WS, { id: `${ID}_dup`, provider: "whatsapp_cloud", config: {} }),
    );
    check(
      `${name} CASE E — a second row for the same provider in the same workspace is refused`,
      dupProviderError !== undefined,
      "create() returned normally — on Postgres this is @@unique([workspaceId, provider]); " +
        "if JSON accepts it, the substrates disagree and only production finds out",
    );

    // ── F ────────────────────────────────────────────────────────────────
    const otherWsId = `${ID}_otherws`;
    let crossTenantError: string | undefined;
    try {
      await repos.integration.create(WS_OTHER, { id: otherWsId, provider: "whatsapp_cloud", config: {} });
    } catch (error) {
      crossTenantError = error instanceof Error ? error.message : String(error);
    }
    const otherListed = await repos.integration.listByWorkspace(WS_OTHER);
    check(
      `${name} CASE F — the same provider in a DIFFERENT workspace is allowed`,
      crossTenantError === undefined && otherListed.some((row) => row.id === otherWsId),
      crossTenantError
        ? `create threw: ${crossTenantError} — the uniqueness guard is missing its workspace filter, which blocks every tenant after the first`
        : `no error, but listByWorkspace(${WS_OTHER}) does not contain ${otherWsId}`,
    );
    check(
      `${name} CASE F — the first workspace still holds exactly its own one row`,
      (await repos.integration.listByWorkspace(WS)).filter((row) => row.id.startsWith(`integration_${name}`)).length === 1,
      // Two different defects land here and the message must not name only one:
      // either CASE F's create leaked across the workspace boundary, or CASE E's
      // duplicate was accepted and survived. Observed during the negative
      // control for this golden — with the JSON uniqueness guard removed, this
      // case went red for the SECOND reason while the message claimed the first.
      "expected exactly 1 row: either the cross-workspace create leaked into this workspace, " +
        "or the CASE E duplicate was accepted and is still here",
    );
  } finally {
    // Both substrates: delete the workspaces. Postgres cascades; the JSON
    // implementation sweeps by hand. Either way nothing of this run survives.
    for (const ws of [WS, WS_OTHER]) {
      try { await repos.workspace.delete(ws); } catch { /* best effort */ }
    }
  }
}

async function main() {
  console.log(`golden-integration-create (run ${RUN})`);

  await runSubstrate("json", createRepositories("json"));
  await runSubstrate("prisma", createRepositories("prisma"));

  console.log("");
  if (failed > 0) {
    console.log(`FAIL golden-integration-create: ${passed} passed, ${failed} failed.`);
    process.exit(1);
  }
  console.log(`PASS golden-integration-create: ${passed} passed, 0 failed — create works and behaves the SAME on both substrates.`);
}

main().catch((error) => {
  console.error("golden-integration-create CRASHED —", error instanceof Error ? error.stack : error);
  process.exit(1);
});
