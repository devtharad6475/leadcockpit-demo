export const icpGenerationPrompt = `Generate 3 to 5 ideal customer profiles (ICPs) tailored to the specific approved business profile provided in the input. The count varies with business diversity: a single-product business gets 3; a multi-product or cross-industry business gets up to 5.

Each ICP must reflect THIS business — not generic buyer personas. Use the provided products, industry, target geographies, strengths, and desired customer types to derive specific ICPs. Do not invent capabilities the business does not have.

Return strict JSON: { "icps": [{ "name", "buyerType", "description", "industries" (array), "geography" (array), "likelyNeeds" (array), "buyingTriggers" (array), "painPoints" (array), "preferredChannels" (array), "messagingAngles" (array), "qualificationRules" (array), "confidenceScore" (number in [0, 1], max 0.9), "companySizeBucket" (one of: "solo/small business", "small company", "medium company", "large company", "unknown") }] }

Rules:
- Every array field must be non-empty.
- confidenceScore is YOUR honest confidence that this ICP fits the business, capped at 0.9 (no ICP is ever "100% certain").
- Industries and geography should reflect the actual business, not generic placeholders.
- Never include "risks" or other extra fields; the consumer only reads the fields listed above.`;
