/**
 * 2026-07-29 — DEPTH AUDIT: Settings + conflict resolution — Slice B, Batch 3.
 *
 * Full persistence proof for the 4 structured-settings PUT routes + the 5
 * knowledge-conflict resolution actions. For each: PUT via API → read the
 * JSON file off disk → assert the persisted fields match what was sent →
 * Golden-Thread check the conflict winner value is written to the setting.
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - PUT /api/lead-review/settings → leadReviewSettings[]; allowAutoSend is
 *     HARD-FORCED false on every write (even if body sends true). Fields:
 *     mode, autoApproveThreshold, autoRejectThreshold, maxAutoApprovedPerDay.
 *     Source: LeadReviewDecisionService.ts:51-53, json repo index.ts:1831.
 *   - PUT /api/settings/products → productSettings[] (single record per ws).
 *     Source: route.ts:3978.
 *   - PUT /api/settings/policy → policySettings[]. EXACT field names:
 *     paymentPolicy, creditPolicy, shippingDeliveryPolicy,
 *     returnReplacementPolicy, cancellationPolicy, customizationPolicy,
 *     samplePolicy. Source: route.ts:3983, types.ts:1739-1751.
 *   - PUT /api/settings/communication → communicationSettings[]. Fields:
 *     tone, defaultFallbackReply, allowedAutoReplyTopics,
 *     humanReviewRequiredTopics, priceReplyRule, etc. Source: route.ts:3988.
 *   - Conflict resolution: POST /api/settings/conflicts/:id/resolve
 *     {resolution, customValue?, reason?} + POST .../:id/ignore.
 *     Resolution writes the WINNER value to the structured setting via
 *     setSettingValue. keep_both concatenates:
 *       `${existingValue} | Also: ${extractedValue}`
 *     Source: ExtractionRoutingService.ts:230-257.
 *
 * Seed (workspace_demo): policySettings has 1 record (paymentPolicy="100%
 * advance"); settingsConflicts has 1 OPEN conflict (conflict_demo_1) on
 * paymentPolicy: existing="100% advance", extracted="50% advance, balance
 * before dispatch". Each test restores the snapshot so the same conflict can
 * be resolved with each of the 5 actions.
 *
 * Run: npx playwright test depth-settings --reporter=list
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";

import { readAppData } from "./helpers/app-data";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const REPO_ROOT = path.resolve(__dirname, "..");
// 2026-08-19 (N-TEST-5) — was `path.join(REPO_ROOT, ".leadgen-data", "app-data.json")`.
// The suite moved onto its own data directory earlier the same session, so this
// pointed at the PRODUCT file while the server wrote to the suite's file: every
// assertion below read a value the test had never written. See e2e/helpers/data-dir.ts.
const BASE = E2E_BASE_URL;
const HEADERS = { Cookie: "lc_demo=1", "Content-Type": "application/json" };

function policySettings(): any {
  return readAppData().policySettings?.find((p: any) => p.workspaceId === "workspace_demo");
}
function conflict(): any {
  return readAppData().settingsConflicts?.find((c: any) => c.id === "conflict_demo_1");
}
async function put(route: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(route: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS PERSISTENCE ×4
// ════════════════════════════════════════════════════════════════════════════
test.describe("Settings depth — persistence ×4", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("PUT /api/lead-review/settings persists fields + hard-forces allowAutoSend=false", async () => {
    // Adversarial: send allowAutoSend:true. The backend MUST override to false
    // (no-auto-outreach is sacred — auto-send is never enabled via settings).
    const { status } = await put("/api/lead-review/settings", {
      mode: "agent_recommendation",
      autoApproveThreshold: 0.9,
      autoRejectThreshold: 0.3,
      maxAutoApprovedPerDay: 30,
      allowAutoSend: true, // must be overridden
    });
    expect(status).toBeLessThan(400);

    const settings = readAppData().leadReviewSettings.find((s: any) => s.workspaceId === "workspace_demo");
    expect(settings.mode).toBe("agent_recommendation");
    expect(settings.autoApproveThreshold).toBe(0.9);
    expect(settings.autoRejectThreshold).toBe(0.3);
    expect(settings.maxAutoApprovedPerDay).toBe(30);
    expect(settings.allowAutoSend, "allowAutoSend MUST be forced false (no-auto-outreach)").toBe(false);
  });

  test("PUT /api/settings/products persists the products array (single record per ws)", async () => {
    const PRODUCT = "Zari lace (gold)";
    const { status } = await put("/api/settings/products", {
      products: [{ id: "prod_1", name: PRODUCT, price: 120, priceUnit: "per metre", moq: "50 metre", productMode: "simple" }],
    });
    expect(status).toBeLessThan(400);

    const settings = readAppData().productSettings.find((s: any) => s.workspaceId === "workspace_demo");
    expect(settings, "productSettings record must be created").toBeDefined();
    expect(settings.products).toHaveLength(1);
    expect(settings.products[0].name).toBe(PRODUCT);
    expect(settings.products[0].price).toBe(120);
    expect(settings.products[0].priceUnit).toBe("per metre");
  });

  test("PUT /api/settings/policy persists exact field names (shippingDeliveryPolicy etc.)", async () => {
    // Use the EXACT field names — a typo would persist as an unknown key that
    // no consumer reads (silent data loss). This test pins the contract.
    const PAYMENT = "50% advance, balance before dispatch";
    const SHIPPING = "Dispatch within 5 working days from Surat";
    const RETURNS = "No returns on custom designs";
    const { status } = await put("/api/settings/policy", {
      paymentPolicy: PAYMENT,
      shippingDeliveryPolicy: SHIPPING,
      returnReplacementPolicy: RETURNS,
    });
    expect(status).toBeLessThan(400);

    const settings = policySettings();
    expect(settings.paymentPolicy).toBe(PAYMENT);
    expect(settings.shippingDeliveryPolicy, "exact field name shippingDeliveryPolicy").toBe(SHIPPING);
    expect(settings.returnReplacementPolicy, "exact field name returnReplacementPolicy").toBe(RETURNS);
  });

  test("PUT /api/settings/communication persists tone + topic lists", async () => {
    const TONE = "professional_friendly";
    const FALLBACK = "Let me confirm with my team and revert.";
    const { status } = await put("/api/settings/communication", {
      tone: TONE,
      defaultFallbackReply: FALLBACK,
      allowedAutoReplyTopics: ["catalogue", "dispatch time"],
      humanReviewRequiredTopics: ["price", "complaint"],
    });
    expect(status).toBeLessThan(400);

    const settings = readAppData().communicationSettings.find((s: any) => s.workspaceId === "workspace_demo");
    expect(settings.tone).toBe(TONE);
    expect(settings.defaultFallbackReply).toBe(FALLBACK);
    expect(settings.allowedAutoReplyTopics).toEqual(["catalogue", "dispatch time"]);
    expect(settings.humanReviewRequiredTopics).toEqual(["price", "complaint"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CONFLICT RESOLUTION ×5 (Golden Thread: winner value written to the setting)
//
// Seeded conflict conflict_demo_1: paymentPolicy
//   existingValue  = "100% advance"
//   extractedValue = "50% advance, balance before dispatch"
// Each test resolves the SAME conflict (restore resets it) with one action.
// ════════════════════════════════════════════════════════════════════════════
test.describe("Settings depth — conflict resolution ×5", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("keep_existing → policy keeps existingValue; conflict resolved", async () => {
    const { status } = await post("/api/settings/conflicts/conflict_demo_1/resolve", { resolution: "keep_existing" });
    expect(status).toBeLessThan(400);

    // Golden Thread: the policy setting must hold the existing value.
    expect(policySettings().paymentPolicy, "keep must retain existingValue").toBe("100% advance");
    const c = conflict();
    expect(c.status).toBe("resolved");
    expect(c.resolution).toBe("keep_existing");
  });

  test("use_extracted → policy adopts extractedValue; conflict resolved", async () => {
    const { status } = await post("/api/settings/conflicts/conflict_demo_1/resolve", { resolution: "use_extracted" });
    expect(status).toBeLessThan(400);

    expect(policySettings().paymentPolicy, "use must adopt extractedValue").toBe("50% advance, balance before dispatch");
    const c = conflict();
    expect(c.status).toBe("resolved");
    expect(c.resolution).toBe("use_extracted");
  });

  test("custom → policy adopts the customValue; conflict resolved", async () => {
    const CUSTOM = "30% advance, 70% on delivery";
    const { status } = await post("/api/settings/conflicts/conflict_demo_1/resolve", {
      resolution: "custom", customValue: CUSTOM, reason: "operator compromise",
    });
    expect(status).toBeLessThan(400);

    expect(policySettings().paymentPolicy, "custom must adopt customValue").toBe(CUSTOM);
    const c = conflict();
    expect(c.status).toBe("resolved");
    expect(c.resolution).toBe("custom");
    expect(c.customValue).toBe(CUSTOM);
    expect(c.resolutionReason).toBe("operator compromise");
  });

  test("keep_both → policy = concatenated 'existing | Also: extracted' (hand-computed)", async () => {
    // Hand-computed per ExtractionRoutingService.ts:249:
    //   `${existingValue} | Also: ${extractedValue}`
    // = "100% advance | Also: 50% advance, balance before dispatch"
    const EXPECTED = "100% advance | Also: 50% advance, balance before dispatch";
    const { status } = await post("/api/settings/conflicts/conflict_demo_1/resolve", { resolution: "keep_both" });
    expect(status).toBeLessThan(400);

    expect(policySettings().paymentPolicy, "keep_both must concatenate existing+extracted").toBe(EXPECTED);
    const c = conflict();
    expect(c.status).toBe("resolved");
    expect(c.resolution).toBe("keep_both");
  });

  test("ignore → conflict marked ignored; policy UNCHANGED (no setting write)", async () => {
    // Before: paymentPolicy = "100% advance" (seed).
    expect(policySettings().paymentPolicy).toBe("100% advance");
    const { status } = await post("/api/settings/conflicts/conflict_demo_1/ignore", {});
    expect(status).toBeLessThan(400);

    // ignore() does NOT call setSettingValue — the setting must be untouched.
    expect(policySettings().paymentPolicy, "ignore must NOT change the setting").toBe("100% advance");
    const c = conflict();
    expect(c.status).toBe("ignored");
  });
});
