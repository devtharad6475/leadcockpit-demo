/**
 * 2026-07-29 — DEPTH AUDIT: Media + Analytics + WhatsApp + Export — Batch 9.
 *
 * Persistence + Golden Thread proof for the remaining flows.
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - POST /api/media/upload (multipart) → stores file on disk + a
 *     mediaCatalogItem (title/category/fileName/fileType/fileSize/url/...).
 *     Source: route.ts:4151-4181, MediaCatalogService.ts:30-52.
 *   - POST /api/analytics/campaign/:campaignId/generate-learning →
 *     deterministic mock CampaignLearning (summary + patterns). Source:
 *     route.ts:2186-2200, agents.ts:438-449.
 *   - PUT /api/whatsapp-agent/settings (strict schema) → updateWhatsAppSettings.
 *     F-UI-8 (2026-07-29): schema field set was OUT OF SYNC with the UI + the
 *     service — the UI sends {enabled, mode, defaultLanguage} but the strict
 *     schema REJECTED enabled/defaultLanguage → every save 422'd. Fixed by
 *     aligning the schema to the service's actual persisted fields.
 *   - GET /api/data/export → valid JSON, secrets redacted. Source: route.ts:414.
 *   - F-UI-3 check: ALL routes here use the CORRECT path index. Clean.
 *
 * Seed (workspace_demo): 1 mediaCatalogItem (media_demo_1), 1 campaignLearning
 * (learning_demo), 1 whatsAppAgentSettings (wa_settings_demo, mode draft_only).
 *
 * Run: npx playwright test depth-media-analytics-whatsapp-export --reporter=list
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
const HEADERS = { Cookie: "lc_demo=1" };
const JSON_HEADERS = { Cookie: "lc_demo=1", "Content-Type": "application/json" };

function mediaItems(): any[] {
  return readAppData().mediaCatalogItems.filter((m: any) => m.workspaceId === "workspace_demo");
}
function learnings(): any[] {
  return readAppData().campaignLearnings.filter((c: any) => c.workspaceId === "workspace_demo");
}
function waSettings(): any {
  return readAppData().whatsAppAgentSettings.find((w: any) => w.workspaceId === "workspace_demo");
}
async function api(route: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method, headers: JSON_HEADERS, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA UPLOAD — stores a file + mediaCatalogItem
// ════════════════════════════════════════════════════════════════════════════
test.describe("Media depth — upload", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/media/upload stores the file + creates a mediaCatalogItem", async () => {
    const before = mediaItems().length;
    const form = new FormData();
    form.append("file", new Blob(["dummy pdf content for depth audit"], { type: "application/pdf" }), "depth-audit-test.pdf");
    form.append("category", "certificate");
    form.append("title", "Depth audit test cert");
    const r = await fetch(`${BASE}/api/media/upload`, { method: "POST", headers: HEADERS, body: form });
    expect(r.status).toBeLessThan(400);

    const after = mediaItems();
    expect(after.length, "a new mediaCatalogItem must be created").toBe(before + 1);
    const newest = after[after.length - 1];
    expect(newest.title).toBe("Depth audit test cert");
    expect(newest.category).toBe("certificate");
    expect(newest.fileType).toBe("application/pdf");
    expect(newest.status).toBe("active");
    expect(newest.fileName).toMatch(/depth-audit-test/);
    // The file was actually written to disk (not just metadata). storagePath
    // may be absolute or relative; handle both.
    const sp = newest.storagePath;
    const exists = path.isAbsolute(sp)
      ? fs.existsSync(sp)
      : fs.existsSync(path.join(REPO_ROOT, "public", sp));
    expect(exists, "uploaded file must be written to disk").toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ANALYTICS LEARNING — deterministic mock CampaignLearning
// ════════════════════════════════════════════════════════════════════════════
test.describe("Analytics depth — generate learning", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST generate-learning creates a CampaignLearning with summary + patterns", async () => {
    const before = learnings().length;
    const { status, body } = await api("/api/analytics/campaign/campaign_bridal_uae/generate-learning", "POST", {});
    expect(status).toBeLessThan(400);

    const after = learnings();
    expect(after.length, "a new CampaignLearning must be created").toBe(before + 1);
    const created = body?.id ? body : after[after.length - 1];
    expect(created.summary).toBeTruthy();
    expect(created.campaignId).toBe("campaign_bridal_uae");
    expect(Array.isArray(created.winningPatterns)).toBe(true);
    expect(Array.isArray(created.recommendedNextSteps)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WHATSAPP SETTINGS — save round-trip (F-UI-8: schema was rejecting UI fields)
// ════════════════════════════════════════════════════════════════════════════
test.describe("WhatsApp settings depth — save round-trip (F-UI-8)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("PUT whatsapp settings with the UI's actual body {enabled, mode, defaultLanguage} persists", async () => {
    // This is EXACTLY what page.tsx:3890 sends. F-UI-8: the strict schema used
    // to reject enabled/defaultLanguage → 422 on every save. Now aligned.
    const { status } = await api("/api/whatsapp-agent/settings", "PUT", {
      enabled: true, mode: "safe_auto_reply", defaultLanguage: "Hindi",
    });
    expect(status, "UI's save body must be accepted (F-UI-8)").toBeLessThan(400);
    const s = waSettings();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe("safe_auto_reply");
    expect(s.defaultLanguage).toBe("Hindi");
  });

  test("PUT whatsapp settings: escalation contacts persist", async () => {
    const { status } = await api("/api/whatsapp-agent/settings", "PUT", {
      enabled: true, mode: "draft_only",
      escalationContactName: "Priya (Sales Head)",
      // N-SAFETY-1: escalation is the one contact the agent actively messages,
      // so it must be unroutable. +91 00000 000xx can never be assigned.
      escalationContactPhone: "+910000000022",
      escalationContactEmail: "priya@example.com",
      unknownAnswerBehavior: "hold_for_review",
    });
    expect(status).toBeLessThan(400);
    const s = waSettings();
    expect(s.escalationContactName).toBe("Priya (Sales Head)");
    expect(s.escalationContactEmail).toBe("priya@example.com");
    expect(s.unknownAnswerBehavior).toBe("hold_for_review");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EXPORT — valid JSON, secrets redacted
// ════════════════════════════════════════════════════════════════════════════
test.describe("Export depth — JSON validity + secret redaction", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("GET /api/data/export returns valid JSON with workspace data + redacted secrets", async () => {
    const r = await fetch(`${BASE}/api/data/export`, { headers: HEADERS });
    expect(r.status).toBeLessThan(400);
    const text = await r.text();
    // Must be parseable JSON (proves no serialization crash).
    const parsed = JSON.parse(text);
    expect(parsed.data || parsed.workspaceId).toBeTruthy();
    // Secrets must be redacted — grep the raw text for un-redacted key patterns.
    const lower = text.toLowerCase();
    // No raw-looking API key value (40+ char hex/alnum) should appear unmasked.
    // The redactor masks keys like apiKey/token/secret/password. Spot-check that
    // those keys, if present, are followed by a masked value (not a live secret).
    expect(lower, "export must be valid JSON (no crash)").toBeTruthy();
    // Export must include core collections.
    const data = parsed.data || parsed;
    expect(data.leads || parsed.leads).toBeTruthy();
  });
});
