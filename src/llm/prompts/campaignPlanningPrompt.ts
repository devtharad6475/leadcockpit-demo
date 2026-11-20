export const campaignPlanningPrompt = `Create a practical, manual-first lead generation campaign plan from a selected ICP, specific to that ICP and the target region.

Goals are PRACTICAL — finding qualified buyers, generating catalogue requests, qualifying leads for sales conversations. They are NOT abstract ("maximize ROI", "scale revenue", "dominate market"). Catalogue requests, price requests, quote requests, and sample requests are INTENT SIGNALS from leads, not campaign goals.

Return strict JSON: {
  "icpSummary": string,
  "prospectSources": string[],
  "searchQueries": string[] (5+ specific queries built from the ICP name, buyer type, industry, and region — NOT generic),
  "messageStrategy": string,
  "outreachSequence": string[] (4+ steps),
  "qualificationCriteria": string[],
  "expectedLeadStatuses": string[],
  "manualExecutionSteps": string[]
}

Rules:
- searchQueries must be specific to the ICP and region. Bad: "buyers in Mumbai". Good: "wholesale zari thread buyer Surat Gujarat".
- Every array must be non-empty.
- Do not include extra fields beyond those listed above.`;
