/**
 * page-intros.ts — the heading and the one-sentence explanation for every screen.
 *
 * WHY THIS EXISTS (2026-09-03, N-UX-10)
 * ------------------------------------
 * The operator's complaint, in their words: "every page should behave just with
 * a glance. I should know what to do here." Walking the product with that in
 * mind, the same four faults appeared on nearly every screen:
 *
 *   1. The heading named a FEATURE, not a JOB. "Questions from AI" tells you
 *      which menu item you clicked; it does not tell you what you are supposed
 *      to do now. The nav already told you which item you clicked.
 *   2. There was no one-line explanation, or it was buried inside a card below
 *      the fold, or it was three paragraphs nobody reads.
 *   3. The page title was often printed TWICE — once as the page heading and
 *      again as the first card's title. Confirmed on Questions from AI, where
 *      the h1 and the h2 were the same seven characters.
 *   4. Everything was equally spaced, so nothing was more important than
 *      anything else.
 *
 * Faults 1 and 2 are fixed HERE, once, for all 26 screens, because the shell
 * already renders the heading centrally — so a table is all it takes, and no
 * screen can drift out of the pattern later. Faults 3 and 4 are per-screen work
 * and are done in the screens themselves.
 *
 * THE RULES THESE ENTRIES FOLLOW (approved by the operator, 2026-09-03)
 * ---------------------------------------------------------------------
 *   - `heading` states the JOB in the operator's own language. It is not the
 *     nav label; the nav label stays short for the sidebar, and lives in the
 *     `tabs` table in page.tsx.
 *   - `blurb` is ONE sentence, placed UNDER the heading and set quieter, so a
 *     reader takes in what the page is for first and reads the detail only if
 *     they want it. It must be TRUE of what the screen actually does — every
 *     sentence below was written after reading that screen's code, not from
 *     the screen's name. Where a screen has a safety property the operator
 *     needs to know (nothing sends without approval; sending is manual), the
 *     sentence says so, because that is the fact that changes what they do.
 *   - No numbers. Counts belong in the screen, where they can be checked
 *     against the list underneath them.
 */

export type PageIntro = {
  /** The job, in the operator's language. Rendered as the page's h1. */
  heading: string;
  /** One true sentence, rendered under the heading in muted text. */
  blurb: string;
};

/**
 * Keyed by TabId. `page.tsx` owns TabId, so this module deliberately types the
 * key as a plain string and page.tsx asserts the coverage — that keeps the
 * import one-directional (page.tsx → here) with no cycle, while still failing
 * loudly if a tab is ever added without an intro.
 */
export const PAGE_INTROS: Readonly<Record<string, PageIntro>> = {
  needsYou: {
    heading: "Needs you",
    blurb: "Everything the AI could not finish on its own, gathered into one queue.",
  },
  commandCenter: {
    heading: "Your AI assistant",
    blurb: "Talk to it like a colleague — ask, give it work or set up your business together, and nothing reaches a customer without you.",
  },
  dashboard: {
    heading: "How the business is doing",
    blurb: "Today's work, where every lead stands, and what has changed since you last looked.",
  },
  onboarding: {
    heading: "Set up your business",
    blurb: "Tell the AI who you are and what you sell, so it can answer customers without asking you first.",
  },
  profile: {
    heading: "Your business profile",
    blurb: "The plain facts about your company — what the AI repeats when a customer asks who you are.",
  },
  knowledge: {
    heading: "What the AI knows",
    blurb: "Every document and saved answer the AI draws on — correct anything wrong here and it stops repeating it.",
  },
  icp: {
    heading: "Who you want to sell to",
    blurb: "Describe one focused type of buyer, and the AI uses it to find and rank new companies for you.",
  },
  campaign: {
    heading: "Plan an outreach campaign",
    blurb: "Choose who to reach, on which channel, and what the message should say.",
  },
  discovery: {
    heading: "Find new companies",
    blurb: "Search for businesses matching your ideal customer, or import a list you already have.",
  },
  review: {
    heading: "Approve or reject new leads",
    blurb: "The AI found these companies, and none of them is contacted until you approve it.",
  },
  crm: {
    heading: "Your leads",
    blurb: "Every company you are working with, and exactly where each one has reached.",
  },
  messages: {
    heading: "Outreach messages",
    blurb: "The AI writes the message; you review it and send it yourself, and only then is it marked as sent.",
  },
  replies: {
    heading: "What customers said back",
    blurb: "Incoming replies, and the answers the AI gave on your behalf.",
  },
  tickets: {
    heading: "Support tickets",
    blurb: "Problems raised by customers, who is handling each one, and how long it has been waiting.",
  },
  commercial: {
    heading: "Quotes and orders",
    blurb: "The prices you have quoted, and the orders those quotes turned into.",
  },
  catalogue: {
    heading: "What you sell",
    blurb: "Your products, variants and prices — the details the AI needs before it can quote anyone.",
  },
  workspace: {
    heading: "Your company settings",
    blurb: "The emergency stop, messages to your own WhatsApp, working hours and holidays, and your team.",
  },
  activity: {
    heading: "Who did what",
    blurb: "Everything people, the AI and the daily routine did in your company, newest first, in India time.",
  },
  compliance: {
    heading: "Consent and erasure",
    blurb: "Who has agreed to be contacted, and a permanent record of every deletion request you have honoured.",
  },
  analytics: {
    heading: "How your campaigns performed",
    blurb: "See each campaign's results, the records behind them and practical next steps.",
  },
  whatsapp: {
    heading: "Your WhatsApp agent",
    blurb: "What the AI is allowed to answer on its own, and what it must always bring to you first.",
  },
  unknown: {
    heading: "Answer what the AI couldn't",
    blurb: "When the AI does not know something it stops and asks you here, then saves your answer so it never has to ask twice.",
  },
  reviewQueue: {
    heading: "Drafts waiting for your approval",
    blurb: "Replies the AI has written — approving one sends it straight to the customer.",
  },
  ai: {
    heading: "AI settings",
    blurb: "Which model does which job, and how much it is allowed to spend.",
  },
  agentInstructions: {
    heading: "Guide your agents",
    blurb: "Add optional preferences for each agent while their standard behaviour and safety rules stay in place.",
  },
  integrations: {
    heading: "Connected services",
    blurb: "WhatsApp, email and anything else this workspace is allowed to talk to.",
  },
  settings: {
    heading: "Settings",
    blurb: "The rules the AI follows when it talks to buyers: minimum order, payment, policies and tone.",
  },
  exportBackup: {
    heading: "Export a backup",
    blurb: "Download the supported company records; complete recovery also needs the database backup and uploaded files.",
  },
  help: {
    heading: "Help and support",
    blurb: "How the system works, and how to reach a person when something is wrong.",
  },
};
