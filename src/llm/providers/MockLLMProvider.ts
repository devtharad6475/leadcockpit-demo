import type { LLMProvider } from "./LLMProvider";

export class MockLLMProvider implements LLMProvider {
  name = "mock";

  async runJsonTask<T>({ taskName, input, prompt }: Parameters<LLMProvider["runJsonTask"]>[0]) {
    if (taskName === "document_extraction_mapping") {
      const output = mockDocumentExtraction(input, prompt);
      return { output: output as T, rawText: JSON.stringify(output) };
    }
    if (taskName === "manual_answer_mapping") {
      const output = mockManualAnswerMapping(input);
      return { output: output as T, rawText: JSON.stringify(output) };
    }
    const output = { taskName, input, mock: true };
    return { output: output as T, rawText: JSON.stringify(output) };
  }
}

type MockQuestion = {
  domainKey: string;
  domainTitle?: string;
  questions: Array<{
    questionKey: string;
    question: string;
    humanReviewRequired?: boolean;
  }>;
};

function mockDocumentExtraction(input: unknown, prompt = "") {
  const record = asRecord(input);
  const documentText = String(record.documentText || record.textPreview || "");
  const framework = parseQuestionFramework(prompt);
  const requestedDomains = Array.isArray(record.domainKeys) ? record.domainKeys.map(String) : [];
  const selectedFramework = requestedDomains.length
    ? framework.filter((domain) => requestedDomains.includes(domain.domainKey))
    : framework;
  const evidence = bestEvidence(documentText);
  const answers = selectedFramework.flatMap((domain) => {
    let answeredInDomain = 0;
    const maxAnswers = maxPreviewAnswersForDomain(domain.domainKey);
    const relevantDomain = isDomainRelevant(documentText, domain.domainKey);
    return domain.questions.map((question) => {
      const snippet = relevantDomain && answeredInDomain < maxAnswers
        ? findRelevantSnippet(documentText, domain.domainKey, question.question)
        : "";
      const canAnswer = Boolean(snippet);
      if (canAnswer) answeredInDomain += 1;
      return {
        domainKey: domain.domainKey,
        questionKey: question.questionKey,
        question: question.question,
        answer: canAnswer ? conciseAnswer(snippet) : "",
        answerStatus: canAnswer ? (question.humanReviewRequired ? "needs_review" : "answered") : "unanswered",
        confidenceScore: canAnswer ? 0.62 : 0,
        sourceSnippet: canAnswer ? snippet.slice(0, 420) : undefined,
        conflictWithExisting: false,
        conflictReason: "",
      };
    });
  });
  return {
    answers,
    answeredQuestionIds: answers
      .filter((answer) => answer.answerStatus !== "unanswered")
      .map((answer) => `${answer.domainKey}/${answer.questionKey}`),
    products: detectList(documentText, /\b(?:products?|catalogue|catalog|we supply|we manufacture|we sell)\b[:\-\s]+([^\n.]+)/i).map((name) => ({
      productName: name,
      description: `Review this product detail from demo/mock extraction: ${name}`,
    })),
    faqs: detectFaqs(documentText),
    policies: detectPolicies(documentText),
    leadQualificationRules: detectList(documentText, /\b(?:lead rule|qualification|buyer should|priority)\b[:\-\s]+([^\n.]+)/i),
    companyKnowledge: evidence ? [{ question: "What does this source say about the company?", answer: conciseAnswer(evidence) }] : [],
    customerKnowledge: [],
    additionalMissingQuestions: [],
    mock: true,
  };
}

function maxPreviewAnswersForDomain(domainKey: string) {
  if (/(company|factual_company_profile|product|shipping|payment|pricing|returns|faqs|lead_qualification)/.test(domainKey)) return 1;
  return 1;
}

function isDomainRelevant(text: string, domainKey: string) {
  const lower = text.toLowerCase();
  if (/(company|factual_company_profile)/.test(domainKey)) return /\b(company|business|brand|manufacturer|supplier|trader|distributor|located|founded|established)\b/.test(lower);
  if (/product/.test(domainKey)) return /\b(product|products|catalogue|catalog|sku|manufacture|supply|sell|material|moq|custom)\b/.test(lower);
  if (/shipping/.test(domainKey)) return /\b(shipping|delivery|dispatch|logistics|transport)\b/.test(lower);
  if (/(payment|pricing)/.test(domainKey)) return /\b(payment|advance|credit|gst|price|pricing|quotation|invoice)\b/.test(lower);
  if (/returns/.test(domainKey)) return /\b(return|refund|replacement|claim)\b/.test(lower);
  if (/faqs/.test(domainKey)) return /\bq[:\-\s].+\n+a[:\-\s]/i.test(text);
  if (/lead_qualification/.test(domainKey)) return /\b(lead|buyer|customer|bulk|sample|catalogue|qualification)\b/.test(lower);
  return false;
}

function mockManualAnswerMapping(input: unknown) {
  const record = asRecord(input);
  const answerText = String(record.answerText || "");
  const questionnaire = String(record.questionnaire || "");
  const ids = Array.from(questionnaire.matchAll(/\[([^\]]+)\]\s*([^\n]+)/g))
    .map((match) => ({ questionId: match[1], question: match[2] }))
    .filter((item) => isLikelyRelated(answerText, item.question))
    .slice(0, 6);
  return {
    mappings: ids.map((item) => ({ questionId: item.questionId, answer: answerText })),
    mock: true,
  };
}

function parseQuestionFramework(prompt: string): MockQuestion[] {
  const marker = "Question framework:";
  const documentMarker = "\nDocument text:";
  const start = prompt.indexOf(marker);
  if (start < 0) return [];
  const jsonStart = start + marker.length;
  const end = prompt.indexOf(documentMarker, jsonStart);
  const json = prompt.slice(jsonStart, end > jsonStart ? end : undefined).trim();
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as MockQuestion[] : [];
  } catch {
    return [];
  }
}

function bestEvidence(text: string) {
  return splitEvidence(text).find((item) => item.length > 24) || "";
}

function findRelevantSnippet(text: string, domainKey: string, question: string) {
  const domainTerms = domainKey.replaceAll("_", " ");
  const terms = keywordSet(`${domainTerms} ${question}`);
  return splitEvidence(text).find((snippet) => {
    const normalized = snippet.toLowerCase();
    return terms.filter((term) => normalized.includes(term)).length >= 2;
  }) || "";
}

function splitEvidence(text: string) {
  return text
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function conciseAnswer(snippet: string) {
  return snippet
    .replace(/^(source file|document control note|internal working draft)\s*[:\-].*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function keywordSet(text: string) {
  const stopwords = new Set(["what", "does", "the", "company", "should", "include", "about", "with", "from", "that", "this", "which"]);
  return Array.from(new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 3 && !stopwords.has(word)))).slice(0, 12);
}

function isLikelyRelated(answerText: string, question: string) {
  const answer = answerText.toLowerCase();
  return keywordSet(question).some((term) => answer.includes(term));
}

function detectList(text: string, pattern: RegExp) {
  const match = text.match(pattern)?.[1] || "";
  return match.split(/,|;| and /).map((item) => item.trim()).filter(Boolean).slice(0, 5);
}

function detectFaqs(text: string) {
  return Array.from(text.matchAll(/q[:\-\s]+([^\n]+)\n+a[:\-\s]+([\s\S]+?)(?=\nq[:\-\s]+|$)/gi))
    .slice(0, 5)
    .map((match) => ({ question: match[1].trim(), answer: match[2].trim() }));
}

function detectPolicies(text: string) {
  const lower = text.toLowerCase();
  return [
    lower.includes("shipping") || lower.includes("delivery") ? { topic: "Shipping/delivery policy", summary: "Shipping or delivery details were detected and should be reviewed before customer-facing use." } : undefined,
    lower.includes("payment") || lower.includes("credit") ? { topic: "Payment policy", summary: "Payment or credit details were detected and should be reviewed before customer-facing use." } : undefined,
    lower.includes("return") || lower.includes("refund") ? { topic: "Return/refund policy", summary: "Return or refund details were detected and should be reviewed before customer-facing use." } : undefined,
  ].filter(Boolean);
}

function asRecord(input: unknown) {
  return typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
}
