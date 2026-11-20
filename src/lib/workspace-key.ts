/**
 * Per-workspace encryption-key derivation (Stage 5 / WP1, D-2026-07-28-a).
 *
 * WHY THIS EXISTS
 *   Every workspace's stored credentials (WhatsApp API keys, LLM provider
 *   keys, etc.) used to be encrypted with ONE shared master key = SHA-256 of
 *   the ENCRYPTION_KEY env var. Per D-2026-07-28-a, each workspace now gets a
 *   DERIVED key via HKDF-SHA256 from:
 *     - ikm (input keying material) = the master key bytes
 *     - info                       = `${WORKSPACE_KEY_INFO_PREFIX}${workspaceId}`
 *   The workspaceId is bound into the HKDF `info` parameter, so:
 *     - Two workspaces NEVER share a key.
 *     - Rotating ENCRYPTION_KEY invalidates every derived key.
 *     - Deleting a workspace → the app no longer knows the workspaceId to
 *       pass → its stored secrets become unreadable (DPDPA "delete = keys
 *       gone" posture). HKDF is a pure function (no per-process randomness),
 *       so there is nothing to persist and lose.
 *
 * THE CONTRACT (pinned by golden:workspace-key)
 *   - deriveWorkspaceKey(master, workspaceId) is DETERMINISTIC: same inputs
 *     always produce the same 32-byte key, in this process and across
 *     processes.
 *   - Different workspaceId → different key. Different master → different key.
 *   - Output is exactly 32 bytes (AES-256 key length).
 *
 * HKDF CHOICE
 *   HKDF (RFC 5869) is the industry standard for deriving keys from a master
 *   key + context. Node ships it as crypto.hkdfSync (no external dependency).
 *   It's fast (microseconds), so per-secret derivation cost is negligible.
 *
 * USAGE
 *   credential-security.ts calls deriveWorkspaceKey to get the AES-256 key for
 *   a given workspace, then uses it for AES-256-GCM encrypt/decrypt. Callers
 *   that encrypt workspace-scoped secrets MUST pass workspaceId; callers that
 *   encrypt platform-level secrets (none yet) omit it and use the shared
 *   master key directly (backward compatible).
 */
import { hkdfSync, createHash } from "node:crypto";

/** Length of the derived AES-256 key (32 bytes = 256 bits). */
export const DERIVED_KEY_BYTES = 32;

/**
 * Prefix bound into the HKDF `info` parameter ahead of the workspaceId. This
 * namespaces LeadCockpit's derived keys so they cannot collide with any other
 * HKDF usage of the same master key. Exported so golden tests can document the
 * info shape (`golden:workspace-key` CASE I).
 */
export const WORKSPACE_KEY_INFO_PREFIX = "leadcockpit:workspace-key:v1:";

/**
 * Derive a per-workspace AES-256 key from the master ENCRYPTION_KEY + the
 * workspaceId via HKDF-SHA256.
 *
 * @param masterKey  The master key (the ENCRYPTION_KEY env var). Must be a
 *                   non-empty string. In production this is enforced to be
 *                   ≥16 chars by credential-security.ts before this is called.
 * @param workspaceId The workspace whose key to derive. Used verbatim (not
 *                   normalized) so two distinct ids always produce distinct
 *                   keys.
 * @returns A 32-byte Buffer (AES-256 key).
 */
export function deriveWorkspaceKey(masterKey: string, workspaceId: string): Buffer {
  if (!masterKey) {
    throw new Error("deriveWorkspaceKey: masterKey (ENCRYPTION_KEY) is required.");
  }
  if (!workspaceId) {
    throw new Error("deriveWorkspaceKey: workspaceId is required (cannot derive a key without it).");
  }
  // ikm = the master key, hashed to a fixed-length input for HKDF. HKDF
  // tolerates variable-length ikm, but hashing first gives a clean 32-byte
  // input and matches the existing deriveKey() shape in credential-security.
  const ikm = createHash("sha256").update(masterKey).digest();
  // info binds the workspaceId (with a versioned prefix) into the derivation.
  const info = `${WORKSPACE_KEY_INFO_PREFIX}${workspaceId}`;
  // salt = empty (the workspaceId is already in info; adding it to salt too
  // would be redundant). HKDF-Extract uses HMAC(salt, ikm); an empty salt
  // defaults to a string of HashLen zeros per RFC 5869, which is fine here
  // because ikm is already high-entropy (a hashed master key).
  const derived = hkdfSync("sha256", ikm, "", info, DERIVED_KEY_BYTES);
  return Buffer.from(derived);
}
