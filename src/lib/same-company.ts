/**
 * same-company.ts — the ONE answer to "is this the same company we already
 * have?" (2026-09-27, break test L2/L4/L6).
 *
 * Before this, three places answered it three ways:
 *   - discovery matched on the website, or on the company name ALONE, so a
 *     different "Balaji Textiles" in another city with its own website was
 *     merged into the existing lead and its email filled in over it;
 *   - CSV import matched on the website, or else the name, but compared the
 *     website as raw text ("shreezari.in?utm=x" was a new company) and never
 *     looked at the phone or email;
 *   - manual add matched on phone, email and website but never the name.
 * And every name comparison stripped everything outside a-z and 0-9, so a
 * company written in Hindi or Gujarati had an EMPTY name key and never matched
 * anything — the same "बालाजी ज़री" could be added any number of times.
 *
 * THE RULE (docs/LOGIC.md 2026-09-27 SAME-COMPANY):
 *   1. Both have a website → same website (host only, no "www.", no path or
 *      query) is the same company.
 *   2. Any phone / WhatsApp number in common (last 10 digits) → same company.
 *   3. Same email (trimmed, lowercase) → same company.
 *   4. Same name (Unicode NFC, lowercase, letters/marks/digits of ANY script,
 *      spaces and punctuation ignored) → same company, UNLESS something says
 *      otherwise:
 *        - both have websites and they differ → only if the city also matches;
 *        - both have a city and the cities differ → not the same.
 */
import { samePhone } from "@/lib/phone-match";

export type CompanyIdentity = {
  companyName?: string | null;
  websiteUrl?: string | null;
  phone?: string | null;
  whatsappNumber?: string | null;
  email?: string | null;
  city?: string | null;
};

/** Pages on these sites belong to many businesses; the first path part says which one. */
const SHARED_HOSTS = new Set(["facebook.com", "instagram.com", "linkedin.com", "google.com", "maps.google.com", "wa.me", "linktr.ee", "business.site", "indiamart.com", "justdial.com"]);

/**
 * 2026-09-26 (break test): "shreezari.in", "https://www.ShreeZari.in/" and
 * "www.shreezari.in/contact" are one company, but a website with no "http"
 * failed URL parsing and was compared as raw text, so one company became
 * several leads. Every form reduces to its host without "www.".
 */
export function websiteKey(value: string | undefined | null): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
    const host = url.hostname.replace(/^www\./, "");
    if (!host.includes(".")) return "";
    const first = url.pathname.split("/").filter(Boolean)[0];
    return SHARED_HOSTS.has(host) && first ? `${host}/${first}` : host;
  } catch {
    return "";
  }
}

/**
 * A name reduced to what identifies it: NFC-normalised, lowercase, and only the
 * letters, combining marks and digits of any script. The marks matter — in
 * Devanagari and Gujarati the vowel signs ARE marks, and dropping them would
 * turn different names into one.
 */
export function companyNameKey(value: string | undefined | null): string {
  const key = String(value || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
  // Names the product fills in when there is none are not a company's name:
  // two leads added with only a phone number are not the same "Untitled prospect".
  return PLACEHOLDER_NAMES.has(key) ? "" : key;
}

const PLACEHOLDER_NAMES = new Set(["untitledprospect", "discoveredbusiness", "unknown", "na", "none", "null"]);

export function emailKey(value: string | undefined | null): string {
  return String(value || "").trim().toLowerCase();
}

type Keys = { site: string; name: string; city: string; email: string; phones: string[] };

function keysOf(company: CompanyIdentity): Keys {
  return {
    site: websiteKey(company.websiteUrl),
    name: companyNameKey(company.companyName),
    city: companyNameKey(company.city),
    email: emailKey(company.email),
    phones: [company.phone, company.whatsappNumber].map((value) => String(value || "").trim()).filter(Boolean),
  };
}

function sameKeys(a: Keys, b: Keys): boolean {
  if (a.site && b.site && a.site === b.site) return true;
  if (a.phones.some((x) => b.phones.some((y) => samePhone(x, y)))) return true;
  if (a.email && a.email === b.email) return true;
  if (!a.name || a.name !== b.name) return false;
  const citiesKnown = Boolean(a.city && b.city);
  if (citiesKnown && a.city !== b.city) return false;
  if (a.site && b.site) return citiesKnown; // different websites: only when the city matches too
  return true;
}

/** Are these two records the same company? See the rule at the top of this file. */
export function isSameCompany(a: CompanyIdentity, b: CompanyIdentity): boolean {
  return sameKeys(keysOf(a), keysOf(b));
}

/**
 * The same check over a growing list (a CSV file, a discovery run), with each
 * record's keys worked out once rather than on every comparison.
 */
export class CompanyMatcher<T extends CompanyIdentity> {
  private readonly entries: Array<{ item: T; keys: Keys }> = [];

  constructor(items: T[] = []) {
    for (const item of items) this.add(item);
  }

  add(item: T) {
    this.entries.push({ item, keys: keysOf(item) });
  }

  find(candidate: CompanyIdentity): T | undefined {
    const keys = keysOf(candidate);
    return this.entries.find((entry) => sameKeys(keys, entry.keys))?.item;
  }
}
