/**
 * Secret encryption (AES-256-GCM).
 *
 * Session 2 audit fix: this previously used plain Base64 ("demo_encrypted:")
 * which is reversible encoding, NOT encryption. Anyone with file/DB read
 * access could recover every stored API key. It is now real authenticated
 * encryption backed by Node's crypto.
 *
 * Format (new): aes-gcm-v1:<ivHex>:<tagHex>:<ciphertextHex>
 *   - AES-256-GCM with a random 12-byte IV per secret.
 *   - The 16-byte GCM auth tag is stored alongside the ciphertext so tampering
 *     is detected on decrypt (throws instead of returning garbage).
 *   - The 256-bit key is derived from ENCRYPTION_KEY via SHA-256, so any
 *     sufficiently-long passphrase becomes a valid key.
 *
 * Backward compatibility (migration):
 *   - decryptSecret() still recognizes the old "demo_encrypted:" Base64 format
 *     and the legacy "placeholder_encrypted_" format, so existing demo data
 *     keeps working. Old-format values are NOT re-encrypted automatically
 *     (they are only migrated the next time the user saves that key).
 *   - All NEW writes use aes-gcm-v1.
 *
 * Mode behavior:
 *   - production: ENCRYPTION_KEY (>= 16 chars) is REQUIRED to write or read
 *     AES-GCM secrets. Missing key → throw. This is fail-closed.
 *   - demo/local: if ENCRYPTION_KEY is unset, we derive a deterministic
 *     throwaway key so the demo still round-trips secrets without forcing the
 *     user to configure anything. This is explicitly NOT secure and is only
 *     acceptable because demo mode never exposes real credentials.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { maskSecret, redactSecretsFromObject } from "./secret-redaction";
import { deriveWorkspaceKey } from "./workspace-key";

const VERSION_TAG = "aes-gcm-v1";
/**
 * Stage 5 / WP1 (2026-07-28) — Per-workspace key tag. Secrets encrypted with
 * a per-workspace HKDF-derived key carry this tag. CRITICALLY, the workspaceId
 * is NOT embedded in the format — the caller MUST supply it at decrypt time
 * (from their own knowledge / the DB row's workspaceId). This is what makes
 * "delete workspace = keys gone" hold: the encrypted blob alone does not
 * reveal which workspaceId to derive, and once the workspace row is deleted
 * the app has no way to look it up.
 *
 * Format: `aes-gcm-ws:<ivHex>:<tagHex>:<ciphertextHex>`
 * (same shape as aes-gcm-v1, just a different tag prefix)
 */
const WORKSPACE_VERSION_TAG = "aes-gcm-ws";
const LEGACY_DEMO_PREFIX = "demo_encrypted:";
const LEGACY_PLACEHOLDER_PREFIX = "placeholder_encrypted_";
const IV_BYTES = 12;
// AES-256 uses a 32-byte key; deriveKey() produces this via SHA-256, so the
// constant is implicit and not referenced directly elsewhere.

/**
 * Derive the 256-bit AES key from ENCRYPTION_KEY. In demo/local we allow a
 * deterministic fallback so the JSON demo round-trips without setup; in
 * production we require a real, adequately-long key.
 *
 * Stage 5 / WP1: when a workspaceId is provided, the SHARED master key is
 * replaced by a per-workspace HKDF-derived key (D-2026-07-28-a). This is the
 * chokepoint every workspace-scoped secret MUST go through.
 */
function deriveKey(workspaceId?: string): Buffer {
  const configured = process.env.ENCRYPTION_KEY;
  const mode = process.env.AUTH_MODE;
  if (mode === "production") {
    if (!configured || configured.length < 16) {
      throw new Error("ENCRYPTION_KEY must be set to a random value of at least 16 characters before encrypting production credentials.");
    }
  }
  const source = configured || "dev-only-throwaway-encryption-key-do-not-use-in-production";
  // Per-workspace key (D-2026-07-28-a): derive via HKDF when a workspaceId is
  // given. No workspaceId → shared master key (platform-level secrets; none
  // yet, but backward-compatible).
  return workspaceId ? deriveWorkspaceKey(source, workspaceId) : createHash("sha256").update(source).digest();
}

/**
 * Encrypt a plaintext secret into the aes-gcm-v1 transport format.
 *
 * Stage 5 / WP1 (2026-07-28): if `workspaceId` is provided, the secret is
 * encrypted with the per-workspace HKDF-derived key (format `aes-gcm-ws`).
 * If omitted, the shared master key is used (format `aes-gcm-v1` — backward
 * compatible with all existing callers). Per D-2026-07-28-a, workspace-scoped
 * secrets (customer API keys) MUST pass workspaceId.
 */
export function encryptSecret(secret: string | undefined | null, workspaceId?: string): string | undefined {
  if (!secret) return undefined;
  const key = deriveKey(workspaceId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const tagPrefix = workspaceId ? WORKSPACE_VERSION_TAG : VERSION_TAG;
  return `${tagPrefix}:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypt a stored secret. Supports:
 *   - aes-gcm-ws:<iv>:<tag>:<ciphertext>  (per-workspace key — REQUIRES workspaceId arg)
 *   - aes-gcm-v1:<iv>:<tag>:<ciphertext>  (shared master key)
 *   - demo_encrypted:<base64>             (legacy, migration only)
 *   - placeholder_encrypted_<masked>      (legacy, never real)
 *
 * Stage 5 / WP1: for an `aes-gcm-ws` secret, the workspaceId is NOT in the
 * format (by design — see WORKSPACE_VERSION_TAG). The caller MUST pass it.
 * This is what enforces "delete workspace = keys gone": without the
 * workspaceId, the per-workspace key cannot be reconstructed. The GCM
 * auth-tag also fails if the wrong workspaceId is passed (defense-in-depth).
 *
 * Throws on tampering (GCM auth-tag mismatch) rather than returning garbage,
 * because silently returning a wrong key is worse than a loud failure.
 */
export function decryptSecret(encrypted: string | undefined | null, workspaceId?: string): string | undefined {
  if (!encrypted) return undefined;

  // Per-workspace format: aes-gcm-ws:<iv>:<tag>:<ciphertext> (NO embedded wsId)
  if (encrypted.startsWith(`${WORKSPACE_VERSION_TAG}:`)) {
    if (!workspaceId) {
      throw new Error("Failed to decrypt workspace-scoped secret: workspaceId is required (the format intentionally does not carry it).");
    }
    const parts = encrypted.split(":");
    if (parts.length !== 4) throw new Error("Malformed encrypted secret (wrong field count for workspace-scoped secret).");
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const ciphertext = Buffer.from(parts[3], "hex");
    if (iv.length !== IV_BYTES) throw new Error("Malformed encrypted secret (bad IV length).");
    const key = deriveKey(workspaceId);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Failed to decrypt secret: data is corrupt, tampered, or was encrypted with a different key (wrong workspaceId or ENCRYPTION_KEY).");
    }
  }

  // Shared-master format: aes-gcm-v1:<iv>:<tag>:<ciphertext>
  if (encrypted.startsWith(`${VERSION_TAG}:`)) {
    const parts = encrypted.split(":");
    if (parts.length !== 4) throw new Error("Malformed encrypted secret (wrong field count).");
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const ciphertext = Buffer.from(parts[3], "hex");
    if (iv.length !== IV_BYTES) throw new Error("Malformed encrypted secret (bad IV length).");
    const key = deriveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Failed to decrypt secret: data is corrupt, tampered, or was encrypted with a different ENCRYPTION_KEY.");
    }
  }

  // Legacy format 1: demo_encrypted:<base64>  (reversible base64 — migration only)
  if (encrypted.startsWith(LEGACY_DEMO_PREFIX)) {
    try {
      return Buffer.from(encrypted.slice(LEGACY_DEMO_PREFIX.length), "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }

  // Legacy format 2: placeholder_encrypted_<masked>  (the masked form is
  // unrecoverable — these were never real credentials, just UI placeholders.
  // Return undefined so the caller treats it as "no key configured".)
  if (encrypted.startsWith(LEGACY_PLACEHOLDER_PREFIX)) {
    return undefined;
  }

  // Unknown format: return as-is (some callers store pre-formatted values).
  return encrypted;
}

/**
 * Decrypt for display / carry-forward only: undefined when the stored value
 * can no longer be read (2026-09-26 break test). Paths that USE a secret to
 * send or call out still use decryptSecret and throw loudly — quietly falling
 * back to the server's own number or key would be worse.
 */
export function readableSecret(encrypted: string | undefined | null, workspaceId: string): string | undefined {
  try {
    return decryptSecret(encrypted, workspaceId);
  } catch (e) {
    console.error(`[credentials] a saved secret for workspace ${workspaceId} could not be read and must be entered again:`, (e as Error).message);
    return undefined;
  }
}

/** Returns true if a stored value is in either AES-GCM format (shared or per-workspace). */
export function isEncryptedWithAesGcm(encrypted: string | undefined | null): boolean {
  return Boolean(
    encrypted &&
      (encrypted.startsWith(`${VERSION_TAG}:`) || encrypted.startsWith(`${WORKSPACE_VERSION_TAG}:`)),
  );
}

/** Returns true if a stored value is in either legacy (insecure) format. */
export function isLegacyInsecureFormat(encrypted: string | undefined | null): boolean {
  if (!encrypted) return false;
  return encrypted.startsWith(LEGACY_DEMO_PREFIX) || encrypted.startsWith(LEGACY_PLACEHOLDER_PREFIX);
}

export function secretPreview(secret: string | undefined | null) {
  return maskSecret(secret);
}

export function assertNoSecretsInResponse<T>(value: T): T {
  return redactSecretsFromObject(value);
}
