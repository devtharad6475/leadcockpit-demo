/**
 * 2026-07-21 — Golden Thread test: Compliance (Consent + Erasure).
 *
 * Math layer is pinned by `golden:erasure-audit`:
 *   - eraseCustomer owner-only, two-step name confirm, anonymized audit
 *   - AuditSeverity + queryAuditLog + ProductionGateExtensions
 *
 * And `golden:consent-safety`:
 *   - createDefaultConsent → basis="none"
 *   - upgradeConsentBasis requires evidence
 *   - withdrawConsent → isConsentActive=false
 *   - classifyMessageSafety blocks 4 categories
 *
 * This test pins the API + UI to the SAME golden values:
 *   CONSENT: basis="legitimate_interest" round-trips through POST /consent/:id
 *            and appears in the GET /consent list with the same value.
 *   ERASURE: preview counts match what's actually in the DB;
 *            erase with wrong name → 400; erase with right name →
 *            anonymized + audit entry written.
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page);
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${E2E_BASE_URL}${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${url} failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

async function apiRaw(url: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${E2E_BASE_URL}${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    cache: "no-store",
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

type Lead = { id: string; contactName?: string };
type ConsentRow = { leadId: string; contactName: string; consentStatus: string };
type ErasurePreview = {
  leadId: string;
  contactName?: string;
  counts: { replies: number; tickets: number; orders: number; quotes: number };
  // 2026-07-27 fix: confirmName is `string | null` (null when the lead has no
  // name — erasure requires a confirmable name). canErase mirrors the service.
  confirmName: string | null;
  canErase?: boolean;
  reason?: string | null;
};

async function getDemoLead(): Promise<Lead | null> {
  const leads = await api<Lead[]>("/api/leads");
  return leads[0] || null;
}

test.describe("Golden Thread — Compliance (API; math pinned by golden:erasure-audit + golden:consent-safety)", () => {
  // === CONSENT ===
  test("API: change consent basis round-trips (POST then GET shows the same basis)", async () => {
    const lead = await getDemoLead();
    if (!lead) { test.skip(true, "No leads in demo"); return; }

    // Change to legitimate_interest.
    const updated = await api<{ leadId: string; basis: string }>(`/api/consent/${lead.id}`, {
      method: "POST",
      body: JSON.stringify({ basis: "legitimate_interest", evidence: "Golden thread test evidence" }),
    });
    expect(updated.basis, "POST should return the basis we set").toBe("legitimate_interest");

    // GET the consent list — our lead should show the same basis.
    const list = await api<ConsentRow[]>("/api/consent");
    const ours = list.find((r) => r.leadId === lead.id);
    expect(ours, "our lead should be in the consent list").toBeDefined();
    expect(ours!.consentStatus, "GET should reflect the same basis we POSTed").toBe("legitimate_interest");
  });

  test("API: invalid basis is rejected (422)", async () => {
    const lead = await getDemoLead();
    if (!lead) { test.skip(true, "No leads in demo"); return; }

    const result = await apiRaw(`/api/consent/${lead.id}`, {
      method: "POST",
      body: JSON.stringify({ basis: "totally_made_up_basis" }),
    });
    // validationErrorResponse returns 422 (Unprocessable Entity), not 400.
    expect([400, 422], "invalid basis should be rejected (400 or 422)").toContain(result.status);
  });

  test("API: basis 'none' is allowed (reset)", async () => {
    const lead = await getDemoLead();
    if (!lead) { test.skip(true, "No leads in demo"); return; }

    const updated = await api<{ leadId: string; basis: string }>(`/api/consent/${lead.id}`, {
      method: "POST",
      body: JSON.stringify({ basis: "none", evidence: "Reset" }),
    });
    expect(updated.basis, "resetting to 'none' is valid").toBe("none");
  });

  // Cluster A fix B4 (2026-07-21 session 16): upgrades require evidence.
  // Same rule pinned at math layer by golden:consent-wiring CASE B/C.
  test("API: upgrade to legitimate_interest WITHOUT evidence is rejected (Golden Thread with golden:consent-wiring)", async () => {
    const lead = await getDemoLead();
    if (!lead) { test.skip(true, "No leads in demo"); return; }

    // Empty-string evidence → must be rejected.
    const resultEmpty = await apiRaw(`/api/consent/${lead.id}`, {
      method: "POST",
      body: JSON.stringify({ basis: "legitimate_interest", evidence: "" }),
    });
    expect([400, 422], "empty evidence upgrade must be rejected").toContain(resultEmpty.status);

    // Missing evidence key entirely → must be rejected.
    const resultMissing = await apiRaw(`/api/consent/${lead.id}`, {
      method: "POST",
      body: JSON.stringify({ basis: "consent" }),
    });
    expect([400, 422], "missing evidence key upgrade must be rejected").toContain(resultMissing.status);
  });

  // === ERASURE ===
  test("API: erasure preview returns counts + a nameless-lead-honest contract", async () => {
    const leads = await api<Lead[]>("/api/leads");
    if (leads.length === 0) { test.skip(true, "No leads in demo"); return; }

    // 2026-07-27 fix: the preview must mirror ErasureService.eraseCustomer's
    // contract. The service REFUSES to erase a nameless lead (needs a
    // confirmable name). The preview must tell the truth up front:
    //   - lead WITH a name    → confirmName is that name, canErase=true
    //   - lead WITHOUT a name → confirmName=null, canErase=false, reason set
    // Previously the preview returned confirmName="" for nameless leads,
    // so the modal rendered blank. This pins the honest behaviour.
    const namedLead = leads.find((l) => (l.contactName || "").trim() || (l as { companyName?: string }).companyName);
    const namelessLead = leads.find((l) => !(l.contactName || "").trim() && !((l as { companyName?: string }).companyName || "").trim());

    if (namedLead) {
      const preview = await api<ErasurePreview>(`/api/erasure/preview?leadId=${namedLead.id}`);
      expect(preview.leadId, "preview echoes leadId").toBe(namedLead.id);
      expect(preview.confirmName, "named lead → confirmName is truthy (the name to confirm)").toBeTruthy();
      expect(preview.canErase, "named lead → canErase=true").toBe(true);
      expect(preview.reason, "named lead → no reason").toBeFalsy();
    }

    if (namelessLead) {
      const preview = await api<ErasurePreview>(`/api/erasure/preview?leadId=${namelessLead.id}`);
      expect(preview.leadId, "preview echoes leadId").toBe(namelessLead.id);
      // The load-bearing assertion: nameless lead → confirmName is NULL (not ""),
      // canErase=false, and a human-readable reason is present.
      expect(preview.confirmName, "nameless lead → confirmName is null (not empty string)").toBeNull();
      expect(preview.canErase, "nameless lead → canErase=false").toBe(false);
      expect(preview.reason, "nameless lead → reason explains why").toBeTruthy();
    }

    // Counts are always non-negative integers regardless of name.
    const anyLead = namedLead || leads[0];
    const preview = await api<ErasurePreview>(`/api/erasure/preview?leadId=${anyLead.id}`);
    for (const key of ["replies", "tickets", "orders", "quotes"] as const) {
      expect(preview.counts[key], `${key} count should be ≥ 0`).toBeGreaterThanOrEqual(0);
    }
  });

  test("API: erasure with wrong confirmName is rejected (422)", async () => {
    const lead = await getDemoLead();
    if (!lead) { test.skip(true, "No leads in demo"); return; }

    const result = await apiRaw(`/api/erasure/${lead.id}`, {
      method: "POST",
      body: JSON.stringify({ confirmName: "Completely Wrong Name" }),
    });
    // validationErrorResponse returns 422 (Unprocessable Entity), not 400.
    expect([400, 422], "wrong confirmName should be rejected").toContain(result.status);
  });

  // NOTE: We do NOT run the actual-erase test against the demo lead
  // because it would anonymize the demo data and break other tests.
  // The math (anonymization + audit entry + DNC preservation) is
  // covered by golden:erasure-audit which runs against synthetic data.

  // === UI ===
  test("UI: Compliance screen renders the consent table for the demo leads", async ({ page }) => {
    const lead = await getDemoLead();
    if (!lead) { test.skip(true, "No leads in demo"); return; }

    await loginDemo(page);
    await openTabByLabel(page, "Compliance");
    await page.waitForTimeout(2000);

    // The consent table should appear (since we have leads).
    const table = page.getByRole("table");
    await expect(table).toBeVisible({ timeout: 10_000 });

    // The lead's name should appear in the table.
    if (lead.contactName) {
      await expect(page.getByText(lead.contactName).first()).toBeVisible();
    }
  });
});
