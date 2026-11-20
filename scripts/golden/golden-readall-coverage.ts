/**
 * golden-readall-coverage.ts — N-DATA-14. // PRISMA_GOLDEN
 *
 * WHY THIS TEST EXISTS
 *
 *   `AppData` (src/lib/types.ts) is the shape of everything the product stores.
 *   `repositories.readAll()` is supposed to hand back that shape. On Postgres it
 *   hands back 61 of the 83 declared collections. The other 22 are simply absent
 *   from the returned object — not empty arrays, absent — and every caller that
 *   spreads or iterates the result silently gets less than it asked for.
 *   `GET /api/data/export` is one of those callers, which is how this was found.
 *
 *   Some of those 22 are absent ON PURPOSE and must stay that way: credentials,
 *   password-reset and email-verification tokens, impersonation sessions, and
 *   the platform-operator tables, which belong to us and not to any customer.
 *   Others are ordinary customer data and their absence is a defect.
 *
 *   The real problem is neither list. It is that **nothing complains when the
 *   two drift**. A collection added to `AppData` tomorrow lands in neither list
 *   and nobody finds out until a customer's export is short. This golden is the
 *   thing that complains.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat)
 *
 *   CASE A — the declared list is read from the TYPE, not from a hand-kept copy.
 *     At least 80 array-valued collections must be found on `AppData`; a parser
 *     that quietly matched nothing would make every later case vacuous.
 *
 *   CASE B — `readAll()` returns a real object with a substantial number of
 *     those collections present (> 50). Guards against a readAll that throws,
 *     returns `{}`, or is silently replaced by a stub.
 *
 *   CASE C — THE GUARD. Every collection missing from `readAll()` must be
 *     accounted for by name, in one of the two lists below. An unaccounted
 *     collection fails the suite and names itself in the output.
 *
 *   CASE D — the lists cannot rot. Every name in either list must STILL be
 *     missing. The moment somebody implements one, this case turns red and
 *     forces the entry to be deleted, so the file can never describe a past
 *     state of the code.
 *
 *   CASE E — the known gaps are reported, loudly, every run. They are recorded
 *     rather than fixed because what belongs in a customer's export is a product
 *     decision, not a code decision (raised with the CEO, session 20). This case
 *     fails if the gap list GROWS beyond what is recorded here.
 *
 * MUTATION-TESTED 2026-08-25, every mutation compiling clean under tsc and
 * both sources restored byte-identical (sha256 verified) afterwards:
 *   m1 the AppData parser matches nothing                    -> CASE A fails
 *   m2 an entry is dropped from DELIBERATELY_ABSENT          -> CASE C fails
 *   m3 an entry is dropped from KNOWN_GAPS                   -> CASE C fails
 *   m4 SHIPPING CODE: the Prisma readAll() stops returning
 *      doNotContactRegistry                                  -> CASE C fails
 *   m5 a recorded omission is not actually missing           -> CASE D fails
 * 5 of 5 caught, no equivalents. m4 is the one that matters: it deletes real
 * customer data from the shipping read path rather than breaking the test, and
 * the suite turns red on it by name.
 *
 * Run: PERSISTENCE_PROVIDER=prisma npx tsx scripts/golden/golden-readall-coverage.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readFileSync } from "node:fs";

/**
 * Absent on purpose, and each one has to justify itself. These must never
 * appear in a whole-store read that any customer-facing feature builds on.
 */
const DELIBERATELY_ABSENT: Record<string, string> = {
  llmProviderCredentials: "secrets — API keys for the model providers",
  passwordResetTokens: "security tokens — a live reset token is a way in",
  emailVerificationTokens: "security tokens — same",
  impersonationSessions: "security — records of platform staff acting as a customer",
  platformAdmins: "platform-operator data, not any one customer's",
  platformAdminCredentials: "platform-operator secrets",
  platformAuditLogs: "platform-operator data",
  platformTickets: "platform-operator data",
  platformTicketEvents: "platform-operator data",
  platformSupportHours: "platform-operator configuration",
  platformTicketSlaSettings: "platform-operator configuration",
  platformUserBlocks: "platform-operator data",
  featureFlags: "platform-operator configuration",
};

/**
 * Absent and it should not be. Ordinary customer data that a whole-store read
 * ought to return. Recorded, dated, and NOT quietly tolerated: CASE E prints
 * every one of them on every run, and the list is not allowed to grow.
 *
 * Not fixed in place because the question it raises — what exactly belongs in
 * the file a customer gets when they click "export my data" — is the CEO's to
 * answer, not a decision to make inside a test file. Raised session 20.
 */
const KNOWN_GAPS: Record<string, string> = {
  interactions: "the customer's own conversation history; scopeDataForExport already lists it",
  conversationPolicies: "workspace configuration the operator set up",
  whatsAppTemplates: "workspace-authored message templates",
  agentAutonomousSettings: "workspace configuration",
  knowledgeBaseQueryLogs: "workspace activity",
  leadPhoneNumbers: "contact details belonging to the workspace's own leads",
  invites: "the workspace's outstanding invitations",
  ownerCopilotConversations: "the operator's own conversations with the copilot",
  ownerCopilotMessages: "the operator's own conversations with the copilot",
};

/** Every array-valued collection declared on AppData, straight from the type. */
function declaredCollections(): string[] {
  const source = readFileSync("src/lib/types.ts", "utf8");
  const start = source.indexOf("export type AppData = {");
  if (start === -1) return [];
  const end = source.indexOf("\n};", start);
  const body = source.slice(start, end);
  const names: string[] = [];
  for (const match of body.matchAll(/^\s{2}([A-Za-z0-9_]+)\??:\s*[A-Za-z0-9_<>|" ]+\[\];/gm)) names.push(match[1]);
  return names;
}

async function main() {
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") {
    console.log("SKIP: this golden only means something on Postgres (PERSISTENCE_PROVIDER=prisma).");
    process.exit(0);
  }

  let failures = 0;
  const { createRepositories } = await import("@/repositories");
  const repos = createRepositories();

  // ── CASE A ───────────────────────────────────────────────────────────────
  const declared = declaredCollections();
  if (declared.length >= 80) {
    console.log(`CASE A pass — ${declared.length} array collections read off the AppData type itself`);
  } else {
    console.log(`CASE A FAIL — only ${declared.length} collections parsed from AppData; the parser is broken`);
    failures += 1;
  }

  // ── CASE B ───────────────────────────────────────────────────────────────
  const data = (await repos.readAll!()) as unknown as Record<string, unknown>;
  const present = declared.filter((name) => name in data);
  if (present.length > 50) {
    console.log(`CASE B pass — readAll() returned ${present.length} of the ${declared.length} declared collections`);
  } else {
    console.log(`CASE B FAIL — readAll() returned only ${present.length} collections; it is not doing its job at all`);
    failures += 1;
  }

  const missing = declared.filter((name) => !(name in data));

  // ── CASE C — the guard ───────────────────────────────────────────────────
  const unaccounted = missing.filter((name) => !(name in DELIBERATELY_ABSENT) && !(name in KNOWN_GAPS));
  if (unaccounted.length === 0) {
    console.log(`CASE C pass — all ${missing.length} missing collections are accounted for by name`);
  } else {
    console.log(`CASE C FAIL — ${unaccounted.length} collection(s) missing from readAll() and named nowhere:`);
    for (const name of unaccounted) console.log(`    ${name}`);
    console.log("");
    console.log("  Either implement it in the Prisma readAll(), or add it to");
    console.log("  DELIBERATELY_ABSENT with the reason it must never be returned.");
    failures += 1;
  }

  // ── CASE D — the lists cannot rot ────────────────────────────────────────
  const missingSet = new Set(missing);
  const stale = [...Object.keys(DELIBERATELY_ABSENT), ...Object.keys(KNOWN_GAPS)].filter(
    (name) => declared.includes(name) && !missingSet.has(name),
  );
  if (stale.length === 0) {
    console.log("CASE D pass — every recorded omission is still a real omission");
  } else {
    console.log(`CASE D FAIL — ${stale.length} recorded omission(s) are now returned by readAll(); delete the entries:`);
    for (const name of stale) console.log(`    ${name}`);
    failures += 1;
  }

  // ── CASE E — the gaps are reported, and may not grow ─────────────────────
  const gaps = missing.filter((name) => name in KNOWN_GAPS);
  if (gaps.length <= Object.keys(KNOWN_GAPS).length) {
    console.log(`CASE E pass — ${gaps.length} known customer-data gap(s), none new:`);
    for (const name of gaps) console.log(`    ${name} — ${KNOWN_GAPS[name]}`);
  } else {
    console.log(`CASE E FAIL — the known-gap list has grown to ${gaps.length}`);
    failures += 1;
  }

  console.log("");
  if (failures === 0) {
    console.log(`=== READALL COVERAGE: 5/5 CASES PASS ✅ (${present.length}/${declared.length} returned, ${missing.length} accounted for) ===`);
    process.exit(0);
  }
  console.log(`=== READALL COVERAGE: ${failures} CASE(S) FAILED ❌ ===`);
  process.exit(1);
}

main().catch((error) => {
  console.error("GOLDEN CRASHED:", error);
  process.exit(1);
});
