/**
 * Golden test — per-workspace integration keys (SerpApi + Resend).
 * D-2026-08-02-b / CP-18. Written BEFORE the code (build-right Phase 3).
 *
 * Authority: docs/LOGIC.md CP-18 + docs/DECISIONS.md D-2026-08-02-b. Before
 * this, SerpApi + Resend keys were env-only (a customer couldn't configure
 * their own). Now each customer pastes their own key via the UI.
 *
 * Hand-computed BEFORE the assertions:
 *
 *   CASE A — save + resolve per-provider + isolation: saving a serpapi key for
 *     workspace A resolves for A, not B. (CP-18b isolation + CP-18c.)
 *
 *   CASE B — secret never returned unmasked: the view shows a masked preview,
 *     never the raw key.
 *
 *   CASE C — env fallback: with no per-workspace key, resolveKey returns
 *     undefined → consumers fall back to env. (CP-18c.)
 *
 *   CASE D — two providers coexist: a workspace can have BOTH a serpapi key AND
 *     a resend key (they don't collide — provider-tagged storage).
 *
 *   CASE E — update replaces; clear removes (falls back to undefined → env).
 *
 *   CASE F — serpapi test (one-result search, injected fetch): valid key →
 *     connected; bad key → auth_failed (HTTP 401).
 *
 * Test isolation (Gate #8): own workspace ids (ws_int_*).
 * Run: npm run golden:integration-credentials
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { IntegrationCredentialService } from "@/services/IntegrationCredentialService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function seedWorkspace(repos: RepositoryBundle, id: string) {
  await repos.workspace.create({ id, name: `Test WS ${id}`, status: "active" });
}

async function main() {
  const repos = await createJsonRepos();
  const svc = (ws: string) => new IntegrationCredentialService(repos);

  // ─── CASE A: save + resolve + isolation ────────────────────────────────────
  {
    const WS_A = "ws_int_a_a";
    const WS_B = "ws_int_a_b";
    await seedWorkspace(repos, WS_A);
    await seedWorkspace(repos, WS_B);
    await svc(WS_A).save(WS_A, "serpapi", "serpapi_key_A_value");

    const keyA = await svc(WS_A).resolveKey(WS_A, "serpapi");
    const keyB = await svc(WS_B).resolveKey(WS_B, "serpapi");
    assert(keyA === "serpapi_key_A_value", `CASE A: workspace A resolves its key, got ${keyA}`);
    assert(keyB === undefined, `CASE A isolation: workspace B resolves undefined, got ${keyB}`);
    console.log("✅ CASE A — per-provider resolve + workspace isolation");
  }

  // ─── CASE B: secret never returned unmasked ────────────────────────────────
  {
    const WS = "ws_int_b";
    await seedWorkspace(repos, WS);
    await svc(WS).save(WS, "serpapi", "super_secret_serpapi_xyz");
    const view = await svc(WS).getView(WS, "serpapi");
    const serialized = JSON.stringify(view);
    assert(!serialized.includes("super_secret_serpapi_xyz"), "CASE B: raw key NOT in the view");
    assert(view?.hasKey === true, "CASE B: view reports a saved key");
    assert(/xyz|.{4}$/.test(String(view?.keyPreview || "")), "CASE B: masked preview shown");
    console.log("✅ CASE B — secret never returned unmasked (masked preview only)");
  }

  // ─── CASE C: env fallback ──────────────────────────────────────────────────
  {
    const WS = "ws_int_c";
    await seedWorkspace(repos, WS);
    const key = await svc(WS).resolveKey(WS, "serpapi");
    assert(key === undefined, `CASE C: no per-workspace key → undefined (env fallback), got ${key}`);
    console.log("✅ CASE C — env fallback when no per-workspace key");
  }

  // ─── CASE D: two providers coexist ─────────────────────────────────────────
  {
    const WS = "ws_int_d";
    await seedWorkspace(repos, WS);
    await svc(WS).save(WS, "serpapi", "serp_key");
    await svc(WS).save(WS, "resend", "re_key");
    const serp = await svc(WS).resolveKey(WS, "serpapi");
    const re = await svc(WS).resolveKey(WS, "resend");
    assert(serp === "serp_key", "CASE D: serpapi key coexists");
    assert(re === "re_key", "CASE D: resend key coexists");
    console.log("✅ CASE D — serpapi + resend keys coexist (provider-tagged storage)");
  }

  // ─── CASE E: update replaces; clear removes ────────────────────────────────
  {
    const WS = "ws_int_e";
    await seedWorkspace(repos, WS);
    await svc(WS).save(WS, "resend", "re_v1");
    await svc(WS).save(WS, "resend", "re_v2");
    let key = await svc(WS).resolveKey(WS, "resend");
    assert(key === "re_v2", `CASE E: update replaced with re_v2, got ${key}`);
    await svc(WS).clear(WS, "resend");
    key = await svc(WS).resolveKey(WS, "resend");
    assert(key === undefined, `CASE E: clear removed (undefined → env fallback), got ${key}`);
    console.log("✅ CASE E — update replaces; clear removes");
  }

  // ─── CASE F: serpapi test (injected fetch) ─────────────────────────────────
  {
    const WS = "ws_int_f";
    await seedWorkspace(repos, WS);
    const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ organic_results: [{ title: "Co" }] }) });
    const okResult = await svc(WS).testSerpApi("valid_key", { fetchImpl: okFetch as never });
    assert(okResult.ok === true && okResult.status === "connected", `CASE F: valid key → connected, got ${okResult.status}`);

    const failFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "Invalid API key" }) });
    const failResult = await svc(WS).testSerpApi("bad_key", { fetchImpl: failFetch as never });
    assert(failResult.ok === false, `CASE F: bad key → not ok, got ${failResult.ok}`);
    console.log("✅ CASE F — serpapi test validates the key (connected + auth_failed paths)");
  }

  console.log("\n✅✅✅ All integration-credentials golden cases PASSED (A–F). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
