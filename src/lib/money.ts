/**
 * Stage A+ / Cluster 10d (2026-07-26, P2-12) — Money-safe arithmetic helpers.
 *
 * The problem (audit finding N1/P2-12): the commercial code uses raw float
 * arithmetic (`quantity * unitPrice`, `acc + li.lineTotal`) rounded via
 * `Math.round(x * 100) / 100`. Floats can't represent most decimal fractions
 * exactly (0.1 + 0.2 = 0.30000000000000004 in JS). For typical commerce
 * amounts the rounding-then-storing masks the error, BUT repeated
 * accumulation across many line items can drift by a few paise, and
 * comparisons (`unitPrice < base`) can produce wrong results near boundaries.
 *
 * The proper fix (per the audit) is integer paise end-to-end. But that's a
 * large refactor touching the data type, DB schema, and UI rendering. As a
 * P2 polish item, the pragmatic chokepoint fix is THIS module: do the
 * arithmetic in integer paise internally, expose float rupees at the boundary
 * so callers don't have to change. The data shape stays the same; the math
 * becomes exact.
 *
 * All commercial arithmetic should route through these helpers (build-right
 * Phase 3d — one gate for the money rule).
 *
 * Convention:
 *   - Inputs/outputs at the public API boundary are FLOAT RUPEES (e.g. 450.00,
 *     4500.50) for backward compatibility with the existing data shape.
 *   - Internally we convert to INTEGER PAISE (45000, 450050) for arithmetic,
 *     which is exact.
 *   - We always round DOWN to whole paise (no fractional-paise exists in INR).
 */

/** Convert float rupees → integer paise (rounds to nearest whole paise). */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Convert integer paise → float rupees (2 decimal places). */
export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/**
 * S6 W-3: guard against silent precision loss when money math exceeds
 * Number.MAX_SAFE_INTEGER (~9e15). At extreme inputs (e.g. quantity=200,
 * unitPrice=1e15 → 2e19 paise) JS float arithmetic silently loses precision.
 * This throws a clear error instead of returning a corrupted total. Callers
 * that legitimately handle huge values should catch + surface the error.
 */
export const MAX_MONEY_PAISE = Number.MAX_SAFE_INTEGER;
export class MoneyOverflowError extends Error {
  constructor(message: string) { super(message); this.name = "MoneyOverflowError"; }
}
function assertMoneyFits(paise: number, context: string): void {
  if (!Number.isSafeInteger(paise) || Math.abs(paise) > MAX_MONEY_PAISE) {
    throw new MoneyOverflowError(`${context} exceeds safe integer precision (paise=${paise}). Reject the input — likely a fat-finger price entry.`);
  }
}

/**
 * The decimal a number was written as, held exactly: 0.045 → { digits: 45,
 * scale: 3 }. `String(n)` gives the shortest decimal that round-trips to the
 * same double, which is the value the person typed ("0.045", "12.345"), so
 * working from it avoids the binary error in 0.045 × 100.
 */
function toExactDecimal(n: number, context: string): { digits: bigint; scale: number } {
  if (!Number.isFinite(n)) throw new MoneyOverflowError(`${context} got a value that is not a finite number (${n}).`);
  const [mantissa, expPart] = String(n).toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? mantissa.slice(1) : mantissa).split(".");
  let digits = BigInt(intPart + fracPart);
  let scale = fracPart.length - (expPart ? Number(expPart) : 0);
  if (scale < 0) {
    digits *= BigInt(10) ** BigInt(-scale);
    scale = 0;
  }
  return { digits: negative ? -digits : digits, scale };
}

/** Add signed quantities as written decimals, without rounding them to money or a fixed precision. */
export function sumQuantitiesExact(...quantities: number[]): number {
  const values = quantities.map((quantity) => toExactDecimal(quantity, "sumQuantitiesExact"));
  const scale = Math.max(0, ...values.map((value) => value.scale));
  const digits = values.reduce((sum, value) => sum + value.digits * BigInt(10) ** BigInt(scale - value.scale), BigInt(0));
  const result = Number(`${digits}e-${scale}`);
  if (!Number.isFinite(result)) throw new MoneyOverflowError("The quantity total is too large to store safely.");
  return result;
}

/** An exact decimal amount in rupees → whole paise, rounded ONCE, half away from zero. */
function exactDecimalToPaise(digits: bigint, scale: number, context: string): number {
  let paise: bigint;
  if (scale <= 2) {
    paise = digits * BigInt(10) ** BigInt(2 - scale);
  } else {
    const divisor = BigInt(10) ** BigInt(scale - 2);
    const negative = digits < BigInt(0);
    const abs = negative ? -digits : digits;
    let whole = abs / divisor;
    if ((abs % divisor) * BigInt(2) >= divisor) whole += BigInt(1);
    paise = negative ? -whole : whole;
  }
  const out = Number(paise);
  // S6 W-3: guard against silent precision loss at extreme inputs.
  assertMoneyFits(out, context);
  return out;
}

/** quantity × unitPrice in whole paise: the exact product, rounded once. */
function exactLinePaise(quantity: number, unitPrice: number, context: string): number {
  const q = toExactDecimal(quantity, context);
  const p = toExactDecimal(unitPrice, context);
  return exactDecimalToPaise(q.digits * p.digits, q.scale + p.scale, context);
}

/**
 * Line total = quantity × unitPrice, exact. Returns float rupees.
 * unitPrice is float rupees; quantity is a positive number (may be fractional —
 * a B2B textile business sells zari by the metre/kg, so 1.5m / 0.5kg are real).
 *
 * Audit 2026-07-27 S6/D-2: this previously did Math.round(quantity), which
 * silently turned 1.5m × ₹100 into ₹200 instead of ₹150.
 *
 * 2026-09-27 (sector review M2): the unit price was rounded to whole paise
 * BEFORE the multiply, so a price finer than a paise lost its fraction and the
 * error was then multiplied by the quantity: 100,000 m × ₹0.045 came out
 * ₹5,000 (true ₹4,500) and 1,000 × ₹12.345 came out ₹12,350 (true ₹12,345).
 * Per-metre and per-gram pricing lives exactly there. Now both numbers are
 * taken as the decimals they were written as, multiplied as whole integers,
 * and the LINE TOTAL is rounded to paise once, half away from zero.
 *
 * Replaces `Math.round(quantity * unitPrice * 100) / 100`.
 */
export function computeLineTotalPaise(quantity: number, unitPrice: number): number {
  return paiseToRupees(exactLinePaise(quantity, unitPrice, "computeLineTotalPaise"));
}

/**
 * Sum of line totals, exact. Accepts an array of {quantity, unitPrice} or
 * {lineTotal}. Returns float rupees.
 *
 * Replaces `Math.round(lineItems.reduce(...) * 100) / 100`.
 */
export function sumLineTotalsPaise<T extends { lineTotal?: number; quantity?: number; unitPrice?: number }>(items: T[]): number {
  // Sum in whole paise (integer arithmetic — no float drift across many items).
  // A line with no stored total is priced exactly as computeLineTotalPaise
  // prices it: exact product, rounded once per line (M2, 2026-09-27).
  const totalPaise = items.reduce((acc, li) => {
    if (typeof li.lineTotal === "number") return acc + rupeesToPaise(li.lineTotal);
    if (typeof li.quantity === "number" && typeof li.unitPrice === "number") {
      return acc + exactLinePaise(li.quantity, li.unitPrice, "sumLineTotalsPaise");
    }
    return acc;
  }, 0);
  // S6 W-3: guard the accumulated total too (many large lines can overflow).
  assertMoneyFits(Math.round(totalPaise), "sumLineTotalsPaise");
  return paiseToRupees(totalPaise);
}

/**
 * Discount amount = (base − unitPrice) × quantity, exact. Returns float rupees.
 *
 * Replaces `Math.round((base - li.unitPrice) * li.quantity * 100) / 100`.
 * 2026-09-27 (M2): same rule as the line total — the per-unit difference stays
 * exact (₹0.005/m off on 100,000 m is ₹500) and the result is rounded once.
 */
export function computeDiscountAmountPaise(basePrice: number, unitPrice: number, quantity: number): number {
  // base − unitPrice can be negative if it's actually a markup; we don't
  // clamp here (the caller checks unitPrice < base before calling).
  const context = "computeDiscountAmountPaise";
  const base = toExactDecimal(basePrice, context);
  const unit = toExactDecimal(unitPrice, context);
  const qty = toExactDecimal(quantity, context);
  const scale = Math.max(base.scale, unit.scale);
  const diff = base.digits * BigInt(10) ** BigInt(scale - base.scale)
    - unit.digits * BigInt(10) ** BigInt(scale - unit.scale);
  return paiseToRupees(exactDecimalToPaise(diff * qty.digits, scale + qty.scale, context));
}

/**
 * Sum of discount amounts across many lines, exact. Returns float rupees.
 *
 * Replaces `Math.round((totalDiscountAmount + discountAmount) * 100) / 100`.
 */
export function sumDiscountAmountsPaise(amounts: number[]): number {
  const totalPaise = amounts.reduce((acc, a) => acc + rupeesToPaise(a), 0);
  return paiseToRupees(totalPaise);
}

/**
 * Money-safe comparison. Returns -1/0/1 like a normal comparator but without
 * float-equality pitfalls. Use this instead of `a < b` / `a === b` when the
 * values are money and could be near a boundary.
 */
export function compareMoney(a: number, b: number): -1 | 0 | 1 {
  const aPaise = rupeesToPaise(a);
  const bPaise = rupeesToPaise(b);
  if (aPaise < bPaise) return -1;
  if (aPaise > bPaise) return 1;
  return 0;
}

/**
 * THE shared currency formatter — one chokepoint for money DISPLAY.
 *
 * 2026-08-02 audit P2-1 fix. Pre-fix the UI inlined formatting at every site:
 * the create-order form used `(qty*price).toFixed(2)` → "₹1500.00" (no grouping,
 * locale-unaware), while the order detail used `x.toLocaleString("en-IN")` →
 * "₹1,500" (Indian grouping, no decimals). Two different formats on adjacent
 * screens. This one helper fixes the whole family: Indian grouping + exactly 2
 * decimals, e.g. 123456 → "₹1,23,456.00".
 *
 * Use this EVERYWHERE money is shown to a user (lists, details, forms, PDFs).
 * Never inline `toLocaleString`/`toFixed` for currency again.
 *
 * @param rupees float rupees (the stored shape — money.ts uses float rupees at
 *   the boundary). null/undefined/NaN → "₹0.00" (defensive; a missing field
 *   should never render a broken "₹NaN").
 */
export function formatINR(rupees: number | null | undefined): string {
  const safe = typeof rupees === "number" && Number.isFinite(rupees) ? rupees : 0;
  return `₹${safe.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Same as formatINR but without the ₹ symbol — for contexts where the symbol is
 * rendered separately (e.g. a column header already shows "Amount (₹)"). Keeps
 * the Indian grouping + 2 decimals consistent.
 */
export function formatINRNumber(rupees: number | null | undefined): string {
  const safe = typeof rupees === "number" && Number.isFinite(rupees) ? rupees : 0;
  return safe.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Unit rates can be finer than a currency cent; totals alone round to cents. */
export function formatUnitPriceNumber(amount: number): string {
  const scale = toExactDecimal(amount, "formatUnitPriceNumber").scale;
  if (scale > 20) return String(amount);
  return amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, scale) });
}

export function formatUnitPriceMoney(amount: number, currencyCode: string): string {
  const scale = toExactDecimal(amount, "formatUnitPriceMoney").scale;
  const code = (currencyCode || "INR").toUpperCase();
  if (scale > 20) return `${code} ${String(amount)}`;
  try {
    return amount.toLocaleString("en-IN", { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, scale) });
  } catch {
    return `${code} ${formatUnitPriceNumber(amount)}`;
  }
}

/**
 * Money in whatever currency the record actually says (2026-09-04, N-UX-23).
 *
 * THE BUG THIS CLOSES. Four screens rendered `{formatINR(x)} {row.currencyCode}`
 * — the amount through a formatter that hard-codes the rupee sign, followed by
 * the row's own currency code. On the demo data both halves say INR and the
 * only visible symptom is the clumsy "₹6,000.00 INR". On a record stored in any
 * other currency the same line reads "₹6,000.00 USD", which is not clumsy, it
 * is wrong: it shows a dollar amount wearing a rupee sign, and a person acting
 * on that number acts on a figure ~85x out.
 *
 * One symbol, taken from the record, and no trailing code to contradict it.
 */
export function formatMoney(amount: number | null | undefined, currencyCode: string | null | undefined): string {
  const safe = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const code = (currencyCode || "INR").toUpperCase();
  try {
    return safe.toLocaleString("en-IN", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    // An unknown or malformed code makes Intl throw. Printing the code beside
    // a plain number is honest; guessing a symbol for it would not be.
    return `${code} ${formatINRNumber(safe)}`;
  }
}
