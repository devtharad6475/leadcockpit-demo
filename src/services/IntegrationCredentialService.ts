/**
 * IntegrationCredentialService — per-workspace single-key integration credentials
 * (SerpApi + Resend). D-2026-08-02-b / CP-18.
 *
 * Same pattern as WhatsAppCredentialService but for single-key integrations
 * (one API key each, not 3 fields). Stored encrypted + masked, scoped to one
 * workspace, provider-tagged. Per-workspace key overrides env; env is fallback.
 *
 * Provider tags: "serpapi" (web search), "resend" (email send). Reusable for
 * future single-key integrations (Tavily, SendGrid, etc.) — just add a tag.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { decryptSecret, encryptSecret, readableSecret } from "@/lib/credential-security";
import { maskSecret } from "@/lib/secret-redaction";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type IntegrationProvider = "serpapi" | "resend";

export type IntegrationCredView = {
  hasKey: boolean;
  keyPreview?: string;
};

export type IntegrationTestResult = {
  ok: boolean;
  status: "connected" | "not_configured" | "auth_failed" | "rate_limited" | "network_error" | "unknown_error";
  message: string;
};

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";

export class IntegrationCredentialService {
  constructor(private readonly repos: RepositoryBundle) {}

  /** Save (create or replace) the workspace's key for a provider. */
  async save(workspaceId: string, provider: IntegrationProvider, apiKey: string): Promise<void> {
    if (!apiKey?.trim()) throw new NeedsActionError(`API key for ${provider} is required.`, 400);
    const existing = await this.findRow(workspaceId, provider);
    const payload = {
      provider,
      displayName: provider === "serpapi" ? "SerpApi (web search)" : "Resend (email)",
      encryptedApiKey: encryptSecret(apiKey.trim(), workspaceId),
      status: "connected" as const,
      config: {},
    };
    if (existing) {
      await this.repos.llmProviderCredential.update(workspaceId, existing.id, payload);
    } else {
      await this.repos.llmProviderCredential.create(workspaceId, payload);
    }
  }

  /** Remove the workspace's key (consumers fall back to env). */
  async clear(workspaceId: string, provider: IntegrationProvider): Promise<void> {
    const existing = await this.findRow(workspaceId, provider);
    if (existing) await this.repos.llmProviderCredential.delete(workspaceId, existing.id);
  }

  /**
   * Resolve the decrypted key for a consumer. Returns undefined when none saved
   * → the consumer falls back to env (CP-18c).
   */
  async resolveKey(workspaceId: string, provider: IntegrationProvider): Promise<string | undefined> {
    const row = await this.findRow(workspaceId, provider);
    if (!row) return undefined;
    return decryptSecret(row.encryptedApiKey, workspaceId);
  }

  /** A masked view for the UI — never the raw key. */
  async getView(workspaceId: string, provider: IntegrationProvider): Promise<IntegrationCredView> {
    const row = await this.findRow(workspaceId, provider);
    if (!row) return { hasKey: false };
    // 2026-09-26 (break test): an unreadable saved key (encryption key
    // changed) made this view throw; it now shows as "no key" so the owner
    // can paste it again. resolveKey still throws — using the server's own
    // key in its place without saying so would be worse.
    const raw = readableSecret(row.encryptedApiKey, workspaceId);
    return { hasKey: Boolean(raw), keyPreview: raw ? maskSecret(raw) : undefined };
  }

  /**
   * Test a SerpApi key with a one-result search. Validates the POSTED key.
   * Injected fetch for the golden (deterministic, no network).
   */
  async testSerpApi(apiKey: string, options: { fetchImpl?: typeof fetch } = {}): Promise<IntegrationTestResult> {
    if (!apiKey?.trim()) return { ok: false, status: "not_configured", message: "SerpApi key is required to test." };
    const url = new URL(SERPAPI_ENDPOINT);
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", "test");
    url.searchParams.set("api_key", apiKey.trim());
    url.searchParams.set("num", "1");
    const safety = await assertSafeFetchUrl(url.toString());
    if (!safety.safe) return { ok: false, status: "unknown_error", message: `URL blocked: ${safety.reason}` };
    const fetchFn = options.fetchImpl ?? fetch;
    try {
      const response = (await fetchFn(safety.url.toString(), {
        headers: { "user-agent": "LeadCockpitProbe/0.1" },
      } as never)) as { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, status: "auth_failed", message: "SerpApi rejected the key (401/403). Check the key in your SerpApi dashboard." };
        }
        if (response.status === 429) return { ok: false, status: "rate_limited", message: "SerpApi rate-limited the test. Wait a minute." };
        return { ok: false, status: "unknown_error", message: `SerpApi returned ${response.status}.` };
      }
      const results = (payload as { organic_results?: unknown[] }).organic_results;
      return { ok: true, status: "connected", message: `Connected. SerpApi key is live${Array.isArray(results) ? ` (test search returned ${results.length} result(s))` : ""}.` };
    } catch (e) {
      return { ok: false, status: "network_error", message: `Could not reach SerpApi: ${e instanceof Error ? e.message : "network error"}.` };
    }
  }

  /**
   * Test a Resend key. Resend has no free "ping" endpoint, so this is an
   * HONEST presence/shape check — it confirms a key was entered and looks like a
   * Resend key (re_ prefix), NOT a fake "valid". Real validity is proven on the
   * first real send (which is human-gated anyway).
   */
  testResend(apiKey: string): IntegrationTestResult {
    if (!apiKey?.trim()) return { ok: false, status: "not_configured", message: "Resend key is required to test." };
    // Resend keys start with "re_". This is a shape hint, not a validity proof.
    if (!apiKey.trim().startsWith("re_")) {
      return { ok: false, status: "unknown_error", message: "This doesn't look like a Resend key (Resend keys start with 're_'). Double-check it." };
    }
    return { ok: true, status: "connected", message: "Key saved (re_ prefix matches). Resend has no test endpoint — real validity is confirmed on the first approved send." };
  }

  private async findRow(workspaceId: string, provider: IntegrationProvider) {
    const all = await this.repos.llmProviderCredential.listByWorkspace(workspaceId);
    return all.find((c) => c.provider === provider);
  }
}
