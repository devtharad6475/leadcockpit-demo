/**
 * golden-security-libs.ts — pins the security/safety CHOKEPOINT libraries that
 * had no golden of their own (Stage 6 / 2026-07-31 coverage sweep).
 *
 * WHY THIS TEST EXISTS:
 *   The full-tree Coverage Map found that 3 security-critical lib files were
 *   DARK (no golden directly exercised them). An untested regression in any of
 *   these is dangerous — they are the gates that stop prototype pollution,
 *   forged webhooks, and privilege escalation. This golden closes them:
 *     - safe-body.ts        (parseBodySafely + sanitizePrototypeKeys — the
 *                            prototype-pollution defense at the API boundary)
 *     - webhook-signature.ts (readAndVerifyWebhookBody — HMAC-SHA256
 *                            verification of Meta webhooks; fail-closed in prod)
 *     - permissions.ts      (the 9 canX role checks — the RBAC ladder)
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — written before running):
 *
 *   CASE A — sanitizePrototypeKeys strips __proto__/constructor/prototype
 *     recursively (nested objects + arrays), leaves all other keys intact.
 *   CASE B — parseBodySafely: empty body → ok:{} ; valid object → ok:sanitized ;
 *     malformed JSON → ok:false reason:"malformed" ; a JSON array/number/null
 *     → ok:false (must be an object).
 *   CASE C — readAndVerifyWebhookBody: a CORRECT signature → ok:rawBody ; a
 *     WRONG signature → ok:false status:401 ; missing header → 401. The HMAC
 *     is computed by hand with node crypto against a known secret+body.
 *   CASE D — permissions ladder: owner≥admin≥sales_member≥viewer for the
 *     admin-gated checks; canApproveLead lets sales_member+; canManageMembers
 *     is owner-ONLY; canExportData is owner-ONLY; canViewAnalytics lets viewer+.
 *
 * Run: npx tsx scripts/golden/golden-security-libs.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { sanitizePrototypeKeys, parseBodySafely } from "@/lib/safe-body";
import { readAndVerifyWebhookBody } from "@/lib/webhook-signature";
import {
  canManageWorkspace,
  canEditKnowledge,
  canApproveCampaign,
  canApproveLead,
  canConfigureAI,
  canConfigureIntegrations,
  canExportData,
  canViewAnalytics,
  canManageMembers,
} from "@/lib/permissions";
import type { WorkspaceRole } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

function makeJsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ─── CASE A: sanitizePrototypeKeys ──────────────────────────────────────────
test("CASE A — sanitizePrototypeKeys strips __proto__/constructor/prototype recursively; keeps rest", async () => {
  // The REALISTIC attack vector: JSON.parse makes __proto__ an OWN enumerable
  // key (an object literal does NOT — __proto__ in a literal sets the prototype
  // chain at creation and never becomes an own key). The sanitizer defends the
  // JSON.parse path, so we test with the parsed shape it actually faces.
  const input = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"evil","legit":"keep","nested":{"__proto__":{"x":1},"ok":2},"arr":[{"__proto__":{"y":1}},{"z":3}]}',
  );
  const out = sanitizePrototypeKeys(input);
  // Dangerous keys removed at every level (check via hasOwnProperty — the
  // sanitizer deletes the own key).
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "__proto__"), "top-level __proto__ stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "constructor"), "top-level constructor stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "prototype"), "top-level prototype stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(out.nested, "__proto__"), "nested __proto__ stripped");
  assert.ok(!Object.prototype.hasOwnProperty.call(out.arr[0], "__proto__"), "array-item __proto__ stripped");
  // Legitimate keys survive.
  assert.strictEqual(out.legit, "keep");
  assert.strictEqual(out.nested.ok, 2);
  assert.strictEqual(out.arr[1].z, 3);
});

// ─── CASE B: parseBodySafely ────────────────────────────────────────────────
test("CASE B — parseBodySafely: empty→{}; valid→sanitized; malformed→ok:false; non-object→ok:false", async () => {
  // Empty body.
  const empty = await parseBodySafely(new NextRequest("http://x/api", { method: "POST" }));
  assert.strictEqual(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.value, {});

  // Valid object WITH a prototype-polluting key (JSON.parse attack shape) →
  // the parsed __proto__ is stripped.
  const valid = await parseBodySafely(makeJsonRequest('{"__proto__":{"x":1},"name":"abc"}'));
  assert.strictEqual(valid.ok, true);
  if (valid.ok) {
    assert.ok(!Object.prototype.hasOwnProperty.call(valid.value, "__proto__"), "valid body's __proto__ stripped");
    assert.strictEqual(valid.value.name, "abc");
  }

  // Malformed JSON → ok:false reason "malformed".
  const malformed = await parseBodySafely(makeJsonRequest("{not json"));
  assert.strictEqual(malformed.ok, false);
  if (!malformed.ok) assert.strictEqual(malformed.reason, "malformed");

  // A JSON array (not an object) → ok:false (must be an object).
  const array = await parseBodySafely(makeJsonRequest("[1,2,3]"));
  assert.strictEqual(array.ok, false);
  // A JSON number → ok:false.
  const number = await parseBodySafely(makeJsonRequest("42"));
  assert.strictEqual(number.ok, false);
});

// ─── CASE C: readAndVerifyWebhookBody (HMAC) ────────────────────────────────
test("CASE C — readAndVerifyWebhookBody: correct sig ok; wrong sig 401; missing header 401", async () => {
  const SECRET = "test-app-secret-2026";
  const BODY = '{"entry":[{"id":"123"}]}';
  const prevSecret = process.env.WHATSAPP_APP_SECRET;
  process.env.WHATSAPP_APP_SECRET = SECRET;
  try {
    // Correct signature → ok.
    const goodSig = "sha256=" + createHmac("sha256", SECRET).update(BODY).digest("hex");
    const goodReq = new NextRequest("http://x/api/inbound/whatsapp-webhook", {
      method: "POST", body: BODY, headers: { "x-hub-signature-256": goodSig },
    });
    const good = await readAndVerifyWebhookBody(goodReq);
    assert.strictEqual(good.ok, true, "correct signature must pass");
    if (good.ok) assert.strictEqual(good.rawBody, BODY);

    // Wrong signature → 401.
    const badReq = new NextRequest("http://x/api/inbound/whatsapp-webhook", {
      method: "POST", body: BODY, headers: { "x-hub-signature-256": "sha256=deadbeef" },
    });
    const bad = await readAndVerifyWebhookBody(badReq);
    assert.strictEqual(bad.ok, false, "wrong signature must fail");
    if (!bad.ok) assert.strictEqual(bad.status, 401);

    // Missing header → 401.
    const noHeaderReq = new NextRequest("http://x/api/inbound/whatsapp-webhook", { method: "POST", body: BODY });
    const noHeader = await readAndVerifyWebhookBody(noHeaderReq);
    assert.strictEqual(noHeader.ok, false, "missing header must fail");
    if (!noHeader.ok) assert.strictEqual(noHeader.status, 401);
  } finally {
    if (prevSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = prevSecret;
  }
});

// ─── CASE D: permissions ladder ─────────────────────────────────────────────
test("CASE D — permissions RBAC ladder: role-rank gate per action", async () => {
  const ROLES: WorkspaceRole[] = ["viewer", "sales_member", "admin", "owner"];
  // canViewAnalytics: everyone (viewer+).
  for (const r of ROLES) assert.strictEqual(canViewAnalytics(r), true, `canViewAnalytics(${r})`);
  // canApproveLead: sales_member+ (NOT viewer).
  assert.strictEqual(canApproveLead("viewer"), false);
  assert.strictEqual(canApproveLead("sales_member"), true);
  assert.strictEqual(canApproveLead("owner"), true);
  // Admin-gated (workspace/knowledge/campaign/AI/integrations): admin+ (NOT viewer/sales_member).
  const adminGates = [canManageWorkspace, canEditKnowledge, canApproveCampaign, canConfigureAI, canConfigureIntegrations];
  for (const fn of adminGates) {
    assert.strictEqual(fn("sales_member"), false, `${fn.name} blocks sales_member`);
    assert.strictEqual(fn("admin"), true, `${fn.name} allows admin`);
    assert.strictEqual(fn("owner"), true, `${fn.name} allows owner`);
  }
  // owner-ONLY: canExportData + canManageMembers.
  assert.strictEqual(canExportData("admin"), false, "canExportData blocks admin");
  assert.strictEqual(canExportData("owner"), true);
  assert.strictEqual(canManageMembers("admin"), false, "canManageMembers blocks admin (owner-only)");
  assert.strictEqual(canManageMembers("owner"), true);
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-security-libs FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-security-libs ALL GREEN ✅");
  process.exit(0);
})();
