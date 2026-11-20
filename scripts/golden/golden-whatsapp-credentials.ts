/**
 * Golden test — per-workspace WhatsApp Cloud credentials (D-2026-08-02 / CP-17).
 *
 * build-right Phase 3 — written BEFORE the code. Defines the contract.
 *
 * Authority: docs/LOGIC.md CP-17 + docs/DECISIONS.md D-2026-08-02. Before this,
 * WhatsApp creds were env-only (the UI told customers to "edit your .env" — a
 * dead-end on a hosted SaaS). Now a customer/operator can paste their own creds
 * into the workspace via the UI, encrypted at rest, and the provider uses them
 * per-workspace (env stays as fallback).
 *
 * Hand-computed BEFORE the assertions (the Golden Thread):
 *
 *   CASE A — save + isConfigured: saving per-workspace creds makes the provider
 *     configured FOR THAT workspace. Another workspace (no creds) stays
 *     unconfigured. (CP-17b isolation + CP-17c override.)
 *
 *   CASE B — secret is never returned unmasked: after saving, the read-back
 *     view shows a masked preview (last 4), never the full token. (CP-17a.)
 *
 *   CASE C — env fallback: with NO per-workspace creds, the provider falls back
 *     to env. (CP-17c — existing operator env config still works.)
 *
 *   CASE D — test connection uses POSTED values: a test call validates the
 *     values passed in (not env). Injected stub fetch returns "connected" for
 *     valid-shaped creds, "auth_failed" for a 190. (CP-17d.)
 *
 *   CASE E — update + clear: updating creds replaces them; clearing removes
 *     them (provider falls back to env / not_configured).
 *
 * Test isolation (Gate #8): own workspace ids (ws_wa_*).
 * Run: npm run golden:whatsapp-credentials
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { WhatsAppCredentialService } from "@/services/WhatsAppCredentialService";
import { MetaWhatsAppCloudProvider } from "@/providers/whatsapp/MetaWhatsAppCloudProvider";
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

  // ─── CASE A: save → isConfigured per-workspace; isolation ──────────────────
  {
    const WS_A = "ws_wa_a";
    const WS_B = "ws_wa_b";
    await seedWorkspace(repos, WS_A);
    await seedWorkspace(repos, WS_B);
    const svc = new WhatsAppCredentialService(repos);

    await svc.save(WS_A, {
      accessToken: "EAAG_fake_token_A",
      phoneNumberId: "106540352242922",
      businessAccountId: "102290129340398",
    });

    const credsA = await svc.getForProvider(WS_A);
    const providerA = new MetaWhatsAppCloudProvider(credsA);
    assert(providerA.isConfigured(), "CASE A: workspace A is configured after saving creds");

    const credsB = await svc.getForProvider(WS_B);
    const providerB = new MetaWhatsAppCloudProvider(credsB);
    assert(!providerB.isConfigured(), "CASE B isolation: workspace B (no creds) is NOT configured");
    console.log("✅ CASE A — per-workspace config + isolation (A configured, B not)");
  }

  // ─── CASE B: secret never returned unmasked ────────────────────────────────
  {
    const WS = "ws_wa_b";
    await seedWorkspace(repos, WS);
    const svc = new WhatsAppCredentialService(repos);
    await svc.save(WS, { accessToken: "EAAG_super_secret_token_xyz", phoneNumberId: "111", businessAccountId: "222" });

    const view = await svc.getView(WS);
    // The view must NOT contain the raw token.
    const serialized = JSON.stringify(view);
    assert(!serialized.includes("EAAG_super_secret_token_xyz"), "CASE B: raw token NOT in the view");
    assert(/xyz|.{4}$/.test(String(view?.accessTokenPreview || "")), "CASE B: a masked preview IS shown");
    console.log("✅ CASE B — secret never returned unmasked (masked preview only)");
  }

  // ─── CASE C: env fallback when no per-workspace creds ──────────────────────
  {
    const WS = "ws_wa_c";
    await seedWorkspace(repos, WS);
    const svc = new WhatsAppCredentialService(repos);
    const creds = await svc.getForProvider(WS);
    // No per-workspace creds → provider should fall back to env. We can't set
    // env here without polluting process, so assert the resolution returns
    // undefined creds (meaning "use env") rather than throwing.
    assert(creds === undefined || (!creds.accessToken && !creds.phoneNumberId), "CASE C: no per-workspace creds → undefined (env fallback path)");
    console.log("✅ CASE C — env fallback when no per-workspace creds (no throw)");
  }

  // ─── CASE D: test connection uses POSTED values (injected stub fetch) ──────
  {
    const WS = "ws_wa_d";
    await seedWorkspace(repos, WS);
    const svc = new WhatsAppCredentialService(repos);

    // Stub a successful Meta response (200 with display_phone_number).
    const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ display_phone_number: "15550783881", verified_name: "Test Biz" }) });
    const result = await svc.testConnection({ accessToken: "EAAG_valid", phoneNumberId: "106540352242922", businessAccountId: "x" }, { fetchImpl: okFetch as never });
    assert(result.ok === true && result.status === "connected", `CASE D: valid creds → connected, got ${result.status}`);
    assert(/15550783881|Test Biz/.test(result.message || ""), "CASE D: success message includes the phone/name");

    // Stub an auth-failed response (190).
    const failFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 190, message: "Invalid OAuth access token" } }) });
    const failResult = await svc.testConnection({ accessToken: "EAAG_bad", phoneNumberId: "106540352242922", businessAccountId: "x" }, { fetchImpl: failFetch as never });
    assert(failResult.ok === false && failResult.status === "auth_failed", `CASE D: bad token → auth_failed, got ${failResult.status}`);
    console.log("✅ CASE D — test connection validates POSTED values (connected + auth_failed paths)");
  }

  // ─── CASE E: update replaces; clear removes ────────────────────────────────
  {
    const WS = "ws_wa_e";
    await seedWorkspace(repos, WS);
    const svc = new WhatsAppCredentialService(repos);
    await svc.save(WS, { accessToken: "token_v1", phoneNumberId: "111", businessAccountId: "222" });
    await svc.save(WS, { accessToken: "token_v2", phoneNumberId: "333", businessAccountId: "444" });
    const creds = await svc.getForProvider(WS);
    const provider = new MetaWhatsAppCloudProvider(creds);
    assert(provider.isConfigured(), "CASE E: still configured after update");
    // The accessToken should be the LATEST (v2), not the old one.
    assert(creds?.accessToken === "token_v2", `CASE E: update replaced with token_v2, got ${creds?.accessToken}`);
    assert(creds?.phoneNumberId === "333", "CASE E: phoneNumberId updated to 333");

    await svc.clear(WS);
    const afterClear = await svc.getForProvider(WS);
    assert(!afterClear?.accessToken && !afterClear?.phoneNumberId, "CASE E: clear removed the creds");
    console.log("✅ CASE E — update replaces; clear removes");
  }

  console.log("\n✅✅✅ All whatsapp-credentials golden cases PASSED (A–E). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
