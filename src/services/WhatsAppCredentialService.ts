/**
 * WhatsAppCredentialService — per-workspace WhatsApp Cloud credentials
 * (D-2026-08-02 / CP-17). The concierge-path: an operator (or owner) pastes a
 * customer's WhatsApp credentials into their workspace via the UI; they're
 * stored encrypted, used per-workspace, and never returned unmasked.
 *
 * Storage reuses the LLMProviderCredential chokepoint (encryptSecret) — the
 * credentials are stored as a `whatsapp_cloud` provider row with the token in
 * `encryptedApiKey` and the (non-secret) phone/business IDs in `config`. No new
 * repo/collection needed.
 *
 * Authority: docs/LOGIC.md CP-17 + docs/DECISIONS.md D-2026-08-02.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { decryptSecret, encryptSecret, readableSecret } from "@/lib/credential-security";
import { maskSecret } from "@/lib/secret-redaction";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import type { MetaWhatsAppCloudProvider as MetaWhatsAppCloudProviderType } from "@/providers/whatsapp/MetaWhatsAppCloudProvider";
import type { RepositoryBundle } from "@/repositories/interfaces";

const CRED_PROVIDER = "whatsapp_cloud";

export type WhatsAppCloudCreds = {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
};

export type WhatsAppCredView = {
  hasCredentials: boolean;
  accessTokenPreview?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  /** Whether a webhook verify token is stored. Never the value itself. */
  hasVerifyToken?: boolean;
};

/**
 * What the Integrations screen may send. The access token is OPTIONAL on a
 * re-save: the screen tells the operator "Leave the token blank to keep the
 * saved one", and this is what makes that true.
 *
 * verifyToken: undefined leaves the stored one alone, "" clears it.
 */
export type WhatsAppCredSaveInput = {
  accessToken?: string;
  phoneNumberId: string;
  businessAccountId?: string;
  verifyToken?: string;
};

export type WhatsAppTestInput = {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
};

export type WhatsAppTestResult = {
  ok: boolean;
  status: "connected" | "not_configured" | "auth_failed" | "wrong_number" | "rate_limited" | "network_error" | "unknown_error";
  message: string;
  displayPhoneNumber?: string;
  qualityRating?: string;
};

export class WhatsAppCredentialService {
  constructor(private readonly repos: RepositoryBundle) {}

  /** Save (create or replace) the workspace's WhatsApp Cloud credentials. */
  async save(workspaceId: string, input: WhatsAppCredSaveInput): Promise<void> {
    const existing = await this.findRow(workspaceId);
    // The screen promises "Leave the token blank to keep the saved one". This
    // is what keeps that promise: a blank token on a re-save carries the
    // stored one forward instead of failing, which is what an operator adding
    // ONLY a verify token is doing.
    // 2026-09-26 (break test): the stored token is only read when no new one
    // was typed, and a token that can no longer be read (the server's
    // encryption key changed) counts as "none saved". Before, that stored
    // token was always decrypted first, so pasting a NEW token failed with
    // "Failed to decrypt secret…" and the owner had no way to fix it.
    const newToken = input.accessToken?.trim();
    const carried = !newToken && existing ? readableSecret(existing.encryptedApiKey, workspaceId) : "";
    const accessToken = newToken || carried;
    if (!accessToken || !input.phoneNumberId?.trim()) {
      throw new NeedsActionError("WhatsApp access token and phone number ID are both required.", 400);
    }
    // The verify token is a shared secret — Meta echoes it back on the
    // subscription handshake — so it is encrypted at rest like the access
    // token, never stored or returned in the clear. undefined leaves the
    // stored one alone; "" clears it.
    const storedVerifyRaw = typeof existing?.config?.encryptedVerifyToken === "string" ? existing.config.encryptedVerifyToken : undefined;
    // An unreadable stored verify token is dropped rather than carried.
    const storedVerify = storedVerifyRaw && readableSecret(storedVerifyRaw, workspaceId) ? storedVerifyRaw : undefined;
    const encryptedVerifyToken = input.verifyToken === undefined
      ? storedVerify
      : (input.verifyToken.trim() ? encryptSecret(input.verifyToken.trim(), workspaceId) : undefined);
    const payload = {
      provider: CRED_PROVIDER,
      displayName: "WhatsApp Cloud",
      encryptedApiKey: encryptSecret(accessToken, workspaceId),
      status: "connected" as const,
      config: {
        phoneNumberId: input.phoneNumberId.trim(),
        businessAccountId: input.businessAccountId?.trim() || undefined,
        encryptedVerifyToken,
      },
    };
    if (existing) {
      await this.repos.llmProviderCredential.update(workspaceId, existing.id, payload);
    } else {
      await this.repos.llmProviderCredential.create(workspaceId, payload);
    }
  }

  /** Remove the workspace's WhatsApp credentials (provider falls back to env). */
  async clear(workspaceId: string): Promise<void> {
    const existing = await this.findRow(workspaceId);
    if (existing) {
      await this.repos.llmProviderCredential.delete(workspaceId, existing.id);
    }
  }

  /**
   * Resolve a MetaWhatsAppCloudProvider for this workspace — per-workspace creds
   * override env (CP-17c). This is the helper the SEND paths use so a customer's
   * saved credentials take effect when the owner approves a reply. If the
   * workspace has no creds, the provider falls back to env (unchanged behaviour).
   */
  async resolveProvider(workspaceId: string): Promise<MetaWhatsAppCloudProviderType> {
    const creds = await this.getForProvider(workspaceId);
    // Import dynamically to avoid a circular import at module load.
    const { MetaWhatsAppCloudProvider } = await import("@/providers/whatsapp/MetaWhatsAppCloudProvider");
    return new MetaWhatsAppCloudProvider(creds);
  }

  /**
   * Resolve the credentials for the MetaWhatsAppCloudProvider. Returns undefined
   * when the workspace has none → the provider then falls back to env (CP-17c).
   */
  async getForProvider(workspaceId: string): Promise<WhatsAppCloudCreds | undefined> {
    const row = await this.findRow(workspaceId);
    if (!row) return undefined;
    const accessToken = decryptSecret(row.encryptedApiKey, workspaceId);
    const phoneNumberId = typeof row.config?.phoneNumberId === "string" ? row.config.phoneNumberId : undefined;
    if (!accessToken || !phoneNumberId) return undefined;
    return {
      accessToken,
      phoneNumberId,
      businessAccountId: typeof row.config?.businessAccountId === "string" ? row.config.businessAccountId : undefined,
    };
  }

  /**
   * The webhook verify token this workspace saved, or undefined.
   *
   * WHY THIS EXISTS: the token and phone number ID that let the product SEND
   * are set by the operator in Integrations, but the verify token that lets it
   * RECEIVE was read only from a server environment variable. A customer who
   * connected their own WhatsApp through the UI could send and could never be
   * replied to, and had no way to fix it without shell access to the server.
   */
  async getVerifyToken(workspaceId: string): Promise<string | undefined> {
    const row = await this.findRow(workspaceId);
    const encrypted = typeof row?.config?.encryptedVerifyToken === "string" ? row.config.encryptedVerifyToken : undefined;
    if (!encrypted) return undefined;
    return decryptSecret(encrypted, workspaceId) || undefined;
  }

  /** A masked view for the UI — never the raw token. */
  async getView(workspaceId: string): Promise<WhatsAppCredView> {
    const row = await this.findRow(workspaceId);
    if (!row) return { hasCredentials: false };
    // 2026-09-26 (break test): an unreadable saved token (encryption key
    // changed) made this view throw, so the Integrations screen failed to
    // load. It now shows as "not connected" so the owner can paste it again.
    const raw = readableSecret(row.encryptedApiKey, workspaceId);
    return {
      hasCredentials: Boolean(raw),
      accessTokenPreview: raw ? maskSecret(raw) : undefined,
      phoneNumberId: typeof row.config?.phoneNumberId === "string" ? row.config.phoneNumberId : undefined,
      businessAccountId: typeof row.config?.businessAccountId === "string" ? row.config.businessAccountId : undefined,
      hasVerifyToken: typeof row.config?.encryptedVerifyToken === "string" && row.config.encryptedVerifyToken.length > 0,
    };
  }

  /**
   * Test a set of credentials against Meta WITHOUT saving them. Validates the
   * POSTED values (CP-17d) — the user sees the result before committing. The
   * fetch is injectable for the golden (deterministic, no network).
   */
  async testConnection(input: WhatsAppTestInput, options: { fetchImpl?: typeof fetch } = {}): Promise<WhatsAppTestResult> {
    if (!input.accessToken?.trim() || !input.phoneNumberId?.trim()) {
      return { ok: false, status: "not_configured", message: "Access token and phone number ID are both required to test." };
    }
    const url = `https://graph.facebook.com/v20.0/${input.phoneNumberId.trim()}`;
    const safety = await assertSafeFetchUrl(url);
    if (!safety.safe) return { ok: false, status: "unknown_error", message: `URL blocked: ${safety.reason}` };
    const fetchFn = options.fetchImpl ?? fetch;
    try {
      const response = (await fetchFn(safety.url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${input.accessToken.trim()}` },
        signal: AbortSignal.timeout(15000),
      } as never)) as { ok: boolean; status: number; json: () => Promise<Record<string, unknown>> };
      const payload = await response.json().catch(() => ({}));
      const err = (payload as { error?: { code?: number; message?: string } }).error;
      if (!response.ok) {
        const code = err?.code;
        const msg = err?.message || `Meta returned ${response.status}`;
        if (code === 190 || /access token/i.test(msg)) {
          return { ok: false, status: "auth_failed", message: `Access token rejected by Meta (code ${code}): ${msg}. Generate a new System User token in Meta Business Manager.` };
        }
        if (code === 100 || /not found|does not exist/i.test(msg)) {
          return { ok: false, status: "wrong_number", message: `Phone number ID not found (code ${code}): ${msg}. Check the phone number ID in Meta → WhatsApp → Phone Numbers.` };
        }
        if (code === 4 || code === 17 || response.status === 429) {
          return { ok: false, status: "rate_limited", message: `Meta rate-limited the test (code ${code}). Wait a minute and try again.` };
        }
        return { ok: false, status: "unknown_error", message: `Meta rejected the request (code ${code}): ${msg}` };
      }
      const p = payload as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
      return {
        ok: true,
        status: "connected",
        message: `Connected. WhatsApp number ${p.display_phone_number || "(unknown)"} (${p.verified_name || "unverified"}) is reachable.`,
        displayPhoneNumber: p.display_phone_number,
        qualityRating: p.quality_rating,
      };
    } catch (e) {
      return { ok: false, status: "network_error", message: `Could not reach Meta: ${e instanceof Error ? e.message : "network error"}.` };
    }
  }

  private async findRow(workspaceId: string) {
    const all = await this.repos.llmProviderCredential.listByWorkspace(workspaceId);
    return all.find((c) => c.provider === CRED_PROVIDER);
  }
}
