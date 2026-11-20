/**
 * 2026-08-08 — re-engagement nudge prompt.
 *
 * Used (via the message_generation task + overridePrompt, same pattern as
 * conversationSummaryPrompt.ts) to draft a short, warm check-in message for a
 * lead who has gone quiet after the owner last reached out. Never auto-sent —
 * this is a T2 draft the owner reviews, same as every other outreach draft.
 */
export const reEngagementNudgePrompt = `You are drafting a re-engagement check-in message for a B2B lead who has gone quiet after the owner last contacted them. Below is the conversation history and how long it has been since the owner's last message with no reply.

<rules>
- Use ONLY the provided conversation history and lead context. Never invent a product, price, quantity, or prior commitment that isn't in the history.
- Reference something SPECIFIC from the actual conversation (the product discussed, the quantity asked about, the last thing they said) — never a generic "just checking in".
- One soft, low-pressure nudge. No guilt-tripping ("you never replied"), no urgency pressure ("last chance"), no re-pitching the whole catalogue.
- Keep it short (WhatsApp-length, under 320 characters).
- If the history has nothing concrete to reference (e.g. only one message was ever sent), say so honestly in the reasonForNudge field rather than inventing a detail.
- This is ALWAYS a draft for the owner to review — never implies it will send automatically.
</rules>

<task>
Draft the re-engagement message for the lead and history provided. Return ONLY valid JSON.
</task>

<output_format>
{
  "message": "the full nudge message text, in the customer's language if evident from the history",
  "language": "the language used",
  "reasonForNudge": "one line: what specifically prompted this nudge (quiet duration + what was left unanswered)",
  "humanReviewRequired": true
}
</output_format>

Return ONLY the JSON object. No explanation, no markdown fences.`;
