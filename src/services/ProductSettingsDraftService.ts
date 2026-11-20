import { uid } from "@/lib/db";
import type { ProductSetting } from "@/lib/types";

export type ProductSettingsDraftResult = {
  products: ProductSetting[];
  warnings: string[];
};

const FIELD_PATTERNS: Array<{ field: keyof ProductSetting; pattern: RegExp }> = [
  { field: "category", pattern: /\b(?:category|type|segment)\s*[:=-]\s*([^;,\n]+)/i },
  { field: "material", pattern: /\b(?:material|made of|composition)\s*[:=-]\s*([^;,\n]+)/i },
  { field: "packaging", pattern: /\b(?:packaging|packing|pack size|unit)\s*[:=-]\s*([^;,\n]+)/i },
  { field: "moq", pattern: /\b(?:moq|minimum order|minimum quantity|min order)\s*[:=-]?\s*([^;,\n]+)/i },
  { field: "inStockDispatchTime", pattern: /\b(?:dispatch|in-stock dispatch|ready stock dispatch|stock dispatch)\s*[:=-]\s*([^;,\n]+)/i },
  { field: "productionDispatchTime", pattern: /\b(?:production dispatch|made to order|production time|lead time)\s*[:=-]\s*([^;,\n]+)/i },
  { field: "notes", pattern: /\b(?:notes|note|remarks)\s*[:=-]\s*([^;\n]+)/i },
];

/**
 * 2026-09-08 — the price a product is sold at.
 *
 * ProductSetting has carried `price` and `priceUnit` since 2026-07-19, the
 * Catalogue screen renders them, and the quoting path reads them. Nothing ever
 * WROTE them: the product editor had no price field and this parser ignored the
 * word entirely, so every workspace showed "No price set" for ever and the
 * price-change preview could never run on a real number. The unit is captured
 * as a single word ("300 per Kg", "300/kg") because anything greedier swallows
 * the rest of the sentence.
 */
const PRICE_PATTERN =
  /\b(?:price|rate)\s*[:=-]\s*(?:rs\.?|inr|₹)?\s*([0-9][\d,]*(?:\.\d+)?)\s*(?:\/\s*|per\s+)?([A-Za-z]{1,10})?/i;

export function draftProductSettingsFromNotes(notes: string): ProductSettingsDraftResult {
  const cleaned = notes.replace(/\r/g, "").trim();
  if (!cleaned) return { products: [], warnings: ["Add product details before creating a draft."] };

  const sections = splitProductSections(cleaned);
  const products = sections
    .map((section) => draftProductFromSection(section))
    .filter((product): product is ProductSetting => Boolean(product));

  const warnings: string[] = [];
  if (!products.length) {
    warnings.push("No clear product names were detected. Add one product per line or start each section with the product name.");
  }
  for (const product of products) {
    if (!product.moq) warnings.push(`${product.name}: MOQ was not detected.`);
    if (!product.packaging) warnings.push(`${product.name}: packaging was not detected.`);
    if (!product.inStockDispatchTime && !product.productionDispatchTime) warnings.push(`${product.name}: dispatch time was not detected.`);
    if (product.price === undefined) warnings.push(`${product.name}: price was not detected.`);
  }

  return { products, warnings };
}

function splitProductSections(notes: string) {
  const blockSections = notes
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (blockSections.length > 1) return blockSections;

  const lineSections = notes
    .split(/\n/g)
    .map((line) => stripListMarker(line))
    .filter(Boolean);
  return lineSections.length > 1 ? lineSections : [notes];
}

/** "- Widget", "* Widget", "1. Widget" and "2) Widget" are all list markers. */
function stripListMarker(line: string) {
  return line
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .trim();
}

function draftProductFromSection(section: string): ProductSetting | undefined {
  const named = extractName(section);
  if (!named) return undefined;
  const { name, truncated } = named;

  const product: ProductSetting = {
    id: uid("product"),
    name,
    category: "",
    variants: [],
    material: "",
    sizeSpec: "",
    packaging: "",
    customizationAvailable: /\b(custom|customi[sz]ation|made to order)\b/i.test(section),
    inStockDispatchTime: "",
    productionDispatchTime: "",
    moq: "",
    useCaseTags: extractTags(section),
    notes: "",
  };

  for (const { field, pattern } of FIELD_PATTERNS) {
    const value = section.match(pattern)?.[1]?.trim();
    if (value && typeof product[field] !== "boolean") {
      (product[field] as string | string[]) = value;
    }
  }

  const priceMatch = section.match(PRICE_PATTERN);
  if (priceMatch) {
    const amount = Number(priceMatch[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) {
      product.price = amount;
      const unit = (priceMatch[2] || "").trim();
      if (unit && !/^per$/i.test(unit)) product.priceUnit = `per ${unit}`;
    }
  }

  const variants = section.match(/\b(?:variants|sizes|colors|colours|grades)\s*[:=-]\s*([^;\n]+)/i)?.[1];
  // T1.2 / 2026-07-20: variants is now ProductVariant[] not string[]. Map
  // extracted strings to { id, name } stubs; the owner fills price/SKU later.
  if (variants) product.variants = splitList(variants).map((name, index) => ({ id: `${product.id}_v${index}`, name }));

  // A truncated name is only the head of the sentence the owner wrote, so
  // subtracting it from the section leaves a fragment ("to large businesses.").
  // Keep the whole section in that case — nothing the owner typed is dropped.
  if (!product.notes) product.notes = truncated ? section.trim() : buildNotes(section, name);

  return product;
}

/** Field labels that must never be mistaken for a product name. */
const FIELD_LABEL = /^(?:category|type|segment|material|composition|packaging|packing|pack size|unit|moq|minimum order|minimum quantity|min order|dispatch|in-stock dispatch|ready stock dispatch|stock dispatch|production dispatch|made to order|production time|lead time|variants|sizes|colors|colours|grades|use cases|uses|applications|used for|notes|note|remarks|price|pricing|description)$/i;

const NAME_MAX = 80;

function extractName(section: string): { name: string; truncated: boolean } | undefined {
  const explicit = section.match(/\b(?:product|item|sku)\s*[:=-]\s*([^;,\n]+)/i)?.[1]?.trim();
  const source = explicit || section.split(/\n/)[0]?.trim() || "";
  const cleaned = cleanName(source);
  return cleaned.name ? cleaned : undefined;
}

/**
 * The name ends at the first separator. " - ", " | " and " : " were already
 * accepted; a colon with NO space before it ("Cloud ERP System: A comprehensive
 * enterprise resource planning system...") is how people ordinarily write a
 * product and its description, and it was the one form this did not accept —
 * the whole sentence became the name and was then chopped at 80 characters
 * mid-word.
 */
function splitAtSeparator(value: string) {
  const spaced = value.split(/\s[-|]\s/)[0]?.trim() || "";
  if (spaced && spaced !== value.trim()) return spaced;

  const colon = value.search(/:\s/);
  if (colon > 0) {
    const head = value.slice(0, colon).trim();
    // "MOQ: 500 pieces" is a field line, not a product called "MOQ".
    if (head && !FIELD_LABEL.test(head)) return head;
  }
  return value.trim();
}

function cleanName(value: string): { name: string; truncated: boolean } {
  const base = stripListMarker(value).replace(/\b(?:product|item|sku)\s*[:=-]\s*/i, "");
  const upToSeparator = splitAtSeparator(base)
    .split(/\s[-:|]\s*(?:category|type|segment|material|packaging|packing|moq|minimum|dispatch|uses|applications)\b/i)[0]
    .trim();
  if (upToSeparator.length <= NAME_MAX) return { name: upToSeparator, truncated: false };

  // Still capped, but cut at a word boundary — a name ending "for medium" reads
  // as a broken sentence everywhere it is shown, the warnings included.
  const cut = upToSeparator.slice(0, NAME_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return { name: (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim(), truncated: true };
}

function extractTags(section: string) {
  const match = section.match(/\b(?:use cases|uses|applications|used for)\s*[:=-]\s*([^;\n]+)/i)?.[1];
  return match ? splitList(match) : [];
}

function splitList(value: string) {
  return value
    .split(/[,/|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildNotes(section: string, name: string) {
  return section
    .replace(new RegExp(`\\b(?:product|item|sku)\\s*[:=-]\\s*${escapeRegExp(name)}`, "i"), "")
    .replace(new RegExp(escapeRegExp(name), "i"), "")
    .replace(/^[\s:;,\-|]+/, "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
