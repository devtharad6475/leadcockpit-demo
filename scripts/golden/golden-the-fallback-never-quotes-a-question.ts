/**
 * Golden test — the reply sent when the model produced nothing does not read a
 * stored QUESTION out to the customer, and never repeats a chunk that is
 * marked as not quotable.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo. A lead marked do_not_contact sent "What is your rate
 * for kasab zari 100 kg?". The engine correctly refused to call the model —
 * "Lead is marked do not contact" — and fell through to
 * `buildFallbackSuggestedReply`, which drafted:
 *
 *   "Here's what I can tell you right away: Q: What industry or category does
 *    the company belong to?. For the exact details, let me confirm with our
 *    team and get back to you."
 *
 * The fallback took `contextText.split("\n")[0]` and stated it as fact.
 * Retrieved chunks are written as `Q: <question>\nA: <answer>` by
 * DocumentExtractionMappingService and DocumentQuestionAnsweringService, so the
 * first line of a chunk is STRUCTURALLY always the question. For the most
 * common knowledge source in the product this path could not ever quote an
 * answer — it could only ever read the question back to the customer, on a
 * completely unrelated topic, in the company's voice.
 *
 * Worse, `getRelevantContext` prefixes unverified chunks with the sentence
 * "[UNVERIFIED EXTRACTION — do not quote as fact to the customer]", and this
 * code quoted that chunk, marker and all, to the customer.
 *
 * This path only runs when the model returned nothing, which is exactly when
 * no other component is in a position to catch a bad sentence.
 *
 *   CASE A — a Q/A chunk yields the ANSWER, never the question.
 *
 *   CASE B — an unverified chunk yields nothing at all. The marker says "do
 *     not quote as fact to the customer" and this is a customer-facing string.
 *
 *   CASE C — when nothing quotable can be found the operator's safe sentence
 *     is used. Silence is not an option (a reply is being drafted either way),
 *     so the fallback must degrade to "let me confirm with our team".
 *
 *   CASE D — a chunk whose content is itself a question is never stated as an
 *     answer, even when it carries no `Q:` framing.
 *
 *   CASE E — the marker is not re-typed in two places. The producer and the
 *     consumer must agree on it by construction, or this defect returns the
 *     first time somebody edits the wording.
 *
 * Substrate: static read of the two services, plus the extractor's own
 * behaviour exercised directly. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { UNVERIFIED_CHUNK_MARKER } from "@/services/KnowledgeBaseService";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ENGINE = "src/services/WhatsAppConversationEngine.ts";
const KNOWLEDGE = "src/services/KnowledgeBaseService.ts";
const SAFE_REPLY = "Great question — let me confirm the exact details with our team and get right back to you.";

/**
 * The engine's helper is module-private, which is correct — it is an
 * implementation detail of one fallback. Rather than exporting it purely for a
 * test, this loads the function's own source and evaluates it, so the cases
 * exercise the real code and a rewrite that reintroduces the defect fails here.
 */
function loadQuotableAnswerLine(): (contextText: string) => string | undefined {
  const engine = readSource(ENGINE);
  const start = engine.indexOf("function quotableAnswerLine(");
  assert(start > 0, `setup: ${ENGINE} no longer defines quotableAnswerLine`);
  const end = engine.indexOf("\n}", start);
  assert(end > start, `setup: could not find the end of quotableAnswerLine in ${ENGINE}`);
  const body = engine.slice(start, end + 2).replace(/: string \| undefined/g, "").replace(/: string/g, "");
  // eslint-disable-next-line no-new-func
  return new Function("UNVERIFIED_CHUNK_MARKER", `${body}; return quotableAnswerLine;`)(UNVERIFIED_CHUNK_MARKER);
}

function main() {
  console.log("=== GOLDEN: the fallback never reads a stored question out to a customer ===\n");

  const quotableAnswerLine = loadQuotableAnswerLine();
  const engine = readSource(ENGINE);

  // ---------------------------------------------------------------- CASE A
  {
    const chunk = "Q: What is the minimum order quantity?\nA: The minimum order is 50 Kg per article.";
    const picked = quotableAnswerLine(chunk);
    assert(
      picked === "The minimum order is 50 Kg per article",
      `CASE A: expected the answer half, got ${JSON.stringify(picked)}`,
    );
    // The live defect, exactly as it was seen.
    const live = "Q: What industry or category does the company belong to?\nA: Zari and embroidery thread manufacturing.";
    assert(
      quotableAnswerLine(live) === "Zari and embroidery thread manufacturing",
      "CASE A: the question must never be what reaches the customer",
    );
    // Trailing Status:/Source: lines are part of the stored chunk shape.
    const withMeta = "Q: What are the payment terms?\nA: 100% advance on the first order.\nStatus: approved\nSource: document";
    assert(
      quotableAnswerLine(withMeta) === "100% advance on the first order",
      "CASE A: bookkeeping lines must not displace the answer",
    );
    console.log("✅ CASE A — a Q/A chunk yields the answer, never the question");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const unverified = `${UNVERIFIED_CHUNK_MARKER} Q: What is the rate?\nA: Rs 380 per kg.`;
    assert(
      quotableAnswerLine(unverified) === undefined,
      "CASE B: a chunk marked 'do not quote as fact to the customer' must not be quoted to the customer",
    );
    console.log("✅ CASE B — an unverified chunk is never repeated, marker or answer");
  }

  // ---------------------------------------------------------------- CASE C
  {
    assert(quotableAnswerLine("") === undefined, "CASE C: empty context must yield nothing");
    assert(quotableAnswerLine("   \n\n  ") === undefined, "CASE C: whitespace-only context must yield nothing");
    assert(
      engine.includes(SAFE_REPLY),
      `CASE C: ${ENGINE} must still fall back to a sentence that promises nothing`,
    );
    console.log("✅ CASE C — with nothing quotable, the customer gets the safe sentence");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      quotableAnswerLine("Which shade did you need for this order?") === undefined,
      "CASE D: a bare question must not be stated to the customer as information",
    );
    assert(
      quotableAnswerLine("Q: Do you export?") === undefined,
      "CASE D: a Q-framed chunk with no answer has nothing quotable in it",
    );
    // Prose with no Q/A framing is still usable — this is the case the
    // fallback exists for, and losing it would leave every reply generic.
    assert(
      quotableAnswerLine("We manufacture Kasab zari at our own unit in Fulpada, Surat.")
        === "We manufacture Kasab zari at our own unit in Fulpada, Surat",
      "CASE D: an ordinary prose chunk must still be usable",
    );
    console.log("✅ CASE D — questions are never stated as answers, prose still is");
  }

  // ---------------------------------------------------------------- CASE E
  {
    const knowledge = readSource(KNOWLEDGE);
    assert(
      /export const UNVERIFIED_CHUNK_MARKER/.test(knowledge),
      `CASE E: ${KNOWLEDGE} must export the marker so consumers can recognise one`,
    );
    assert(
      /UNVERIFIED_CHUNK_MARKER/.test(engine),
      `CASE E: ${ENGINE} must detect the marker by the shared constant, not by re-typing the sentence`,
    );
    const reTyped = (engine.match(/UNVERIFIED EXTRACTION/g) || []).filter(Boolean);
    assert(
      reTyped.length === 0,
      `CASE E: ${ENGINE} re-types the marker text; a reworded marker would silently stop matching`,
    );
    console.log("✅ CASE E — producer and consumer share one constant");
  }

  console.log("\n=== GOLDEN PASSED (A-E) ===");
}

main();
