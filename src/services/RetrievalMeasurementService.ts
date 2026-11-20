/**
 * RetrievalMeasurementService — what each layer of search actually buys, on a
 * workspace's REAL knowledge (N2 + N10, 2026-09-23, session 58).
 *
 * The same customer-worded questions, three ways:
 *   words only     the vector half disabled — what the product does with no
 *                  embedding provider;
 *   with meaning   the real hybrid search (words + meaning, fused);
 *   WhatsApp path  what a customer's message really gets: the plain search, and
 *                  only when that is weak, the loop that searches again in the
 *                  company's own words. Its extra model calls are counted.
 *
 * A question counts as FOUND when a passage containing the expected fact is in
 * the top 5 — the same bar the reply path uses; a fact at rank 40 never reaches
 * a customer.
 *
 * The questions are written the way buyers type, deliberately NOT in the
 * documents' own words. Questions phrased in the company's vocabulary are
 * answered by word-matching alone and would measure nothing: that is how a
 * search benchmark flatters itself.
 *
 * Sends nothing to anyone. Costs: one embedding per question, plus the loop's
 * calls on the questions where the plain search was weak.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { createRepositories } from "@/repositories";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { getRelevantContext } from "@/services/KnowledgeBaseService";
import { agenticRetrieval, RETRIEVAL_USABLE_CONFIDENCE } from "@/services/WhatsAppConversationEngine";
import { getSearchStatus, type SearchStatus } from "@/rag/search-status";

export type Probe = { asked: string; expect: RegExp; about: string };

export const DEFAULT_PROBES: Probe[] = [
  { about: "minimum order", asked: "kitna kam se kam lena padega ek baar me", expect: /\b(minimum|moq|kam se kam)\b/i },
  { about: "who they are", asked: "aap khud banate ho ya bahar se lete ho", expect: /\b(manufactur|own unit|katargam|in house|trader)\b/i },
  { about: "delivery time", asked: "maal pahunchne me kitne din lagenge", expect: /\b(day|days|din|dispatch|delivery|lead time)\b/i },
  { about: "payment", asked: "paisa pehle dena padega kya", expect: /\b(advance|payment|prepaid|credit|terms)\b/i },
  { about: "samples", asked: "pehle dekhne ke liye thoda bhej sakte ho", expect: /\b(sample|shade card|swatch)\b/i },
  { about: "colour range", asked: "kaun kaun se rang milte hain", expect: /\b(shade|colour|color|gold|antique|silver)\b/i },
  { about: "gold border price", asked: "gold border ka rate kya hai", expect: /\b(zari|border|lace|rate|price|rs|₹)\b/i },
  { about: "bulk discount", asked: "zyada quantity pe kuch kam hoga", expect: /\b(discount|bulk|quantity|slab|rate)\b/i },
  { about: "where they are", asked: "aapka factory kaha hai", expect: /\b(surat|gujarat|katargam|address)\b/i },
  { about: "packing", asked: "packing kaise aati hai", expect: /\b(pack|carton|cone|box|roll|kg)\b/i },
  { about: "customisation", asked: "apne design ke hisaab se bana sakte ho", expect: /\b(custom|design|special|order-made|shade match)\b/i },
  { about: "export", asked: "bahar desh bhejte ho kya", expect: /\b(export|india|domestic|overseas)\b/i },
];

export type ProbeResult = {
  about: string;
  asked: string;
  wordsOnly: boolean;
  withMeaning: boolean;
  /** Plain search was strong enough and contained the fact. */
  whatsappPlain: boolean;
  /** The loop ran (plain search was weak). */
  loopRan: boolean;
  /** The loop found it where the plain search had not. */
  loopRescued: boolean;
  loopModelCalls: number;
};

export type MeasurementReport = {
  status: SearchStatus;
  questions: number;
  wordsOnly: number;
  withMeaning: number;
  whatsappPlain: number;
  whatsappWithLoop: number;
  loopModelCalls: number;
  rows: ProbeResult[];
};

const contains = (texts: string[], expect: RegExp) => texts.slice(0, 5).some((text) => expect.test(text));

export async function measureRetrieval(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
  options: {
    probes?: Probe[];
    /** Seams, so the arithmetic can be proven without a provider. */
    retrievers?: { wordsOnly: SemanticRetriever; withMeaning: SemanticRetriever };
    loop?: typeof agenticRetrieval;
    plain?: typeof getRelevantContext;
  } = {},
): Promise<MeasurementReport> {
  const probes = options.probes ?? DEFAULT_PROBES;
  const wordsOnly = options.retrievers?.wordsOnly ?? new SemanticRetriever(repos, {
    embedWithModel: async () => { throw new Error("vector half disabled for this measurement"); },
    vectorSearch: async () => null,
  });
  const withMeaning = options.retrievers?.withMeaning ?? new SemanticRetriever(repos);
  const plain = options.plain ?? getRelevantContext;
  const loop = options.loop ?? agenticRetrieval;

  // Model calls are counted where every call is recorded, not estimated.
  let calls = 0;
  const counted = new Proxy(repos as unknown as Record<string, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "agentRun") {
        const runRepo = value as Record<string, unknown>;
        return new Proxy(runRepo, {
          get(runTarget, runProp) {
            const inner = Reflect.get(runTarget, runProp, runTarget);
            if (runProp === "create") return async (...args: unknown[]) => { calls += 1; return (inner as (...a: unknown[]) => unknown).apply(runTarget, args); };
            return typeof inner === "function" ? (inner as (...a: unknown[]) => unknown).bind(runTarget) : inner;
          },
        });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;

  const rows: ProbeResult[] = [];
  for (const probe of probes) {
    const words = await wordsOnly.retrieve(workspaceId, probe.asked, { limit: 5 });
    const meaning = await withMeaning.retrieve(workspaceId, probe.asked, { limit: 5 });

    const direct = await plain(workspaceId, probe.asked, repos);
    const directTexts = direct.chunks.map((chunk: { chunkText?: string }) => String(chunk.chunkText || ""));
    const plainOk = direct.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE && contains(directTexts, probe.expect);

    let loopRan = false;
    let loopRescued = false;
    const before = calls;
    // Mirrors the real path: the loop runs only when the plain search is weak.
    if (direct.confidenceScore < RETRIEVAL_USABLE_CONFIDENCE) {
      loopRan = true;
      const rescued = await loop(workspaceId, probe.asked, counted);
      if (rescued && rescued.confidenceScore > direct.confidenceScore) {
        const texts = rescued.chunks.map((chunk: { chunkText?: string }) => String(chunk.chunkText || ""));
        loopRescued = rescued.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE && contains(texts, probe.expect);
      }
    }

    rows.push({
      about: probe.about,
      asked: probe.asked,
      wordsOnly: contains(words.map((chunk) => chunk.chunkText), probe.expect),
      withMeaning: contains(meaning.map((chunk) => chunk.chunkText), probe.expect),
      whatsappPlain: plainOk,
      loopRan,
      loopRescued,
      loopModelCalls: calls - before,
    });
  }

  return {
    status: await getSearchStatus(workspaceId, repos),
    questions: rows.length,
    wordsOnly: rows.filter((row) => row.wordsOnly).length,
    withMeaning: rows.filter((row) => row.withMeaning).length,
    whatsappPlain: rows.filter((row) => row.whatsappPlain).length,
    whatsappWithLoop: rows.filter((row) => row.whatsappPlain || row.loopRescued).length,
    loopModelCalls: rows.reduce((sum, row) => sum + row.loopModelCalls, 0),
    rows,
  };
}
