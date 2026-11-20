/**
 * subordinates.ts — the agents the master can give work to (N8, 2026-09-23).
 *
 * ── WHY A FIXED ROSTER ──────────────────────────────────────────────────────
 * The master PLANS: it reads the owner's request and writes out who does what.
 * It may only name agents on this list. The list lives in code, not in the
 * prompt, so a plan naming anything else is refused before anything runs — a
 * model that invents "send-all-agent", or is talked into it by a document it
 * read, gets a refusal, not a new capability.
 *
 * Each subordinate's TOOLS come from `tool-registry` (AGENT_TOOLS), not from
 * here, so there is one place that says what any agent can touch.
 *
 * ── WHAT IS DELIBERATELY NOT ON IT ──────────────────────────────────────────
 * Nothing that sends, saves or spends outside a model call. The outreach drafter
 * writes drafts and returns them as text; a person sends. When a subordinate
 * that can act is added, its tool carries `requiresApproval` and the loop stops
 * in front of it — the orchestrator reports it as "waiting for you", never as
 * done.
 */

export type Subordinate = {
  /** The name the master uses in a plan, and the key into AGENT_TOOLS. */
  name: string;
  /** What the owner sees on the Command Center: a job title, not an id. */
  label: string;
  /** One plain sentence for the owner about what this helper does. */
  summary: string;
  /** Shown to the master when it plans. Written for a model choosing who to ask. */
  role: string;
  /** The subordinate's own standing orders, given before the master's task. */
  instructions: string;
  /** Its loop's step ceiling. Kept low: these are narrow jobs. */
  maxSteps: number;
  /** Extra billed calls a single step can cause (a batch tool), for the cost estimate. */
  extraCallsPerRun?: number;
  /** Paid web searches one run can make at most, shown to the owner before they approve. */
  webSearchesPerRun?: number;
};

export const SUBORDINATES: Subordinate[] = [
  {
    name: "crm-researcher",
    label: "Lead researcher",
    summary: "Looks through your lead list and checks what has already happened with each lead.",
    role:
      "Finds leads in this company's own lead list and checks what has already happened with them (contacted or not, " +
      "orders, quotes). Cannot search the internet.",
    instructions:
      "You look things up in this company's lead list. Use find_leads and get_lead_history. Report what you found " +
      "plainly and ALWAYS include each lead's id, because the next helper needs it. If fewer leads match than were " +
      "asked for, say how many actually matched — never pad the list.",
    maxSteps: 4,
  },
  {
    name: "lead-scoring-agent",
    label: "Lead scorer",
    summary: "Judges how promising particular leads are, and says why.",
    role: "Judges how promising particular leads are and why. Give it lead ids.",
    instructions:
      "You judge how promising leads are. Look up what you need. For each lead give one line: how warm, and the " +
      "reason. Never invent order history.",
    maxSteps: 4,
  },
  {
    name: "knowledge-base-agent",
    label: "Product expert",
    summary: "Answers from your own knowledge base: products, prices, policies and terms.",
    role: "Answers questions about this company's own products, prices, policies and terms from its knowledge base.",
    instructions:
      "You answer from this company's knowledge base. If it is not there, say so plainly rather than guessing.",
    maxSteps: 3,
  },
  {
    name: "outreach-drafter",
    label: "Message writer",
    summary: "Writes first WhatsApp messages as drafts for you to check. Never sends.",
    role:
      "Writes first WhatsApp messages for specific leads, as drafts for the owner to review. Never sends or saves " +
      "anything. Needs lead ids.",
    instructions:
      "You write first messages for the leads you are given, using draft_outreach_messages. Check the knowledge base " +
      "if the message needs a product fact. Never promise a price, delivery date or credit term that the knowledge " +
      "base does not state. Report every draft with its lead, and say plainly which leads you skipped and why.",
    maxSteps: 3,
    extraCallsPerRun: 10,
  },
  // ── 2026-09-25: four more helpers (CEO: "yes add those four") ─────────────
  {
    name: "quality-review-agent",
    label: "Quality checker",
    summary: "Checks the team's drafts and answers for guesses, promises we can't back up, and a wrong tone. Changes nothing.",
    role:
      "Checks drafts and answers written by the other helpers BEFORE the owner sees them: is every fact backed by the " +
      "knowledge base, is anything promised that the company has not stated, is the tone right. Needs the text to check, " +
      "so it always goes after the helper that wrote it. Changes and sends nothing.",
    instructions:
      "You check text other helpers wrote. For EACH draft or answer you are given, say OK or NEEDS A FIX, and why. " +
      "Use search_knowledge_base to check facts. Flag: any price, discount, minimum order, delivery date, payment or " +
      "credit term, stock, warranty, return, export or certification claim that the knowledge base does not state; " +
      "anything guessed; a pushy or unsafe tone; private information; a message to someone marked do-not-contact. " +
      "When a draft is close, suggest the safer wording. Never approve on the owner's behalf — you advise, a person " +
      "decides. If you were given nothing to check, say so plainly.",
    maxSteps: 4,
  },
  {
    name: "campaign-learning-agent",
    label: "Campaign analyst",
    summary: "Looks at how your campaigns went — replies, approvals, wins — and says what worked and what didn't.",
    role:
      "Reads how this company's campaigns actually went (leads, approvals, messages, replies and their kinds, deals " +
      "won) and says what worked and what did not. Reads only; changes nothing.",
    instructions:
      "You explain how campaigns went, using get_campaign_results. Base every point on the numbers it returns and " +
      "quote them. Say what worked, what did not, and one or two things to try next. If there is too little data to " +
      "tell (for example no replies yet), say that instead of drawing a conclusion. Never invent results.",
    maxSteps: 3,
  },
  {
    name: "lead-review-agent",
    label: "Lead reviewer",
    summary: "Recommends which leads to approve or reject, and why. Advice only — it never approves or rejects anything.",
    role:
      "Recommends approve or reject for leads (usually those waiting for review), judged against the owner's own " +
      "description of who they sell to and who they do not. ADVICE ONLY: it cannot approve or reject anything.",
    instructions:
      "You recommend, you do not decide. Use get_ideal_customers first, then find_leads (status needs_review unless " +
      "told otherwise) and get_lead_profile for each lead you judge. For each lead: RECOMMEND APPROVE, RECOMMEND " +
      "REJECT or UNSURE, with the reason in one line, and name any 'not for' rule it matches. Include each lead's id. " +
      "Never invent facts about a lead; if the profile is too thin to judge, say UNSURE and what is missing.",
    maxSteps: 6,
  },
  {
    name: "product-application-research-agent",
    label: "Market researcher",
    summary: "Searches the web for who buys your products and where. Uses a few paid web searches — shown before you approve.",
    role:
      "Researches the market on the web: who buys a product, where, and what they look for. Each run makes a few PAID " +
      "web searches. Use it only when the job needs outside information the company's own data cannot give.",
    instructions:
      "You research the market with research_market. Use it once with a clear, specific topic; use it a second time " +
      "only if the first search found nothing useful. Report only what the results say, with their links. Never add " +
      "company names, figures or claims that are not in the results, and say plainly when the search found nothing.",
    maxSteps: 3,
    // Each research_market use makes one planning call of its own.
    extraCallsPerRun: 2,
    // At most two uses (a third step can only answer), MARKET_RESEARCH_QUERIES searches each.
    webSearchesPerRun: 6,
  },
];

const BY_NAME = new Map(SUBORDINATES.map((agent) => [agent.name, agent]));

export function getSubordinate(name: string): Subordinate | undefined {
  return BY_NAME.get(name);
}
