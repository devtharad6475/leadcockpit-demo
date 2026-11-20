/**
 * Permanent Do-Not-Contact registry.
 *
 * Session 3 audit fix: the audit found THREE bugs that could resurrect a
 * "do not contact" lead (re-discovery overwriting the flag, unmatched-phone
 * lead creation, and auto-reply to unresolved leads). The DNC flag on the Lead
 * record alone is not enough because leads can be deleted, re-imported, or
 * fail to match by phone.
 *
 * This registry is the authoritative, append-only DNC store keyed by
 * NORMALIZED PHONE (and optionally email). Once a contact is here, they stay
 * here — no re-import, no new lead, no re-discovery can clear it. The only way
 * out is an explicit, audited manual removal (not wired yet; intentionally hard).
 *
 * Rules enforced by this module:
 *  - isDoNotContact(workspaceId, phone) — check before ANY create/send
 *  - registerDoNotContact(...) — add a contact permanently
 *  - normalizePhone — single source of truth for phone normalization
 *
 * WHERE IT IS STORED — CHANGED 2026-08-18 (N-DNC-1, CEO-loop session 6).
 * This module used to call `readData()` / `mutateData()` directly. Those are
 * plain file operations on .leadgen-data/app-data.json (db.ts:209, db.ts:260)
 * and they do not look at PERSISTENCE_PROVIDER, so on Postgres — the substrate
 * this product ships on — the compliance registry was being kept in a local
 * file that the shipped database knows nothing about. Both halves of that were
 * measured before the fix, not argued:
 *
 *   registerDoNotContact() ran and returned an entry; the Postgres table
 *     do_not_contact_entries stayed at 0 rows while the JSON file grew by one.
 *   an opt-out inserted directly into do_not_contact_entries was invisible to
 *     isPermanentlyDoNotContact(), which answered false — the product would
 *     have gone on to message somebody who had said stop.
 *
 * Storage now goes through `repositories.doNotContact`, so the registry lives
 * wherever the rest of the product's data lives. NORMALIZATION STAYS HERE:
 * normalizePhone/normalizeEmail are the single source of truth for what "the
 * same contact" means, and the repositories are handed keys that are already
 * normalized. If normalization moved into the repositories the two substrates
 * could drift on it, and a DNC check that matches on one substrate and misses
 * on the other is worse than one that never worked.
 */
import { timestamp, uid } from "./db";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { DoNotContactEntry } from "./types";
import { websiteKey } from "./same-company";

export type { DoNotContactEntry };

/**
 * Normalize a phone number to comparable digits. Strips everything non-digit
 * except a leading +. This matches how WhatsAppWebhookService.normalizePhone
 * and ProspectingService already compare phones, so a DNC set via any path
 * matches a lead found via any other path.
 */
export function normalizePhone(phone: string | undefined | null): string {
  if (!phone) return "";
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

export function normalizeEmail(email: string | undefined | null): string {
  return (email || "").trim().toLowerCase();
}

/**
 * 2026-09-28 (L10): a website reduced to its host — the same rule the
 * same-company check uses (websiteKey), so "https://www.ShreeZari.in/contact"
 * and "shreezari.in" are one register entry. A shared host (facebook.com,
 * indiamart.com …) keeps its first path part, so one seller on a marketplace
 * never blocks every other seller there.
 */
export function normalizeDomain(website: string | undefined | null): string {
  return websiteKey(website);
}

/**
 * Check whether a phone (or email) is on the permanent DNC registry for a
 * workspace. This is the gate that must run before ANY outbound send or ANY
 * new-lead creation from an inbound message.
 */
/**
 * N-DATA-17 (2026-08-25, audit A-7): every function below now ACCEPTS the
 * repository bundle instead of building its own.
 *
 * They used to call `createRepositories()` internally, which reads
 * PERSISTENCE_PROVIDER and hands back a brand-new bundle every time. That made
 * the do-not-contact check unreachable by any caller that had set something up:
 * `ProspectingService` is handed a bundle, uses it for every lead read and
 * write, and then asked this module whether the contact was blocked — and this
 * module went and looked somewhere else. In production that means the
 * compliance check reads outside whatever transaction or snapshot the caller
 * opened; in tests it means the check silently talked to a different database
 * than the rows it was supposed to be checking.
 *
 * This is the opt-out path. It is the one place in the product where reading
 * stale or unrelated data has a legal consequence, so it is the last place that
 * should be resolving its own storage.
 *
 * The parameter is optional and defaults to the same thing it used to build, so
 * no existing caller changes behaviour. Callers that HAVE a bundle must pass it.
 */
export async function isPermanentlyDoNotContact(
  workspaceId: string,
  options: { phone?: string; email?: string; website?: string },
  repos: RepositoryBundle = createRepositories(),
): Promise<boolean> {
  if (!options.phone && !options.email && !options.website) return false;
  const phone = normalizePhone(options.phone);
  const email = normalizeEmail(options.email);
  const domain = normalizeDomain(options.website);
  if (!phone && !email && !domain) return false;
  const match = await repos.doNotContact.findMatch(workspaceId, {
    normalizedPhone: phone || undefined,
    normalizedEmail: email || undefined,
    normalizedDomain: domain || undefined,
  });
  return Boolean(match);
}

/**
 * Permanently register a contact as do-not-contact. Idempotent — adding the
 * same phone/email twice does not create a duplicate.
 */
export async function registerDoNotContact(
  workspaceId: string,
  options: { phone?: string; email?: string; website?: string; reason: string; sourceLeadId?: string },
  bundle: RepositoryBundle = createRepositories(),
): Promise<DoNotContactEntry | null> {
  const phone = normalizePhone(options.phone);
  const email = normalizeEmail(options.email);
  const domain = normalizeDomain(options.website);
  if (!phone && !email && !domain) return null;
  const keys = { normalizedPhone: phone || undefined, normalizedEmail: email || undefined, normalizedDomain: domain || undefined };
  const repos = bundle;
  // Idempotency: if an entry already matches, keep the earliest one — the
  // reason is preserved from the FIRST opt-out, because that is the one the
  // contact actually gave. Read-then-write is not atomic across substrates, so
  // a duplicate is possible under a race; that is deliberate and harmless here.
  // Both rows say "do not contact", and the check is a match test, not a count.
  // The opposite trade (a unique constraint that throws) would turn a double
  // opt-out into an error on the compliance path, which is the wrong failure.
  const existing = await repos.doNotContact.findMatch(workspaceId, keys);
  if (existing) return existing;
  return repos.doNotContact.create({
    id: uid("dnc"),
    workspaceId,
    normalizedPhone: phone || undefined,
    normalizedEmail: email || undefined,
    normalizedDomain: domain || undefined,
    reason: options.reason,
    sourceLeadId: options.sourceLeadId,
    createdAt: timestamp(),
  });
}

type LeadContactFields = { whatsappNumber?: string; phone?: string; email?: string; websiteUrl?: string };

/** Every way the register can know a lead: each number, the email, the website host. */
function leadRegisterKeys(lead: LeadContactFields): Array<{ phone?: string; email?: string; website?: string }> {
  const keys: Array<{ phone?: string; email?: string; website?: string }> = [];
  const phones = [lead.whatsappNumber, lead.phone].filter((value): value is string => Boolean(normalizePhone(value)));
  for (const phone of phones) keys.push({ phone });
  if (normalizeEmail(lead.email)) keys.push({ email: lead.email });
  if (normalizeDomain(lead.websiteUrl)) keys.push({ website: lead.websiteUrl });
  return keys;
}

/**
 * 2026-09-28 (L10): put a lead on the permanent register — every number, the
 * email and the website host, one entry each (each is checked on its own, so
 * a later lead that shares any one of them is recognised). A company known
 * only by its website can now be registered; before, registration needed a
 * phone or an email and returned nothing. Returns how many entries exist for
 * the lead afterwards (0 means the lead has nothing the register can hold).
 */
export async function registerLeadOnDoNotContact(
  workspaceId: string,
  lead: LeadContactFields & { id: string },
  reason: string,
  repos: RepositoryBundle = createRepositories(),
): Promise<number> {
  let count = 0;
  for (const key of leadRegisterKeys(lead)) {
    const entry = await registerDoNotContact(workspaceId, { ...key, reason, sourceLeadId: lead.id }, repos);
    if (entry) count += 1;
  }
  return count;
}

/**
 * Convenience: combine the lead-record DNC check with the permanent registry
 * check. This is the single function every outbound path should call.
 */
export async function isContactBlocked(
  workspaceId: string,
  lead: ({ doNotContact?: boolean; status?: string } & LeadContactFields) | undefined | null,
  repos: RepositoryBundle = createRepositories(),
): Promise<{ blocked: boolean; reason: string }> {
  if (lead?.doNotContact || lead?.status === "do_not_contact") {
    return { blocked: true, reason: "Lead is marked do not contact." };
  }
  // 2026-09-28: both numbers are checked (it used to be the WhatsApp number OR,
  // only when that was empty, the phone), and the website host too (L10).
  for (const key of lead ? leadRegisterKeys(lead) : []) {
    if (await isPermanentlyDoNotContact(workspaceId, key, repos)) {
      return { blocked: true, reason: "Contact is on the permanent do-not-contact registry." };
    }
  }
  return { blocked: false, reason: "" };
}

/**
 * Cluster 2 / D-2026-07-26-2: the ONE legitimate way out of the permanent
 * DNC registry. Owner-only (enforced by the route's RBAC). Requires a written
 * reason, which the route must persist in the audit log alongside the actor's
 * session userId.
 *
 * Removes every registry entry matching the lead's normalized phone/email in
 * the given workspace. Returns the count removed. Idempotent (0 if not found).
 */
export async function removeFromDncRegistry(
  workspaceId: string,
  lead: LeadContactFields,
  repos: RepositoryBundle = createRepositories(),
): Promise<number> {
  let removed = 0;
  for (const key of leadRegisterKeys(lead || {})) {
    removed += await repos.doNotContact.removeMatching(workspaceId, {
      normalizedPhone: normalizePhone(key.phone) || undefined,
      normalizedEmail: normalizeEmail(key.email) || undefined,
      normalizedDomain: normalizeDomain(key.website) || undefined,
    });
  }
  return removed;
}
