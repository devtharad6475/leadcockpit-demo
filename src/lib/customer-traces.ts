/**
 * customer-traces.ts — "does this stored text talk about this customer?" for
 * right-to-erasure (2026-09-28, review S5).
 *
 * Some records carry no lead id but hold text about a customer: an AI agent
 * run's input and output (the conversation it was given, the draft it wrote),
 * the phone number in the webhook duplicate-check log. Erasure removes those
 * too. The needles are the lead's id, every phone number (last 10 digits),
 * the email, and the company and contact names when they are long enough to
 * be specific (4+ letters). Erring toward removing more is the safe mistake
 * here: an agent run is a log, not business data.
 */
import { phoneDigits, PHONE_MATCH_DIGITS } from "@/lib/phone-match";

export type CustomerNeedles = {
  leadId: string;
  /** Digit strings: the last 10 digits of each number (or all digits when shorter, 7+). */
  phones: string[];
  emails: string[];
  /** Lowercased names (company, contact) of 4+ characters. */
  names: string[];
};

export function customerNeedles(
  lead: { id: string; phone?: string | null; whatsappNumber?: string | null; email?: string | null; companyName?: string | null; contactName?: string | null },
  extraPhones: Array<string | null | undefined> = [],
): CustomerNeedles {
  const phones = new Set<string>();
  for (const value of [lead.phone, lead.whatsappNumber, ...extraPhones]) {
    const digits = phoneDigits(value);
    if (digits.length >= PHONE_MATCH_DIGITS) phones.add(digits.slice(-PHONE_MATCH_DIGITS));
    else if (digits.length >= 7) phones.add(digits);
  }
  const email = String(lead.email || "").trim().toLowerCase();
  const names = [lead.companyName, lead.contactName]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value.length >= 4);
  return { leadId: lead.id, phones: [...phones], emails: email ? [email] : [], names };
}

/**
 * True when the text mentions the customer. Phone numbers are matched after
 * removing spaces and dashes BETWEEN digits, so "+91 98250 33333" and
 * "98250-33333" both contain "9825033333".
 */
export function textMentionsCustomer(text: string, needles: CustomerNeedles): boolean {
  if (!text) return false;
  if (needles.leadId && text.includes(needles.leadId)) return true;
  const lower = text.toLowerCase();
  if (needles.emails.some((email) => lower.includes(email))) return true;
  if (needles.names.some((name) => lower.includes(name))) return true;
  if (needles.phones.length) {
    const squeezed = text.replace(/(?<=\d)[\s\-().]+(?=\d)/g, "");
    if (needles.phones.some((digits) => squeezed.includes(digits))) return true;
  }
  return false;
}

/** The searchable text of an agent run (input, output, error). */
export function agentRunText(run: { input?: unknown; output?: unknown; errorMessage?: string | null }): string {
  let body = "";
  try {
    body = JSON.stringify([run.input ?? null, run.output ?? null]);
  } catch {
    body = "";
  }
  return `${body} ${run.errorMessage || ""}`;
}
