export type KnowledgeConflict = {
  conflictType: "payment_terms" | "returns" | "delivery" | "credit" | "moq" | "export" | "other";
  statementA: string;
  statementB: string;
  suggestedQuestion: string;
  requiresResolution: boolean;
};

const patterns = [
  { type: "payment_terms" as const, a: /50%\s*advance|half\s*advance/i, b: /100%\s*advance|full\s*advance/i, question: "Which payment advance rule is correct?" },
  { type: "returns" as const, a: /returns?\s*(allowed|accepted)|replacement\s*allowed/i, b: /no\s*returns?|returns?\s*not\s*allowed/i, question: "Are returns or replacements allowed?" },
  { type: "delivery" as const, a: /3\s*days?|three\s*days?/i, b: /10\s*days?|ten\s*days?/i, question: "What delivery timeline should the AI tell customers?" },
  { type: "credit" as const, a: /credit\s*(allowed|available)/i, b: /no\s*credit|credit\s*not\s*allowed/i, question: "Is credit available for customers?" },
  { type: "moq" as const, a: /MOQ\s*(is)?\s*\d+/i, b: /no\s*MOQ|MOQ\s*not\s*required/i, question: "What is the correct minimum order quantity rule?" },
  { type: "export" as const, a: /export\s*(available|supported)/i, b: /no\s*export|export\s*not\s*available/i, question: "Does the company support export orders?" },
];

export function detectKnowledgeConflicts(texts: string[]): KnowledgeConflict[] {
  const conflicts: KnowledgeConflict[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      for (const pattern of patterns) {
        if ((pattern.a.test(texts[i]) && pattern.b.test(texts[j])) || (pattern.b.test(texts[i]) && pattern.a.test(texts[j]))) {
          conflicts.push({
            conflictType: pattern.type,
            statementA: texts[i],
            statementB: texts[j],
            suggestedQuestion: pattern.question,
            requiresResolution: true,
          });
        }
      }
    }
  }
  return conflicts;
}
