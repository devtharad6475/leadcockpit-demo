export type NormalizedCompanySizeBucket =
  | "solo_small_business"
  | "small_company"
  | "medium_company"
  | "large_company"
  | "unknown";

export function normalizeCompanySizeBucket(value: string | null | undefined): NormalizedCompanySizeBucket {
  const normalized = value?.trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");

  switch (normalized) {
    case "solo/small business":
    case "solo":
    case "small business":
    case "solo small business":
    case "solo_small_business":
      return "solo_small_business";
    case "small company":
    case "small_company":
      return "small_company";
    case "medium company":
    case "medium_company":
      return "medium_company";
    case "large company":
    case "large_company":
      return "large_company";
    default:
      return "unknown";
  }
}

/**
 * The domain form of a company-size bucket, as declared by
 * `Lead["companySizeBucket"]` / `ICP["companySizeBucket"]` in src/lib/types.ts:
 * a human-readable label with spaces and a slash, not the Postgres enum name.
 */
export type DomainCompanySizeBucket =
  | "solo/small business"
  | "small company"
  | "medium company"
  | "large company"
  | "unknown";

/**
 * Turn the stored Postgres enum value back into the domain form.
 *
 * WHY (N-DATA-2, 2026-08-18): `CompanySizeBucket` in schema.prisma is an enum
 * whose members are `small_company` etc., because Postgres enum labels cannot
 * carry the slash and spaces the domain type uses. Writes normalise into that
 * form, but reads returned it VERBATIM — `String(record.companySizeBucket)`
 * with an `as ICP["companySizeBucket"]` cast on the end. The cast is what hid
 * the problem: `small_company` is not a member of that union, so the Prisma
 * substrate was returning a value its own declared type forbids, and the JSON
 * substrate returned `small company` for the same row. The UI renders the field
 * raw (src/app/page.tsx), so the same lead read "small company" on JSON and
 * "small_company" on Postgres.
 *
 * The domain form is the canonical one here — it is what the shared type
 * declares and what every non-Prisma path already produces — so the enum is
 * mapped back on the way out rather than the domain being changed to match the
 * database.
 */
export function denormalizeCompanySizeBucket(value: unknown): DomainCompanySizeBucket {
  switch (normalizeCompanySizeBucket(value == null ? undefined : String(value))) {
    case "solo_small_business": return "solo/small business";
    case "small_company": return "small company";
    case "medium_company": return "medium company";
    case "large_company": return "large company";
    default: return "unknown";
  }
}
