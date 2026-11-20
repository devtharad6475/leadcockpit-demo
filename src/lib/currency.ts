/**
 * Which currency an order or quote is in (2026-09-27, sector review M7).
 *
 * The create routes took `currencyCode` as any string: "rupees" was saved as a
 * currency, and one INR order could hold a USD line whose amount was simply
 * added to the rupee lines — a total in no currency at all. Now:
 *   - the code must be an ISO-4217 three-letter code from the list below
 *     (upper-cased; "inr" is accepted as INR);
 *   - every line's currency, when a line names one, must equal the document's.
 * A mixed-currency order is not converted — there is no exchange rate to
 * convert with, and guessing one is not ours to do. The owner is asked to put
 * the lines on separate orders instead.
 *
 * Pinned by scripts/golden/golden-commercial-money-review.ts.
 */
import { NeedsActionError } from "@/lib/user-errors";

/** Active ISO-4217 currency codes. */
export const ISO_4217_CODES: ReadonlySet<string> = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD",
  "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK",
  "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY",
  "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF",
  "XPF", "YER", "ZAR", "ZMW", "ZWL",
]);

/**
 * The document's currency, checked: returns the upper-cased code (default
 * INR when none is given) or throws a plain NeedsActionError (400).
 */
export function resolveDocumentCurrency(
  currencyCode: unknown,
  lineItems: ReadonlyArray<{ currencyCode?: string; productName?: string }>,
  kind: "order" | "quote",
): string {
  const given = typeof currencyCode === "string" ? currencyCode.trim() : currencyCode;
  if (given !== undefined && given !== null && given !== "" && typeof given !== "string") {
    throw new NeedsActionError(`The currency must be a three-letter code such as INR or USD.`, 400);
  }
  const code = given ? String(given).toUpperCase() : "INR";
  if (!ISO_4217_CODES.has(code)) {
    throw new NeedsActionError(`"${given}" is not a currency code. Use a three-letter code such as INR or USD.`, 400);
  }
  for (const li of lineItems) {
    const lineCode = typeof li.currencyCode === "string" ? li.currencyCode.trim().toUpperCase() : "";
    if (lineCode && lineCode !== code) {
      throw new NeedsActionError(
        `${li.productName || "One line"} is priced in ${lineCode} but this ${kind} is in ${code}. Every line on one ${kind} must be in the same currency — put the ${lineCode} items on a separate ${kind}.`,
        400,
      );
    }
  }
  return code;
}
