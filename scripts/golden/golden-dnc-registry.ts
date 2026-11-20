/**
 * golden-dnc-registry.ts — behaviour pin for the permanent Do-Not-Contact
 * registry (2026-08-18, CEO-loop session 6, finding N-DNC-1).
 *
 * WHAT THE REGISTRY IS. `src/lib/dnc-registry.ts` is the store that decides
 * whether this product is allowed to message somebody who said stop. It is
 * called by the WhatsApp webhook, the conversation engine, prospecting and the
 * auto-reply review path. It is deliberately SEPARATE from the per-lead
 * `doNotContact` boolean so that deleting or re-importing a lead can never
 * clear an opt-out. If it answers wrong in the permissive direction, the
 * product messages somebody who asked it not to.
 *
 * WHY THIS FILE EXISTS. Until session 6 the registry read and wrote
 * `.leadgen-data/app-data.json` directly, via `readData()` / `mutateData()`,
 * on BOTH substrates — those two functions are plain file operations with no
 * `PERSISTENCE_PROVIDER` awareness (src/lib/db.ts:209 and :260). The fix routes
 * it through a real `DoNotContactRepository` implemented on both substrates.
 * That fix is proven on the SUBSTRATE by its sibling,
 * golden-dnc-registry-substrate-prisma.ts. THIS golden proves the far duller
 * and equally necessary half: that moving the store did not change the
 * BEHAVIOUR the compliance path depends on.
 *
 * It carries no marker, so the suite runs it as a logic golden — pinned to
 * JSON, in an isolated data directory. But nothing in it is JSON-specific: it
 * only calls the module's public API and creates its own workspace first, so it
 * is equally valid run against Postgres, and running it both ways is a cheap
 * parity check.
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — a phone registered as `+91 00000 00071` is matched when the same
 *            number is presented as `+910000000071`, `+91-00000-00071` and
 *            `+91 00000 00071 `. Normalisation is the whole reason the registry
 *            can be trusted: an opt-out arriving from WhatsApp and a send
 *            attempt originating from an imported lead never spell the number
 *            the same way.
 *   CASE B — registering the SAME contact twice returns the FIRST entry: same
 *            id, and the FIRST reason. The reason is the one the contact
 *            actually gave; a later automated re-registration must not overwrite
 *            it. Also proves the call is idempotent rather than duplicating.
 *   CASE C — a registration made by EMAIL only is found by that email, and is
 *            NOT found by an unrelated phone. Both keys are nullable and the
 *            match is an OR, so this is where a wrong query quietly matches
 *            everything or nothing.
 *   CASE D — a registration with neither phone nor email returns null and
 *            stores nothing; a lookup with empty strings answers false. Empty
 *            string is the shape this gets called with in practice (a lead with
 *            no email yields `""`, not `undefined`), and `normalizedEmail = ""`
 *            would match every row that has no email — every phone-only opt-out
 *            in the workspace.
 *   CASE E — an opt-out in one workspace is invisible in another. Tenant leak
 *            in this direction is a wrong BLOCK (annoying); in the other it is
 *            a wrong SEND (a compliance breach). Both are pinned.
 *   CASE F — removeFromDncRegistry returns the number of rows it removed, the
 *            guard flips back to false, and a second removal returns 0. This is
 *            the one legitimate way out of the registry (D-2026-07-26-2,
 *            owner-only), so "it said it removed something" has to be true.
 *   CASE G — isContactBlocked — the function every outbound path is supposed to
 *            call — reports the REGISTRY reason for a registered contact, not
 *            just `blocked: true`. The reason is what the operator sees when
 *            they ask why a send did not happen.
 *
 * SAFETY: every number is N-SAFETY-1 unroutable by construction
 * (`+91 00000 000NN` — an Indian mobile subscriber part never begins 0) and
 * every address is in the RFC 2606 reserved `example.com`.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-dnc-registry.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import {
  isPermanentlyDoNotContact,
  registerDoNotContact,
  removeFromDncRegistry,
  isContactBlocked,
} from "@/lib/dnc-registry";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_dnc_${RUN}`;
const WS_OTHER = `ws_golden_dnc_other_${RUN}`;

// N-SAFETY-1 unroutable by construction.
const PHONE = "+91 00000 00071";
const PHONE_OTHER = "+91 00000 00072";
const EMAIL = `dnc-golden-${RUN}@example.com`;

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

async function seed() {
  // Created on whatever substrate is bound. On Postgres the registry table has
  // an FK to workspaces, so this is not optional there; on JSON it is a
  // harmless extra row in the isolated run directory.
  const repos = createRepositories();
  for (const id of [WS, WS_OTHER]) {
    await repos.workspace.create({
      id, name: `DNC golden ${id}`, status: "active",
      autonomyKillSwitch: false, autoSendToggle: false,
    });
  }
}

// ─── CASE A ─────────────────────────────────────────────────────────────────
test("CASE A — a registered phone matches every spelling of the same number", async () => {
  const entry = await registerDoNotContact(WS, { phone: PHONE, reason: "said stop on whatsapp" });
  assert.ok(entry, "registerDoNotContact must return the stored entry");
  assert.strictEqual(entry!.normalizedPhone, "+910000000071", "phone must be stored normalised");

  for (const spelling of ["+91 00000 00071", "+910000000071", "+91-00000-00071", " +91 00000 00071 "]) {
    const blocked = await isPermanentlyDoNotContact(WS, { phone: spelling });
    assert.strictEqual(blocked, true, `spelling ${JSON.stringify(spelling)} must be recognised as the same contact`);
  }

  const unrelated = await isPermanentlyDoNotContact(WS, { phone: PHONE_OTHER });
  assert.strictEqual(unrelated, false, "a different number must not be blocked");
});

// ─── CASE B ─────────────────────────────────────────────────────────────────
test("CASE B — registering twice keeps the first entry and the first reason", async () => {
  const first = await isPermanentlyDoNotContact(WS, { phone: PHONE });
  assert.strictEqual(first, true, "precondition: CASE A registered this number");

  const again = await registerDoNotContact(WS, { phone: PHONE, reason: "bulk import marked opted out" });
  assert.ok(again, "a repeat registration must still return the entry, not null");
  assert.strictEqual(again!.reason, "said stop on whatsapp",
    "the reason must stay the one the contact actually gave, not the later automated one");

  const all = await createRepositories().doNotContact.listByWorkspace(WS);
  const forPhone = all.filter((e) => e.normalizedPhone === "+910000000071");
  assert.strictEqual(forPhone.length, 1, `a repeat registration must not duplicate the row (found ${forPhone.length})`);
});

// ─── CASE C ─────────────────────────────────────────────────────────────────
test("CASE C — an email-only opt-out matches by email and not by phone", async () => {
  const entry = await registerDoNotContact(WS, { email: EMAIL.toUpperCase(), reason: "unsubscribed by email" });
  assert.ok(entry);
  assert.strictEqual(entry!.normalizedEmail, EMAIL.toLowerCase(), "email must be stored lowercased");
  assert.strictEqual(entry!.normalizedPhone, undefined, "an email-only opt-out must not invent a phone key");

  assert.strictEqual(await isPermanentlyDoNotContact(WS, { email: EMAIL }), true,
    "the email that opted out must be blocked");
  assert.strictEqual(await isPermanentlyDoNotContact(WS, { email: `someone-else-${RUN}@example.com` }), false,
    "an unrelated address must not be blocked");
  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: PHONE_OTHER }), false,
    "an email-only opt-out must not block an unrelated phone");
});

// ─── CASE D ─────────────────────────────────────────────────────────────────
test("CASE D — empty keys store nothing and match nothing", async () => {
  const before = (await createRepositories().doNotContact.listByWorkspace(WS)).length;

  assert.strictEqual(await registerDoNotContact(WS, { reason: "no keys at all" }), null,
    "a registration with no phone and no email must return null");
  assert.strictEqual(await registerDoNotContact(WS, { phone: "", email: "", reason: "blank keys" }), null,
    "blank strings are not keys");
  assert.strictEqual(await registerDoNotContact(WS, { phone: "()-  ", reason: "punctuation only" }), null,
    "a phone with no digits is not a key");

  const after = (await createRepositories().doNotContact.listByWorkspace(WS)).length;
  assert.strictEqual(after, before, `nothing may be stored for an empty key (was ${before}, now ${after})`);

  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: "", email: "" }), false,
    "an empty lookup must answer false, not match the phone-only rows");
  assert.strictEqual(await isPermanentlyDoNotContact(WS, {}), false,
    "a lookup with no keys must answer false");
});

// ─── CASE E ─────────────────────────────────────────────────────────────────
test("CASE E — an opt-out does not cross workspaces", async () => {
  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: PHONE }), true,
    "precondition: the number is registered in WS");
  assert.strictEqual(await isPermanentlyDoNotContact(WS_OTHER, { phone: PHONE }), false,
    "another tenant's opt-out must not block a send here");
  assert.strictEqual(await isPermanentlyDoNotContact(WS_OTHER, { email: EMAIL }), false,
    "…and the same for the email key");

  await registerDoNotContact(WS_OTHER, { phone: PHONE_OTHER, reason: "other tenant opt-out" });
  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: PHONE_OTHER }), false,
    "an opt-out registered in the other workspace must not leak back into this one");
});

// ─── CASE F ─────────────────────────────────────────────────────────────────
test("CASE F — removal reports a true count and is idempotent", async () => {
  const removed = await removeFromDncRegistry(WS, { phone: PHONE });
  assert.strictEqual(removed, 1, `removal must report exactly what it removed (got ${removed})`);
  assert.strictEqual(await isPermanentlyDoNotContact(WS, { phone: PHONE }), false,
    "after an approved removal the contact is no longer blocked");

  const again = await removeFromDncRegistry(WS, { phone: PHONE });
  assert.strictEqual(again, 0, "removing something already gone must report 0, not 1");

  assert.strictEqual(await isPermanentlyDoNotContact(WS, { email: EMAIL }), true,
    "removing the phone opt-out must not take the unrelated email opt-out with it");
  assert.strictEqual(await removeFromDncRegistry(WS, { whatsappNumber: "", phone: "", email: "" }), 0,
    "a removal with no keys must remove nothing rather than everything");
});

// ─── CASE G ─────────────────────────────────────────────────────────────────
test("CASE G — isContactBlocked reports the registry as the reason", async () => {
  const blocked = await isContactBlocked(WS, { email: EMAIL, whatsappNumber: PHONE_OTHER });
  assert.strictEqual(blocked.blocked, true, "a lead whose email is on the registry must be blocked");
  assert.match(blocked.reason, /permanent do-not-contact registry/i,
    `the operator must be told WHICH rule stopped the send (got ${JSON.stringify(blocked.reason)})`);

  const clear = await isContactBlocked(WS, { email: `clear-${RUN}@example.com`, whatsappNumber: PHONE });
  assert.strictEqual(clear.blocked, false, "a contact on no list must not be blocked");
  assert.strictEqual(clear.reason, "", "an unblocked contact carries no reason");

  const flagged = await isContactBlocked(WS, { doNotContact: true, email: `clear-${RUN}@example.com` });
  assert.strictEqual(flagged.blocked, true, "the per-lead flag still blocks on its own");
  assert.match(flagged.reason, /marked do not contact/i, "…and says so, distinctly from the registry reason");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  console.log("GOLDEN dnc-registry — permanent Do-Not-Contact behaviour (N-DNC-1)\n");
  let passed = 0;
  let failed = 0;
  try {
    await seed();
    // Cases share state deliberately and run in order: A registers, B proves
    // the repeat is a no-op, F removes. Running them independently would need
    // seven registrations to prove one lifecycle.
    for (const c of cases) {
      try {
        await c.fn();
        passed++;
        console.log(`  PASS  ${c.name}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${(e as Error).message}`);
      }
    }
  } finally {
    // On JSON under the suite runner the data directory is a throwaway temp
    // dir, so this is belt-and-braces; it matters when this golden is pointed
    // at Postgres by hand, where the rows are real.
    try {
      const repos = createRepositories();
      for (const ws of [WS, WS_OTHER]) {
        for (const keys of [{ phone: PHONE }, { phone: PHONE_OTHER }, { email: EMAIL }]) {
          await removeFromDncRegistry(ws, keys);
        }
        await repos.workspace.delete(ws);
      }
    } catch { /* best-effort */ }
  }

  console.log("");
  console.log(`=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("golden-dnc-registry FAILED — the compliance registry does not behave as pinned.");
    process.exit(1);
  }
  console.log("golden-dnc-registry ALL GREEN");
  process.exit(0);
})();
