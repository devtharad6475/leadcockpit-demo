/**
 * phone-match.ts — when two written phone numbers are the same person, for the
 * do-not-contact register (2026-09-24).
 *
 * The register compared numbers character for character after stripping
 * spaces, so "+91 98250 33333", "919825033333" (how WhatsApp reports a sender)
 * and "98250 33333" (how an Indian list usually stores one) were three
 * different people. Someone who said "stop" on WhatsApp before they were in
 * the CRM, and was later imported from a list written the other way, was not
 * recognised as opted out — at import or at send.
 *
 * The rule: digits only; numbers of 10 or more digits match on their last 10
 * (the subscriber number, with or without a country code or trunk 0); shorter
 * numbers must match exactly, so a stray "123" can never block half a list.
 * For an opt-out list, the safe mistake is blocking too much, never too little.
 */
export const PHONE_MATCH_DIGITS = 10;

export function phoneDigits(value: string | undefined | null): string {
  return (value || "").replace(/\D/g, "");
}

/** Do two written numbers belong to the same subscriber, for opt-out purposes? */
export function samePhoneForOptOut(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (!x || !y) return false;
  if (x.length < PHONE_MATCH_DIGITS || y.length < PHONE_MATCH_DIGITS) return x === y;
  return x.slice(-PHONE_MATCH_DIGITS) === y.slice(-PHONE_MATCH_DIGITS);
}

/**
 * The same rule as a database filter on a stored `normalizedPhone` (digits,
 * optionally with a leading "+"). Long numbers: ends with the last 10 digits.
 * Short numbers: equal, with or without the "+".
 */
export function optOutPhoneFilter(normalizedPhone: string): Record<string, unknown> | undefined {
  const digits = phoneDigits(normalizedPhone);
  if (!digits) return undefined;
  if (digits.length < PHONE_MATCH_DIGITS) return { normalizedPhone: { in: [digits, `+${digits}`] } };
  return { normalizedPhone: { endsWith: digits.slice(-PHONE_MATCH_DIGITS) } };
}

/**
 * Are two written numbers the same line, for "is this a lead we already
 * have?" (2026-09-26, moved here 2026-09-27 so manual add, CSV import and
 * discovery share it). Stricter than the opt-out rule on short numbers: fewer
 * than 7 digits is never a match, because a duplicate check that merges two
 * companies on a stray "123" loses one of them.
 */
export function samePhone(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (x.length < 7 || y.length < 7) return false;
  return x === y || (x.length >= PHONE_MATCH_DIGITS && y.length >= PHONE_MATCH_DIGITS && x.slice(-PHONE_MATCH_DIGITS) === y.slice(-PHONE_MATCH_DIGITS));
}
