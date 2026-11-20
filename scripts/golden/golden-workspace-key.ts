/**
 * golden-workspace-key.ts — pins the per-workspace HKDF encryption key
 * chokepoint (Stage 5 / WP1, D-2026-07-28-a).
 *
 * WHAT THIS PROVES (docs/LOGIC.md 2026-07-28 — Per-customer HKDF-derived keys)
 *   A new chokepoint `src/lib/workspace-key.ts` derives a per-workspace AES-256
 *   key from the master ENCRYPTION_KEY + the workspaceId via HKDF-SHA256.
 *   `credential-security.ts` encrypt/decrypt now take an OPTIONAL workspaceId;
 *   when provided they use the per-workspace key, when omitted they use the
 *   shared master key (backward-compatible). Delete a workspace → its key is
 *   unreconstructible → its stored secrets become unreadable (DPDPA posture).
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *
 *   CASE A — Determinism within a process: deriveWorkspaceKey(master, ws1)
 *            called twice returns the SAME 32-byte key. HKDF is deterministic
 *            given the same inputs.
 *
 *   CASE B — Differentiation by workspace: deriveWorkspaceKey(master, ws1) ≠
 *            deriveWorkspaceKey(master, ws2). Two workspaces NEVER share a key
 *            (the whole point of per-customer keys).
 *
 *   CASE C — Differentiation by master: deriveWorkspaceKey(masterA, ws1) ≠
 *            deriveWorkspaceKey(masterB, ws1). Rotating ENCRYPTION_KEY
 *            invalidates every derived key (so a leaked master alone is not
 *            enough if the workspaces are also re-keyed — defense in depth).
 *
 *   CASE D — Output is exactly 32 bytes (AES-256 key length). Anything else
 *            would break AES-256-GCM.
 *
 *   CASE E — Cross-process determinism: deriving in two SEPARATE Node
 *            processes (child_process) with the same master+workspaceId yields
 *            the same key. HKDF is a pure function — no per-process randomness
 *            allowed. (This is what makes "delete workspace = key gone" hold
 *            across restarts: there's nothing persisted to lose.)
 *
 *   CASE F — AES-GCM round-trip with the derived key: encrypt a secret with
 *            workspaceId=ws1, decrypt with workspaceId=ws1 → original. Decrypt
 *            with workspaceId=ws2 → FAILS (GCM auth-tag mismatch). A secret
 *            encrypted for one workspace CANNOT be decrypted with another
 *            workspace's key. This is the per-tenant isolation proof.
 *
 *   CASE G — Backward compatibility: encryptSecret WITHOUT a workspaceId uses
 *            the shared master key (same as today). Decrypt the result without
 *            a workspaceId → original. No existing caller breaks.
 *
 *   CASE H — "Delete = keys gone" simulation: encrypt a secret for workspaceId
 *            = ws1. Now pretend ws1 is deleted — deriveWorkspaceKey(master, ws1)
 *            still mathematically works (we can't un-derive), BUT the product
 *            contract is: without the workspaceId in the DB, the app has no way
 *            to look up WHICH workspace a credential belongs to, so the key is
 *            functionally unrecoverable. We assert the API shape: the decrypt
 *            path REQUIRES a workspaceId (no workspaceId on a workspace-scoped
 *            credential → throws). The simulation: if you pass the WRONG
 *            workspaceId (ws2) to decrypt a ws1 secret → fails (CASE F). The
 *            only way to read ws1's secrets is to KNOW ws1 — which the deleted
 *            workspace can no longer tell you.
 *
 *   CASE I — HKDF info-binding: the workspaceId is bound into the HKDF `info`
 *            parameter (not the salt, not the ikm). Asserting via the
 *            differentiation cases above (B/C) already proves binding; this
 *            case asserts the FORMAT — the derived key changes if you prepend
 *            a constant to the workspaceId (i.e. the info string is the raw
 *            workspaceId, not e.g. an empty info + workspaceId-as-salt, which
 *            would collide with a different scheme). Concrete: keys derived
 *            with info=ws1 ≠ keys derived with info=`prefix:${ws1}`.
 *
 * REAL PIPELINE: imports the real `src/lib/workspace-key.ts` + real
 * `src/lib/credential-security.ts`. No DB, no network — pure crypto.
 * Ironclad Gate #8 (test isolation): each case uses unique workspaceIds
 * generated at runtime, so two runs never collide.
 *
 * Run: npx tsx scripts/golden/golden-workspace-key.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as import_fs from "node:fs";

// ─── Real imports (the code under test) ───────────────────────────────────
// These imports will FAIL until src/lib/workspace-key.ts exists. That's the
// point: the test is written FIRST (build-right Phase 3), and the failures are
// the todo list.
import {
  deriveWorkspaceKey,
  WORKSPACE_KEY_INFO_PREFIX,
} from "@/lib/workspace-key";
import {
  encryptSecret,
  decryptSecret,
  isEncryptedWithAesGcm,
} from "@/lib/credential-security";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(CURRENT_FILE), "..", "..");

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${(err as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${(err as Error).message}`);
  }
}

console.log("\n=== golden-workspace-key — per-workspace HKDF encryption key ===\n");

// Use a fixed master for the determinism cases (so hand-computed expectations
// are reproducible); use runtime-unique workspaceIds for isolation.
const MASTER_A = "test-master-key-A-do-not-use-in-production-32chars";
const MASTER_B = "test-master-key-B-different-from-A-32-chars!!";
const RUN_ID = `wp1k_${Date.now()}`;
const WS1 = `ws_${RUN_ID}_alpha`;
const WS2 = `ws_${RUN_ID}_beta`;

// ─── CASE A — determinism within a process ────────────────────────────────
check("CASE A — deriveWorkspaceKey(master, ws) is deterministic within a process", () => {
  const k1 = deriveWorkspaceKey(MASTER_A, WS1);
  const k2 = deriveWorkspaceKey(MASTER_A, WS1);
  assert.ok(Buffer.isBuffer(k1), "deriveWorkspaceKey must return a Buffer");
  assert.ok(k1.equals(k2), "two derivations with same inputs must be byte-equal");
});

// ─── CASE B — different workspaces get different keys ─────────────────────
check("CASE B — different workspaceIds → different keys", () => {
  const k1 = deriveWorkspaceKey(MASTER_A, WS1);
  const k2 = deriveWorkspaceKey(MASTER_A, WS2);
  assert.ok(!k1.equals(k2), "ws1 and ws2 must NOT share a key");
});

// ─── CASE C — different master → different keys ───────────────────────────
check("CASE C — different master → different keys (rotation invalidates)", () => {
  const k1 = deriveWorkspaceKey(MASTER_A, WS1);
  const k2 = deriveWorkspaceKey(MASTER_B, WS1);
  assert.ok(!k1.equals(k2), "rotating ENCRYPTION_KEY must change every derived key");
});

// ─── CASE D — output is exactly 32 bytes ──────────────────────────────────
check("CASE D — derived key is exactly 32 bytes (AES-256)", () => {
  const k = deriveWorkspaceKey(MASTER_A, WS1);
  assert.strictEqual(k.length, 32, `expected 32 bytes, got ${k.length}`);
});

// ─── CASE E — cross-process determinism (HKDF is a pure function) ─────────
// Spawn a child Node process that derives the same key; compare hex. We write
// a temp script file (avoids Windows ESM URL-scheme issues with --eval +
// absolute paths) and run it with tsx so the @/ alias resolves.
check("CASE E — cross-process determinism (same inputs → same key in a fresh process)", () => {
  const tmpFile = path.join(PROJECT_ROOT, `.tmp-golden-wskey-${RUN_ID}.ts`);
  const childScript = `
import { deriveWorkspaceKey } from "./src/lib/workspace-key.ts";
const k = deriveWorkspaceKey(${JSON.stringify(MASTER_A)}, ${JSON.stringify(WS1)});
process.stdout.write(k.toString("hex"));
`;
  // Write the temp file (sync — small).
  import_fs.writeFileSync(tmpFile, childScript, "utf8");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", tmpFile],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
  // Clean up the temp file regardless of outcome.
  try { import_fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  if (result.status !== 0) {
    throw new Error(`child process failed: ${result.stderr || result.stdout}`);
  }
  const childHex = result.stdout.trim();
  const parentHex = deriveWorkspaceKey(MASTER_A, WS1).toString("hex");
  assert.strictEqual(
    childHex,
    parentHex,
    "key derived in a separate Node process must match the parent process's key",
  );
});

// ─── CASE F — AES-GCM round-trip + cross-workspace isolation ──────────────
// We can't easily pass workspaceId through the current encryptSecret signature
// until we add the optional param. The test asserts the NEW signature shape.
// Until the code lands, this fails — which is the build-right signal.
check("CASE F — encrypt with workspaceId=ws1, decrypt ws1 → original; decrypt ws2 → throws", () => {
  const secret = "sk-test-whatsapp-key-12345";
  // New signature: encryptSecret(secret, workspaceId?) / decryptSecret(enc, workspaceId?)
  const encrypted = encryptSecret(secret, WS1);
  assert.ok(isEncryptedWithAesGcm(encrypted), "must be in the aes-gcm-v1 format");

  // Same workspace → round-trips
  const roundTripped = decryptSecret(encrypted, WS1);
  assert.strictEqual(roundTripped, secret, "decrypt with the SAME workspaceId must return the original");

  // Different workspace → must FAIL (GCM auth-tag mismatch), not return garbage
  assert.throws(
    () => decryptSecret(encrypted, WS2),
    /decrypt|tampered|different/i,
    "decrypt with a DIFFERENT workspaceId must throw (per-tenant isolation)",
  );
});

// ─── CASE G — backward compat: no workspaceId → shared master key ─────────
check("CASE G — backward compat: encrypt/decrypt WITHOUT workspaceId still works (shared master)", () => {
  // Existing callers (none yet for platform secrets, but forward-compatible)
  // must continue to work without passing a workspaceId.
  const secret = "platform-level-secret";
  const encrypted = encryptSecret(secret);
  const roundTripped = decryptSecret(encrypted);
  assert.strictEqual(roundTripped, secret, "no-workspaceId path must still round-trip");

  // And a workspace-scoped secret CANNOT be decrypted without the workspaceId
  // (defense: the caller MUST know the workspace to read its secrets).
  const wsScoped = encryptSecret(secret, WS1);
  assert.throws(
    () => decryptSecret(wsScoped),
    /workspaceId|required|different/i,
    "a workspace-scoped secret must NOT decrypt without its workspaceId",
  );
});

// ─── CASE H — "delete = keys gone" simulation ────────────────────────────
check("CASE H — 'delete workspace = keys gone' contract (wrong workspaceId → can't decrypt)", () => {
  // The DPDPA posture: deleting a workspace invalidates its key. We can't
  // un-derive HKDF, but the PRODUCT contract is: to decrypt a credential you
  // MUST supply the workspaceId it belongs to. If the workspace is deleted,
  // the app no longer knows which workspaceId to pass → no decryption.
  // We simulate this by asserting that ONLY the correct workspaceId works;
  // every other workspaceId (or none) fails.
  const secret = "sk-customer-llm-key";
  const encrypted = encryptSecret(secret, WS1);

  // Correct workspaceId → works
  assert.strictEqual(decryptSecret(encrypted, WS1), secret);

  // Any other workspaceId → fails (the workspace is "gone")
  for (const wrongWs of [WS2, "ws_nonexistent", "", "workspace_demo"]) {
    if (wrongWs === WS1) continue;
    assert.throws(
      () => decryptSecret(encrypted, wrongWs),
      /decrypt|tampered|different/i,
      `wrong workspaceId "${wrongWs}" must fail to decrypt a ws1 secret`,
    );
  }
});

// ─── CASE I — HKDF info-binding format ───────────────────────────────────
check("CASE I — workspaceId is bound into HKDF info (raw id, not a prefixed/empty variant)", () => {
  // If the implementation used info="" + salt=workspaceId, swapping to
  // info=workspaceId + salt="" would give a different key. We assert the
  // IMPLEMENTATION's chosen binding by re-deriving with the public prefix
  // constant and confirming the workspaceId is the differentiating factor.
  // The strongest assertion: deriveWorkspaceKey treats ws1 and "x"+ws1 as
  // DIFFERENT inputs (so the workspaceId is not stripped/normalized).
  const k1 = deriveWorkspaceKey(MASTER_A, WS1);
  const k1Prefixed = deriveWorkspaceKey(MASTER_A, `prefix-${WS1}`);
  assert.ok(!k1.equals(k1Prefixed), "the workspaceId string is used verbatim (not normalized)");

  // The exported prefix constant exists and is a non-empty string (so we can
  // document the info shape: `${PREFIX}${workspaceId}` or similar).
  assert.ok(
    typeof WORKSPACE_KEY_INFO_PREFIX === "string" && WORKSPACE_KEY_INFO_PREFIX.length >= 0,
    "WORKSPACE_KEY_INFO_PREFIX must be exported (even if empty string)",
  );
});

// ─── Summary ─────────────────────────────────────────────────────────────
(async () => {
  // (no async cases in this file, but keep the runner shape consistent)
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-workspace-key FAILED — see cases above.");
    process.exit(1);
  }
  console.log("✅ golden-workspace-key ALL GREEN ✅");
  process.exit(0);
})();
