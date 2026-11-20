/**
 * Product application research — what we sell, who buys it, and how to reach
 * them (N-FEAT-1, 2026-09-05).
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard's "what to do next" ladder has always had this rung in it:
 *
 *     "Analyze product applications and buyer segments to improve targeting."
 *
 * It is shown to every operator whose Knowledge Base is filled in but whose
 * `productKnowledges` collection is empty — which was every operator, because
 * nothing in the product could fill that collection. The five repositories
 * exist and are wired to Postgres, the five domain types are declared, the
 * dashboard reads them, and `smoke-mvp-flow` has been calling
 * `/api/product-research/generate` for as long as it has existed. The route was
 * never written, so the smoke got a 404 and three of its assertions had never
 * run once. The operator got an instruction pointing at nothing.
 *
 * WHAT IT PRODUCES. One chain, from the thing you sell down to the search you
 * would type to find someone who wants it:
 *
 *     product  →  variety  →  application  →  buyer segment  →  market map
 *
 * A market map is the row that matters commercially: this variety, used for
 * this application, sold to this kind of buyer, found with these searches.
 * That is what Discovery consumes.
 *
 * DETERMINISTIC FIRST, AI SECOND. The baseline is derived from the business
 * profile the operator already approved — their products, their categories,
 * their geographies, the customer types they said they want. It needs no model,
 * no key and no network, and it is what a workspace in sample mode gets. The
 * model is then asked to do better, and its answer is used only if it is
 * actually richer. This mirrors `generateICPs` in src/lib/agents.ts, which
 * settled the same trade-off for the same reasons.
 *
 * WHAT IT WILL NOT DO. It will not invent products the profile does not list.
 * Everything downstream is targeting advice, and targeting advice built on a
 * product the business does not sell is worse than none.
 */
import { LLMService } from "@/llm/LLMService";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type {
  BusinessProfile,
  BuyerSegment,
  ProductApplication,
  ProductApplicationMarketMap,
  ProductKnowledge,
  ProductVariety,
} from "@/lib/types";

/** What the route hands back, and what the smoke asserts on. */
export type ProductResearchResult = {
  products: ProductKnowledge[];
  varieties: ProductVariety[];
  applications: ProductApplication[];
  buyerSegments: BuyerSegment[];
  marketMaps: ProductApplicationMarketMap[];
  /** "real" when a model shaped the output, "deterministic" when the profile alone did. */
  mode: "real" | "deterministic";
};

type DraftProduct = { productName: string; productCategory?: string; description?: string };
type DraftSegment = {
  name: string;
  segmentType: string;
  description?: string;
  needs: string[];
  buyingCriteria: string[];
  preferredChannels: string[];
  qualificationSignals: string[];
  badFitSignals: string[];
};
type DraftApplication = { productName: string; applicationName: string; industry?: string; description?: string };

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];

/**
 * The baseline. Every field traces back to something the operator wrote in
 * their own business profile — nothing here is invented.
 */
function deterministicDraft(profile: BusinessProfile): {
  products: DraftProduct[];
  segments: DraftSegment[];
  applications: DraftApplication[];
} {
  const products: DraftProduct[] = (profile.products || []).slice(0, 12).map((productName, index) => ({
    productName,
    productCategory: (profile.productCategories || [])[index] || (profile.productCategories || [])[0] || profile.industry,
    description: `${productName} — supplied by ${profile.companyName || "this business"}.`,
  }));

  // The customer types the operator SAID they want come first; the ones they
  // already serve are the fallback, because a business with no stated target is
  // still selling to somebody.
  const wanted = (profile.desiredCustomerTypes || []).length
    ? profile.desiredCustomerTypes
    : (profile.currentCustomerTypes || []);
  const segments: DraftSegment[] = wanted.slice(0, 8).map((name) => ({
    name,
    segmentType: profile.businessType || "b2b",
    description: `${name} buying ${(profile.products || []).slice(0, 2).join(" and ") || "from this business"}.`,
    needs: (profile.strengths || []).slice(0, 4),
    buyingCriteria: ["Consistent quality", "Delivery on time", "Price at trade rates"],
    preferredChannels: ["whatsapp", "phone"],
    qualificationSignals: [`Operates in ${(profile.targetGeographies || []).slice(0, 2).join(" or ") || "the target region"}`, "Buys in trade quantity"],
    badFitSignals: ["Retail or single-piece buyer", "Below the minimum order"],
  }));

  // One application per product per geography is a combinatorial explosion for
  // no gain, so the baseline stays at one application per product: the industry
  // the operator already named. The model is what adds breadth.
  const applications: DraftApplication[] = products.map((product) => ({
    productName: product.productName,
    applicationName: `${product.productName} for ${profile.industry || "trade"} buyers`,
    industry: profile.industry,
    description: `Where ${product.productName} is actually used by ${wanted[0] || "trade buyers"}.`,
  }));

  return { products, segments, applications };
}

/** Ask the model to do better than the baseline. Returns null unless it did. */
async function llmDraft(
  profile: BusinessProfile,
  repos: RepositoryBundle,
  llm: Pick<LLMService, "runTask">,
): Promise<{ products: DraftProduct[]; segments: DraftSegment[]; applications: DraftApplication[] } | null> {
  try {
    const result = await llm.runTask<{ products?: unknown[]; buyerSegments?: unknown[]; applications?: unknown[] }>(
      "product_application_research",
      {
        businessProfile: {
          companyName: profile.companyName,
          industry: profile.industry,
          businessType: profile.businessType,
          description: profile.description,
          products: profile.products,
          productCategories: profile.productCategories,
          targetGeographies: profile.targetGeographies,
          currentCustomerTypes: profile.currentCustomerTypes,
          desiredCustomerTypes: profile.desiredCustomerTypes,
          strengths: profile.strengths,
          limitations: profile.limitations,
        },
        instructions:
          "For this business, return three arrays. `products`: one entry per product THIS BUSINESS ACTUALLY LISTS, each { productName, productCategory, description }. Do not add a product that is not in the profile's products list. " +
          "`applications`: 1 to 3 real end-uses per product, each { productName (must match a product above), applicationName, industry, description }. " +
          "`buyerSegments`: 3 to 6 kinds of buyer, each { name, segmentType, description, needs (array), buyingCriteria (array), preferredChannels (array), qualificationSignals (array), badFitSignals (array) }. " +
          "Respect the business's stated limitations — never describe a use the business says it does not serve.",
      },
      { workspaceId: profile.workspaceId },
    );

    // Sample mode returns a placeholder object, not research. Treating that as
    // an answer is how a demo starts claiming a model wrote something.
    if (result.mode === "mock" || result.provider === "mock") return null;

    const listed = new Set((profile.products || []).map((name) => name.toLowerCase().trim()));
    const products = (Array.isArray(result.output?.products) ? result.output.products : [])
      .map((raw) => raw as Record<string, unknown>)
      .map((raw) => ({
        productName: String(raw.productName || "").trim(),
        productCategory: raw.productCategory ? String(raw.productCategory).trim() : undefined,
        description: raw.description ? String(raw.description).trim() : undefined,
      }))
      // The profile is the authority on what this business sells.
      .filter((product) => product.productName && (listed.size === 0 || listed.has(product.productName.toLowerCase())));

    const productNames = new Set(products.map((product) => product.productName.toLowerCase()));
    const applications = (Array.isArray(result.output?.applications) ? result.output.applications : [])
      .map((raw) => raw as Record<string, unknown>)
      .map((raw) => ({
        productName: String(raw.productName || "").trim(),
        applicationName: String(raw.applicationName || "").trim(),
        industry: raw.industry ? String(raw.industry).trim() : undefined,
        description: raw.description ? String(raw.description).trim() : undefined,
      }))
      .filter((application) => application.applicationName && productNames.has(application.productName.toLowerCase()));

    const segments = (Array.isArray(result.output?.buyerSegments) ? result.output.buyerSegments : [])
      .map((raw) => raw as Record<string, unknown>)
      .map((raw) => ({
        name: String(raw.name || "").trim(),
        segmentType: String(raw.segmentType || profile.businessType || "b2b").trim(),
        description: raw.description ? String(raw.description).trim() : undefined,
        needs: stringArray(raw.needs),
        buyingCriteria: stringArray(raw.buyingCriteria),
        preferredChannels: stringArray(raw.preferredChannels),
        qualificationSignals: stringArray(raw.qualificationSignals),
        badFitSignals: stringArray(raw.badFitSignals),
      }))
      .filter((segment) => segment.name);

    // Only worth using if it beat the floor on every axis it is responsible for.
    if (!products.length || segments.length < 3 || !applications.length) return null;
    return { products, segments, applications };
  } catch {
    return null;
  }
}

/** The search phrases Discovery will actually run for one product/segment pair. */
function searchQueriesFor(productName: string, segmentName: string, geographies: string[]): string[] {
  const places = geographies.length ? geographies.slice(0, 3) : [""];
  return places
    .map((place) => `${segmentName} ${productName} ${place}`.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export async function runProductApplicationResearch(
  profile: BusinessProfile,
  repos: RepositoryBundle,
  /** Test seam, same reasoning as generateICPs: lets a golden drive the fallback without network traffic. */
  llm: Pick<LLMService, "runTask"> = new LLMService(undefined, repos),
): Promise<ProductResearchResult> {
  const baseline = deterministicDraft(profile);
  const fromModel = await llmDraft(profile, repos, llm);
  const draft = fromModel ?? baseline;
  const mode: ProductResearchResult["mode"] = fromModel ? "real" : "deterministic";

  // A business profile with no products cannot produce targeting advice, and
  // inventing some would be worse than saying so. The route turns this into a
  // plain-English message rather than an empty success.
  if (!draft.products.length) {
    return { products: [], varieties: [], applications: [], buyerSegments: [], marketMaps: [], mode };
  }

  // 2026-09-05 N-FEAT-1 — REPLACE, never append.
  //
  // The first version of this created rows and left whatever was there before.
  // Four runs during testing produced 21 products and 172 market maps for a
  // business that sells five things: pressing the button twice doubled the
  // operator's targeting list and made every count on the dashboard a lie.
  //
  // ICP generation settled this already (`replaceForBusinessProfile`), and this
  // is the same situation — a fresh run supersedes the last one, it does not add
  // to it.
  //
  // N-BUG-5 (2026-09-05): the first attempt at this cleared the five collections
  // inside a `repos.mutateAll`. That deletes on the JSON substrate and does
  // NOTHING on Postgres, where the snapshot writer is upsert-only — so the
  // counts kept climbing (21 -> 26 products) while the run reported five. The
  // clear-out goes through the repositories, children before parents, so it is
  // correct on either substrate and safe if a foreign key is enforced.
  await repos.productApplicationMarketMap.deleteByWorkspace(profile.workspaceId);
  await repos.productApplication.deleteByWorkspace(profile.workspaceId);
  await repos.productVariety.deleteByWorkspace(profile.workspaceId);
  await repos.buyerSegment.deleteByWorkspace(profile.workspaceId);
  await repos.productKnowledge.deleteByWorkspace(profile.workspaceId);

  const products: ProductKnowledge[] = [];
  for (const product of draft.products) {
    products.push(await repos.productKnowledge.create({
      workspaceId: profile.workspaceId,
      productName: product.productName,
      productCategory: product.productCategory,
      description: product.description,
      source: mode === "real" ? "ai_research" : "business_profile",
      confidenceScore: mode === "real" ? 0.75 : 0.6,
    }));
  }
  const productByName = new Map(products.map((product) => [product.productName.toLowerCase(), product]));

  // One variety per product by default. The profile does not carry variety
  // detail, so claiming several would be invention; the Knowledge Base's
  // product_varieties domain is where real variety detail is captured.
  const varieties = await repos.productVariety.createMany(products.map((product) => ({
    workspaceId: profile.workspaceId,
    productKnowledgeId: product.id,
    name: `${product.productName} (standard)`,
    description: `The default grade of ${product.productName}.`,
    useCases: [],
    buyerTypes: draft.segments.map((segment) => segment.name).slice(0, 4),
    confidenceScore: mode === "real" ? 0.7 : 0.55,
  })));
  const varietyByProductId = new Map(varieties.map((variety) => [variety.productKnowledgeId, variety]));

  const applications = await repos.productApplication.createMany(
    draft.applications
      .filter((application) => productByName.has(application.productName.toLowerCase()))
      .map((application) => {
        const product = productByName.get(application.productName.toLowerCase())!;
        return {
          workspaceId: profile.workspaceId,
          productKnowledgeId: product.id,
          varietyId: varietyByProductId.get(product.id)?.id,
          applicationName: application.applicationName,
          industry: application.industry,
          description: application.description,
          exampleProducts: [product.productName],
          buyerTypes: draft.segments.map((segment) => segment.name).slice(0, 4),
          seasonality: {},
          confidenceScore: mode === "real" ? 0.7 : 0.55,
        };
      }),
  );

  const buyerSegments = await repos.buyerSegment.createMany(draft.segments.map((segment) => ({
    workspaceId: profile.workspaceId,
    name: segment.name,
    segmentType: segment.segmentType,
    description: segment.description,
    needs: segment.needs,
    buyingCriteria: segment.buyingCriteria,
    preferredChannels: segment.preferredChannels,
    qualificationSignals: segment.qualificationSignals,
    badFitSignals: segment.badFitSignals,
  })));

  // The commercial output: every application crossed with every buyer segment,
  // each row carrying the searches Discovery would run to find that buyer.
  const marketMapDrafts: Partial<ProductApplicationMarketMap>[] = [];
  for (const application of applications) {
    const product = products.find((entry) => entry.id === application.productKnowledgeId);
    if (!product) continue;
    for (const segment of buyerSegments) {
      marketMapDrafts.push({
        workspaceId: profile.workspaceId,
        productKnowledgeId: product.id,
        varietyId: application.varietyId,
        applicationId: application.id,
        buyerSegmentId: segment.id,
        targetingAngle: `${segment.name} who need ${application.applicationName}`,
        messageAngle: `Lead with ${(profile.strengths || [])[0] || "what makes this business different"} when approaching ${segment.name}.`,
        searchQueries: searchQueriesFor(product.productName, segment.name, profile.targetGeographies || []),
        leadSources: ["google_maps", "manual"],
        confidenceScore: mode === "real" ? 0.7 : 0.55,
      });
    }
  }
  const marketMaps = await repos.productApplicationMarketMap.createMany(marketMapDrafts);

  return { products, varieties, applications, buyerSegments, marketMaps, mode };
}
