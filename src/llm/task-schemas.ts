import { z } from "zod";

export const LeadScoreOutputSchema = z.object({
  fitScore: z.number().min(0).max(5),
  needScore: z.number().min(0).max(5),
  reachabilityScore: z.number().min(0).max(5),
  timingScore: z.number().min(0).max(5),
  totalScore: z.number().min(0).max(20),
  qualificationStatus: z.string(),
  reason: z.string(),
});

export const ReplyClassificationOutputSchema = z.object({
  classification: z.string(),
  confidenceScore: z.number().min(0).max(1),
  leadStatus: z.string(),
  summary: z.string(),
  suggestedNextAction: z.string(),
  suggestedResponse: z.string(),
});

export const BusinessExtractionOutputSchema = z.object({
  companyName: z.string().optional(),
  industry: z.string().optional(),
  products: z.array(z.string()).default([]),
  services: z.array(z.string()).default([]),
  contacts: z.record(z.string(), z.unknown()).default({}),
  missingFields: z.array(z.string()).default([]),
});

export const ICPGenerationOutputSchema = z.object({ icps: z.array(z.record(z.string(), z.unknown())) });
export const CampaignPlanOutputSchema = z.record(z.string(), z.unknown());
export const MessageGenerationOutputSchema = z.record(z.string(), z.unknown());
export const CampaignLearningOutputSchema = z.record(z.string(), z.unknown());

export function parseOrFallback<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
