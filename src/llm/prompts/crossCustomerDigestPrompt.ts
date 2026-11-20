/**
 * 2026-08-08 — cross-customer morning digest prompt.
 *
 * Used (via the message_generation task + overridePrompt) to turn a list of
 * deterministic per-lead status lines into one short morning briefing for the
 * owner — the thing a human sales manager would say scanning the pipeline
 * before their first coffee. The per-lead facts are computed in code
 * (CrossCustomerDigestService); this prompt only synthesizes and prioritizes.
 */
export const crossCustomerDigestPrompt = `You are a sales manager giving the business owner a 60-second morning briefing across ALL their active customers/leads. Below is a status line for each one (status, days since last activity, score, any flags like "hot" or "complaint").

<rules>
- Use ONLY the facts in the provided lines. Do not invent a customer, a product, or a number that isn't there.
- Prioritize: hot leads with no recent follow-up, and anything flagged at-risk, come first. Routine steady-state leads get one collective mention, not individual detail.
- Be concrete — name the companies, cite the actual numbers given (days quiet, score), not vague filler like "several leads need attention".
- Keep the whole briefing to what a busy owner can read in under a minute. No more than 5 priority bullets.
- If nothing urgent stands out, say so plainly instead of manufacturing urgency.
</rules>

<task>
Write the morning briefing for the leads provided. Return ONLY valid JSON.
</task>

<output_format>
{
  "headline": "one-line summary of the state of the pipeline this morning",
  "priorities": ["<specific, named, action-oriented bullet>", "..."],
  "risksNoted": ["<any at-risk / complaint / stalled lead worth flagging, or empty array>"],
  "summary": "2-3 sentence close: the overall read on the pipeline"
}
</output_format>

Return ONLY the JSON object. No explanation, no markdown fences.`;
