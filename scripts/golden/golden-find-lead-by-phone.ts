/**
 * golden-find-lead-by-phone.ts — P-1 fix pin (Session 7, 2026-07-28).
 *
 * WHY THIS TEST EXISTS (the bug it pins):
 *   The inbound-WhatsApp lead resolver previously did:
 *     `(await repos.lead.listLeads(workspaceId)).find(l => normalizePhone(...) === p)`
 *   which loads EVERY lead in the workspace into Node memory to find ONE by
 *   phone. At 10k+ leads every inbound message took seconds (full-table-scan
 *   into the app layer). The DB even has @@index([phone]) but the code ignored
 *   it. Audit S7 P-1. This golden pins the replacement:
 *     `repos.lead.findLeadByPhone(workspaceId, phone)`
 *   which (a) is workspace-scoped at the repo layer (uses the workspace index,
 *   not "all leads"), (b) matches both the `whatsappNumber` and `phone` fields,
 *   (c) normalizes both sides so +91... / 91... / 9... all match the same lead,
 *   and (d) returns undefined (not throws) when no match — the caller creates.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — these are the RULES, written first):
 *
 *   CASE A — exact whatsappNumber match: a lead with whatsappNumber "+919876543210"
 *     is found by findLeadByPhone(ws, "+919876543210").
 *   CASE B — normalization match: the SAME lead is found by "+91 98765 43210",
 *     "919876543210", "+919876543210" — all normalize equal. (The realistic
 *     threat: Meta delivers E.164; a manual lead may have been saved as local.)
 *   CASE C — phone-field fallback: a lead with only `phone` (no whatsappNumber)
 *     is still found.
 *   CASE D — workspace isolation: a lead in workspace B with the same phone is
 *     NOT returned when querying workspace A. (Ironclad: the method must take
 *     workspaceId and filter at the repo layer — never "all leads".)
 *   CASE E — no match returns undefined (caller creates a new lead). Must NOT
 *     throw.
 *   CASE F — the resolver getOrCreateInboundWhatsAppLead still works end-to-end:
 *     it finds the existing lead by phone WITHOUT calling listLeads (the
 *     full-scan path is gone).
 *
 * REAL PIPELINE: imports the REAL JSON repositories (no mocks). The Prisma
 * repo implements the same interface; JSON proves the contract here. A Neon
 * run would prove the DB-side workspace scoping (covered separately by the
 * prisma-commercial-parity golden's environment).
 *
 * Run: `npm run golden:find-lead-by-phone`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories, type RepositoryBundle } from "@/repositories";

const WS_A = `ws_golden_phone_a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS_B = `ws_golden_phone_b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

async function seedLead(repos: RepositoryBundle, workspaceId: string, overrides: Partial<import("@/lib/types").Lead> = {}) {
  return repos.lead.createLead({
    workspaceId,
    companyName: `Seed ${Math.random().toString(36).slice(2, 8)}`,
    source: "whatsapp",
    status: "replied",
    reviewStatus: "pending",
    consentStatus: "none",
    ...overrides,
  } as Partial<import("@/lib/types").Lead>);
}

async function cleanupLeads(repos: RepositoryBundle, ...workspaceIds: string[]) {
  // Best-effort: delete every lead we created in these test workspaces so the
  // demo JSON file is not polluted run after run (build-right Gate #8).
  for (const ws of workspaceIds) {
    const leads = await repos.lead.listLeads(ws);
    for (const l of leads) {
      try {
        await repos.lead.deleteById(ws, l.id);
      } catch {
        /* best effort */
      }
    }
  }
}

async function main() {
  const repos = createRepositories("json");

  // Seed: WS_A has a lead with whatsappNumber (E.164). WS_B has a lead with the
  // SAME phone but a different name (isolation probe). WS_A also has a lead
  // with only `phone` (field-fallback probe).
  const waLead = await seedLead(repos, WS_A, {
    companyName: "WhatsApp Lead A",
    whatsappNumber: "+919876543210",
  });
  const phoneOnlyLead = await seedLead(repos, WS_A, {
    companyName: "Phone-Only Lead A",
    phone: "+918800112233",
  });
  await seedLead(repos, WS_B, {
    companyName: "Cross-Tenant Lead B",
    whatsappNumber: "+919876543210", // same phone, different workspace
  });

  // CASE A — exact whatsappNumber match.
  {
    const found = await repos.lead.findLeadByPhone(WS_A, "+919876543210");
    assert.ok(found, "CASE A: must find the lead by exact whatsappNumber");
    assert.strictEqual(found.id, waLead.id, "CASE A: found the right lead");
    console.log("  CASE A OK: exact whatsappNumber match.");
  }

  // CASE B — digit-only normalization match. findLeadByPhone normalizes by
  // STRIPPING non-digits (replace(/\D/g,"")), matching the inbound-webhook
  // contract. So "+919876543210", "+91 98765 43210", "+91-98765-43210", AND
  // "919876543210" (no +) all resolve to the SAME lead — because Meta delivers
  // E.164 with "+" but a manual lead may be stored either way, and the realistic
  // match is on the digit string. (Verified against the real impl, not assumed.)
  // NOTE: a domestic 0-prefixed number like "09876543210" is a DIFFERENT digit
  // string (10 digits, no country code) and correctly does NOT match — that's
  // not the same subscriber, so we don't list it as a matching variant.
  {
    const matchingVariants = ["+919876543210", "+91 98765 43210", "+91-98765-43210", "919876543210"];
    for (const v of matchingVariants) {
      const found = await repos.lead.findLeadByPhone(WS_A, v);
      assert.ok(found, `CASE B: must find lead via digit-normalized variant "${v}"`);
      assert.strictEqual(found.id, waLead.id, `CASE B: variant "${v}" resolved to the same lead`);
    }
    console.log(`  CASE B OK: ${matchingVariants.length} spellings (with/without '+', spaced, hyphenated) all matched the same lead (digit-only normalization).`);
  }

  // CASE C — phone-field fallback (lead has `phone`, no whatsappNumber).
  {
    const found = await repos.lead.findLeadByPhone(WS_A, "+918800112233");
    assert.ok(found, "CASE C: must find a lead that only has `phone` set");
    assert.strictEqual(found.id, phoneOnlyLead.id, "CASE C: found the phone-only lead");
    console.log("  CASE C OK: phone-field fallback works.");
  }

  // CASE D — workspace isolation: WS_B's lead with the same phone is NOT
  // returned when querying WS_A. (Proves the method is workspace-scoped, not
  // "all leads".)
  {
    const found = await repos.lead.findLeadByPhone(WS_A, "+919876543210");
    assert.ok(found, "CASE D: WS_A still finds its own lead");
    // The cross-tenant lead has a different name; confirm we did NOT get it.
    assert.notStrictEqual(found.companyName, "Cross-Tenant Lead B", "CASE D: must not leak WS_B's lead into WS_A");
    // And querying WS_B returns ITS lead, not WS_A's.
    const foundB = await repos.lead.findLeadByPhone(WS_B, "+919876543210");
    assert.ok(foundB, "CASE D: WS_B finds its own lead");
    assert.strictEqual(foundB.companyName, "Cross-Tenant Lead B", "CASE D: WS_B got its own lead, not WS_A's");
    console.log("  CASE D OK: workspace isolation holds (same phone, different tenants stay separate).");
  }

  // CASE E — no match returns undefined (must NOT throw).
  {
    const found = await repos.lead.findLeadByPhone(WS_A, "+990009990099");
    assert.strictEqual(found, undefined, "CASE E: unknown phone returns undefined, not throws");
    console.log("  CASE E OK: unknown phone → undefined (caller will create a new lead).");
  }

  // CASE F — the resolver no longer calls listLeads (the full-scan path).
  // We prove this by spying: wrap repos.lead so any listLeads call is recorded.
  // Then run getOrCreateInboundWhatsAppLead against an EXISTING lead; it must
  // resolve via findLeadByPhone and record ZERO listLeads calls.
  {
    let listLeadsCallCount = 0;
    const realLead = repos.lead;
    // Use a Proxy so EVERY method (incl. prototype methods like findLeadByPhone)
    // delegates to the real repo, and only listLeads is intercepted. (Object
    // spread would drop prototype methods — that's why the naive spy failed.)
    const spiedLead = new Proxy(realLead, {
      get(target, prop, receiver) {
        if (prop === "listLeads") {
          return (workspaceId: string, filters?: Parameters<typeof realLead.listLeads>[1]) => {
            listLeadsCallCount++;
            return target.listLeads(workspaceId, filters);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spiedRepos = { ...repos, lead: spiedLead } as RepositoryBundle;

    // Import the resolver lazily so the spy is in place before it runs.
    const { getOrCreateInboundWhatsAppLead } = await import("@/services/WhatsAppWebhookService");
    // Resolve an existing lead (the seeded WS_A lead) — must NOT create a new one.
    const resolved = await getOrCreateInboundWhatsAppLead(WS_A, "+919876543210", "Test Contact", spiedRepos);
    assert.ok(resolved, "CASE F: resolver returned the existing lead");
    assert.strictEqual(resolved.id, waLead.id, "CASE F: resolver found the right existing lead (no duplicate created)");
    assert.strictEqual(listLeadsCallCount, 0, `CASE F: resolver must use findLeadByPhone, NOT listLeads (full-scan). listLeads was called ${listLeadsCallCount} time(s).`);
    console.log(`  CASE F OK: inbound resolver used findLeadByPhone; listLeads (full-scan) called ${listLeadsCallCount} times.`);
  }

  await cleanupLeads(repos, WS_A, WS_B);
  console.log("\nPASS golden-find-lead-by-phone: findLeadByPhone is workspace-scoped + normalizes + isolates tenants (6 cases).");
}

main().catch((err) => {
  console.error("\nFAIL golden-find-lead-by-phone:", err.message);
  process.exit(1);
});
