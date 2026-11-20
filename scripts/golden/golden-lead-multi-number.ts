/**
 * golden-lead-multi-number.ts — WP6-C (6C-1 storage + 6C-2 dedup-across-numbers) pin.
 *
 * WHY THIS TEST EXISTS:
 *   A real business often has SEVERAL numbers (landline, mobile, WhatsApp, a
 *   second branch). Previously the Lead stored only ONE phone + ONE whatsapp
 *   number. So if a customer messaged from their 2nd WhatsApp number, the
 *   inbound lookup did NOT recognize them → a DUPLICATE lead was created.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — 6C-1 add: addLeadPhoneNumber stores a number with its digit-only
 *     normalized form, marked primary or not. listLeadPhoneNumbers returns it.
 *   CASE B — 6C-1 idempotent: re-adding the SAME normalized number does NOT
 *     create a duplicate row (count unchanged).
 *   CASE C — 6C-1 primary sync: when isPrimary=true, the lead's flat
 *     phone/whatsappNumber field is updated to match (backward-compatible read).
 *   CASE D — 6C-2 lookup across numbers: findLeadByPhone matches a lead by ANY
 *     of its stored numbers (not just the primary flat field). A text from the
 *     lead's 2nd number resolves to the SAME lead — no duplicate created.
 *   CASE E — 6C-2 normalization: "+91 99999 00000" and "919999900000" match.
 *
 * ISOLATION (build-right Gate #8): unique RUN-tagged workspace + lead; cleans up.
 * Runs in JSON mode (logic test — the contract is provider-independent).
 *
 * Run: `npm run golden:lead-multi-number`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories, type RepositoryBundle } from "@/repositories";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_multinum_${RUN}`;

async function seedLead(repos: RepositoryBundle) {
  const lead = await repos.lead.createLead({
    workspaceId: WS,
    companyName: `Multi-Num Co ${RUN}`,
    status: "approved",
    reviewStatus: "approved",
    // Primary flat fields (the old single-number model).
    phone: "+919999900000",
    whatsappNumber: "+919999900000",
  });
  return lead;
}

async function cleanup(repos: RepositoryBundle, leadId: string) {
  try {
    await repos.lead.deleteById?.(WS, leadId);
  } catch { /* best effort */ }
  try {
    await repos.mutateAll?.((data) => {
      data.leads = (data.leads || []).filter((l) => l.workspaceId !== WS);
      data.leadPhoneNumbers = (data.leadPhoneNumbers || []).filter((n) => n.workspaceId !== WS);
      data.workspaces = (data.workspaces || []).filter((w) => w.id !== WS);
    });
  } catch { /* best effort */ }
}

async function main() {
  // Force JSON: this is a LOGIC test (the contract is identical across providers).
  // The flip to prisma .env would otherwise point createRepositories() at Postgres.
  const repos = createRepositories("json");
  // Seed a workspace for the lead.
  await repos.workspace.create({ id: WS, name: `Golden Multi-Num ${RUN}`, status: "active" });
  const lead = await seedLead(repos);

  let failures = 0;
  const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { console.log(`  ❌ ${name}\n     ${(e as Error).message}`); failures++; }
  };

  try {
    console.log("golden-lead-multi-number — WP6-C (6C-1 storage + 6C-2 dedup-across-numbers)\n");

    // CASE A — add a 2nd number (a mobile, not primary).
    const added = await repos.lead.addLeadPhoneNumber(WS, lead.id, {
      number: "+91 98765 43210",
      type: "mobile",
      isPrimary: false,
      label: "owner mobile",
    });
    const list = await repos.lead.listLeadPhoneNumbers(WS, lead.id);
    check("CASE A — addLeadPhoneNumber stores the number + list returns it", () => {
      assert.ok(list.length >= 1, "expected ≥1 number");
      assert.ok(list.some((n) => n.normalizedDigits === "919876543210"), "normalized digits stored");
      assert.strictEqual(added.normalizedDigits, "919876543210", "added record has normalized digits");
    });

    // CASE B — idempotent: re-add the SAME number, count unchanged.
    const before = (await repos.lead.listLeadPhoneNumbers(WS, lead.id)).length;
    await repos.lead.addLeadPhoneNumber(WS, lead.id, { number: "919876543210", type: "mobile" });
    const after = (await repos.lead.listLeadPhoneNumbers(WS, lead.id)).length;
    check("CASE B — re-adding the SAME normalized number does NOT duplicate (idempotent)", () => {
      assert.strictEqual(after, before, `expected ${before} rows, got ${after}`);
    });

    // CASE C — primary sync: add a primary whatsapp number, lead.whatsappNumber updates.
    await repos.lead.addLeadPhoneNumber(WS, lead.id, {
      number: "+919111122222",
      type: "whatsapp",
      isPrimary: true,
    });
    const refreshed = await repos.lead.getLeadById(WS, lead.id);
    check("CASE C — isPrimary=true syncs the lead's flat whatsappNumber field", () => {
      assert.ok(refreshed, "lead exists");
      assert.strictEqual((refreshed!.whatsappNumber || "").replace(/\D/g, ""), "919111122222", "flat field synced to primary");
    });

    // CASE D — 6C-2 the load-bearing assertion: findLeadByPhone matches by the
    // 2nd (non-primary) number → resolves to the SAME lead, no duplicate.
    const foundBySecondNumber = await repos.lead.findLeadByPhone(WS, "+919876543210");
    check("CASE D — findLeadByPhone matches a lead by its 2nd (non-primary) number", () => {
      assert.ok(foundBySecondNumber, "expected to find the lead by its 2nd number");
      assert.strictEqual(foundBySecondNumber!.id, lead.id, "resolved to the SAME lead (no duplicate)");
    });

    // CASE E — normalization: formatted vs digit-only match the same lead.
    const foundFormatted = await repos.lead.findLeadByPhone(WS, "919876543210");
    const foundPretty = await repos.lead.findLeadByPhone(WS, "+91 98765 43210");
    check("CASE E — normalization (formatted vs digit-only resolve to the same lead)", () => {
      assert.ok(foundFormatted && foundPretty, "both lookups found a lead");
      assert.strictEqual(foundFormatted!.id, foundPretty!.id, "same lead regardless of format");
    });

    if (failures === 0) {
      console.log("\n✅ golden-lead-multi-number ALL GREEN ✅");
      console.log("  6C-1: all numbers stored (idempotent + primary-sync).");
      console.log("  6C-2: inbound lookup matches ANY number → no duplicate lead.");
    } else {
      console.log(`\n❌ ${failures} case(s) FAILED`);
      process.exit(1);
    }
  } finally {
    await cleanup(repos, lead.id);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
