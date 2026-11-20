/**
 * golden-settings-date-roundtrip.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Resolving extraction conflicts on the live Postgres deployment worked for
 * the first conflict in a settings area and returned 500 for the second:
 *
 *   Invalid `prisma.policySettings.upsert()` invocation:
 *   Invalid value for argument `createdAt`: input contains invalid characters.
 *   Expected ISO-8601 DateTime.
 *
 * The chain:
 *
 *   1. deserializeSettings spread the raw Prisma record, so `createdAt` came
 *      back as a Date — while SalesSettings/PolicySettings/CommunicationSettings
 *      all declare it `string`. The declared type was simply untrue.
 *   2. setSettingValue reads the existing row and writes it back with one
 *      field changed, carrying that Date along as `createdAt`.
 *   3. serializeSettings tested `typeof value === "object"` to decide what to
 *      JSON.stringify. A Date IS an object, so it produced the seven-character-
 *      longer string `"2026-09-07T17:44:21.470Z"` — quote marks included — and
 *      Postgres refused it.
 *
 * Why it looked intermittent: the FIRST write to an area has no existing row,
 * so there is no Date to round-trip and the create succeeds. Only the second
 * write fails. That made it look like one bad conflict record rather than a
 * broken update path, and it broke every settings update that reads before it
 * writes — extraction routing and conflict resolution both.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE the fix was run):
 *
 *   CASE A — a Date serializes to a bare ISO-8601 string. Not JSON. The
 *   defect is exactly one pair of quote characters, so this asserts the first
 *   character is a digit and that Date.parse accepts the result.
 *
 *   CASE B — real JSON fields still serialize as JSON. A "fix" that stopped
 *   stringifying objects would pass CASE A and silently corrupt every list-
 *   valued settings column.
 *
 *   CASE C — deserializeSettings honours its own declared type: createdAt and
 *   updatedAt come back as strings, so a caller that trusts the type is right.
 *
 *   CASE D — the full read-modify-write round trip, which is what actually
 *   broke. deserialize a row, change one field, serialize it, and every value
 *   handed back must be something Postgres accepts.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { serializeSettings, deserializeSettings } from "@/repositories/prisma";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

const CREATED = new Date("2026-09-07T17:44:21.470Z");

test("CASE A — a Date serializes to a bare ISO-8601 string, not a JSON-quoted one", () => {
  const out = serializeSettings({ createdAt: CREATED });
  assert.strictEqual(typeof out.createdAt, "string", "a Date must not survive as an object");
  assert.strictEqual(
    out.createdAt,
    "2026-09-07T17:44:21.470Z",
    `expected a bare ISO string. JSON.stringify would give '"2026-09-07T17:44:21.470Z"' — got ${JSON.stringify(out.createdAt)}`,
  );
  // The defect was exactly one pair of quote characters, so name them.
  assert.ok(!String(out.createdAt).includes('"'), "the value must not carry quote characters — that is what Postgres rejected");
  assert.ok(!Number.isNaN(Date.parse(String(out.createdAt))), "the value must parse back as a date");
});

test("CASE B — real JSON-valued settings still serialize as JSON", () => {
  const out = serializeSettings({
    allowedAutoReplyTopics: ["delivery", "catalogue"],
    productWiseMOQ: { widget: 50 },
    tone: "Warm, concise, businesslike",
  });
  assert.strictEqual(out.allowedAutoReplyTopics, '["delivery","catalogue"]', "list columns are JSON strings");
  assert.strictEqual(out.productWiseMOQ, '{"widget":50}', "object columns are JSON strings");
  assert.strictEqual(out.tone, "Warm, concise, businesslike", "a plain string passes through untouched");
});

test("CASE C — deserializeSettings honours the string type it declares", () => {
  const row = deserializeSettings({
    id: "policy_1",
    workspaceId: "ws_1",
    paymentPolicy: "Credit cards, wire transfers, Net-30.",
    allowedAutoReplyTopics: '["delivery"]',
    createdAt: CREATED,
    updatedAt: new Date("2026-09-08T00:06:46.000Z"),
  })!;
  assert.strictEqual(typeof row.createdAt, "string", "createdAt is declared string — it must BE a string");
  assert.strictEqual(typeof row.updatedAt, "string", "updatedAt is declared string — it must BE a string");
  assert.strictEqual(row.createdAt, "2026-09-07T17:44:21.470Z");
  assert.deepStrictEqual(row.allowedAutoReplyTopics, ["delivery"], "JSON columns are still parsed back into values");
});

test("CASE D — the read-modify-write round trip a settings update actually performs", () => {
  // Exactly what setSettingValue does: read the row, replace one field, write
  // the whole thing back. This is the path that 500'd.
  const existing = deserializeSettings({
    id: "policy_1",
    workspaceId: "ws_1",
    creditPolicy: "Yes, Net-30 terms are offered to approved enterprise clients.",
    paymentPolicy: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  })!;
  const written = serializeSettings({
    ...existing,
    paymentPolicy: "The company accepts credit cards, wire transfers, and Net-30 terms.",
    updatedAt: new Date().toISOString(),
  });
  for (const key of ["createdAt", "updatedAt"]) {
    const value = String(written[key]);
    assert.ok(!value.includes('"'), `${key} must not carry quote characters, got ${JSON.stringify(written[key])}`);
    assert.ok(!Number.isNaN(Date.parse(value)), `${key} must be an ISO-8601 DateTime Postgres accepts, got ${value}`);
  }
  assert.strictEqual(written.creditPolicy, "Yes, Net-30 terms are offered to approved enterprise clients.", "the untouched field survives the round trip");
  assert.strictEqual(written.paymentPolicy, "The company accepts credit cards, wire transfers, and Net-30 terms.", "the changed field is written");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-settings-date-roundtrip — N-BUG (the second write to a settings area must not 500)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`settings-date-roundtrip: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
