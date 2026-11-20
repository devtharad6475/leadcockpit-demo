/**
 * 2026-08-08 — at-risk customer assessment prompt.
 *
 * Used (via the message_generation task + overridePrompt) to reason about a
 * SPECIFIC candidate the deterministic pre-filter already found (a complaint
 * or negative-classification reply with no owner follow-up since). The model
 * explains the risk and recommends ONE concrete action — it does not decide
 * WHICH leads are candidates (that stays a deterministic, auditable rule in
 * AtRiskDetectionService, same division of labor as reply_classification's
 * sensitive-topic gate: code decides what's sensitive, the model explains).
 */
export const atRiskAssessmentPrompt = `You are assessing customer-relationship risk for a B2B lead who had a complaint or negative signal and has NOT been followed up with since. Below is the complaint/negative message, how long it has been unanswered, and the lead's conversation history.

<rules>
- Use ONLY the provided complaint text, silence duration, and history. Never invent what the customer is upset about beyond what they actually wrote.
- riskLevel reflects severity + silence: a serious complaint (product defect, broken promise) left unanswered for days is "high"; a mild gripe answered same-day would not have reached you at all (the pre-filter only sends unanswered ones), so weigh actual wording + elapsed time honestly — do not default to "high" for everything.
- recommendedAction must be ONE concrete, specific next step the owner can take today (e.g. "Call to apologize for the delayed delivery and offer X", not "improve communication").
- Never suggest a discount, refund amount, or compensation figure — that is a commercial decision for the owner, not the model. Flag that a commercial call is needed instead.
- This is a READ-ONLY assessment. It does not contact the customer.
</rules>

<task>
Assess the risk for the lead provided. Return ONLY valid JSON.
</task>

<output_format>
{
  "riskLevel": "low | medium | high",
  "reason": "concrete, evidence-cited explanation grounded in the actual complaint text and elapsed time",
  "recommendedAction": "one concrete next step for the owner",
  "confidenceScore": <0.0 to 1.0>
}
</output_format>

Return ONLY the JSON object. No explanation, no markdown fences.`;
