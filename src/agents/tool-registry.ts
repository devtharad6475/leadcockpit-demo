/**
 * tool-registry.ts — what tools exist, what shape each takes, and who may use
 * one (2026-09-18, session 57).
 *
 * ── WHY A REGISTRY ──────────────────────────────────────────────────────────
 * Until now the product decided every step in code: search, then ask the model
 * to write a reply. That is predictable and cheap, and it cannot answer "find
 * the manufacturers who buy zari, check which we have already contacted, and
 * draft outreach to the rest" — because how many steps that takes depends on
 * what is found. For that, the model has to choose its own next step.
 *
 * A model can only choose from what it is shown. This file is that list. Each
 * entry carries four things:
 *
 *   name         what the model says when it wants this tool
 *   description  WHEN to reach for it — the most important sentence here,
 *                because it is the only thing steering the model's judgement
 *   input        the shape of the arguments, sent to the provider as a schema
 *                so the model fills a form rather than writing syntax
 *   run          the function that already exists in the product
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * No API keys, no endpoints, no steps. The model never needs them and anything
 * put in a prompt can come back out in a reply. `run` reaches the real service,
 * which reads its own credentials exactly as it does today.
 *
 * ── PERMISSION IS A FILTER, NOT A REQUEST ───────────────────────────────────
 * `toolsForAgent` decides which tools an agent can even SEE. A tool that is not
 * in an agent's list does not exist for it. The loop checks again before
 * running anything, because a model can ask for any name at all — including one
 * suggested to it by a poisoned document. Asking is free; running is gated.
 */
import { searchKnowledge } from "@/services/KnowledgeBaseService";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type ToolContext = {
  workspaceId: string;
  repos: RepositoryBundle;
  /** How many agents deep the caller already is. Passed on to a sub-agent. */
  depth?: number;
  /** The agents already on this chain, so a tool that reaches back to one can refuse. */
  callStack?: string[];
  /** 2026-09-25 — this run's paid-search allowance, shared by all its tool calls. Absent = none. */
  webSearches?: { limit: number; used: number };
};

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON-schema-shaped, exactly as it is sent to the provider. */
  input: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  /**
   * N6 (2026-09-18, session 57) — this tool may not run until a person says so.
   *
   * Every tool in this file today only READS. That is the single reason prompt
   * injection is currently harmless: a poisoned document can talk the model into
   * asking for anything, and the honest answer is "there is no such tool". The
   * day one tool can send a message, move stock or chase a payment, that stops
   * being true, and the gap has to already be closed.
   *
   * Marking a tool here does not make it safe — it makes it PAUSE. The loop
   * stops before running it and hands the owner the exact call it wants to make.
   * Nothing about the model's reasoning can set this flag: it lives on the tool
   * definition, in code, where a document cannot reach it.
   */
  requiresApproval?: boolean;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
};

/**
 * One approval, granted by a PERSON, for one exact call.
 *
 * Scoped to the arguments and not just the tool name on purpose. "Yes, message
 * Ambica Textiles about their overdue 40,000" is not permission to message
 * everyone, and an approval that only named the tool would read as though it
 * were. See `approvalMatches`.
 */
export type ToolApproval = {
  tool: string;
  input: Record<string, unknown>;
  approvedBy: string;
  at: string;
};

/**
 * Does this approval authorise this exact call?
 *
 * Compares the arguments, not just the name. A model that asked for a different
 * amount, a different recipient or an extra field is asking for something the
 * owner did not see, and the honest answer to that is no.
 */
export function approvalMatches(approval: ToolApproval, request: { name: string; input: Record<string, unknown> }): boolean {
  if (approval.tool !== request.name) return false;
  const stable = (value: Record<string, unknown>) =>
    JSON.stringify(Object.keys(value || {}).sort().map((key) => [key, value[key]]));
  return stable(approval.input) === stable(request.input || {});
}

/** Web searches per `research_market` use. Each one is a paid search. */
export const MARKET_RESEARCH_QUERIES = 3;

const TOOLS: ToolDefinition[] = [
  {
    name: "search_knowledge_base",
    // Written as an instruction to the model, because that is what it is.
    description:
      "Search this company's approved answers and uploaded documents. Use it whenever the customer asks anything factual " +
      "about products, prices, minimum order quantities, delivery, payment or policy. Never answer those from memory — " +
      "prices and terms change, and what you remember is not this company's.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in the customer's own words." },
      },
      required: ["query"],
    },
    async run(args, { workspaceId, repos }) {
      const query = String(args.query || "").trim();
      if (!query) return { error: "query is required" };
      const result = await searchKnowledge(workspaceId, query, repos);
      return {
        confidence: Number(result.confidenceScore.toFixed(3)),
        // The caller gets the text and where it came from; a chunk id would be
        // noise to a model and an invitation to quote an identifier at a customer.
        found: result.chunks.slice(0, 5).map((chunk) => ({
          text: chunk.chunkText.slice(0, 600),
          source: chunk.documentTitle || (chunk.metadata?.sourceFileName as string) || "knowledge base",
          approved: chunk.metadata?.extractionUnverified !== true,
        })),
      };
    },
  },
  {
    name: "get_lead_history",
    description:
      "Look up what this business has bought and discussed with us before. Use it before quoting terms, offering credit " +
      "or judging how warm a lead is — an existing buyer on 30-day credit should not be treated like a stranger.",
    input: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "The id of the lead to look up." },
      },
      required: ["leadId"],
    },
    async run(args, { workspaceId, repos }) {
      const leadId = String(args.leadId || "").trim();
      if (!leadId) return { error: "leadId is required" };
      const lead = await repos.lead.getLeadById(workspaceId, leadId);
      if (!lead) return { error: `No lead with id ${leadId} in this workspace.` };
      const [orders, quotes] = await Promise.all([
        repos.order.listByLead(workspaceId, leadId),
        repos.quote.listByLead(workspaceId, leadId),
      ]);
      return {
        company: lead.companyName,
        city: lead.city,
        status: lead.status,
        orderCount: orders.length,
        quoteCount: quotes.length,
        lastOrderAt: orders[orders.length - 1]?.createdAt,
      };
    },
  },
  // ── N8 (2026-09-23): tools for the orchestrator's subordinates ────────────
  {
    name: "find_leads",
    description:
      "Search this company's OWN lead list (the CRM) — not the internet. Filter by city, by words in the company's " +
      "industry or buyer type, and by status. Each result says whether we have already contacted that lead. Use it to " +
      "answer 'which of our leads…' and 'who have we already contacted'.",
    input: {
      type: "object",
      properties: {
        city: { type: "string", description: "City to match, e.g. Surat. Optional." },
        kind: { type: "string", description: "Words to match in industry or buyer type, e.g. manufacturer. Optional." },
        status: { type: "string", description: "Lead status to match exactly, e.g. new, contacted, replied. Optional." },
        onlyNotContacted: { type: "string", description: "\"yes\" to return only leads we have never contacted. Optional." },
        limit: { type: "string", description: "How many to return, at most 50. Default 20." },
      },
      required: [],
    },
    async run(args, { workspaceId, repos }) {
      const city = String(args.city || "").trim().toLowerCase();
      const kind = String(args.kind || "").trim().toLowerCase();
      const status = String(args.status || "").trim();
      const onlyNotContacted = /^(yes|true|1)$/i.test(String(args.onlyNotContacted || ""));
      const limit = Math.min(50, Math.max(1, Number.parseInt(String(args.limit || "20"), 10) || 20));
      const leads = await repos.lead.listLeads(workspaceId, status ? { status } : {});
      const matched = leads
        // Never offered as a target: a do-not-contact lead is not a lead any
        // plan should act on, and leaving it in invites a draft to one.
        .filter((lead) => !lead.doNotContact)
        .filter((lead) => !city || (lead.city || "").toLowerCase().includes(city))
        .filter((lead) => !kind || `${lead.industry || ""} ${lead.buyerType || ""}`.toLowerCase().includes(kind))
        .map((lead) => ({
          leadId: lead.id,
          company: lead.companyName,
          city: lead.city,
          kind: [lead.buyerType, lead.industry].filter(Boolean).join(" · "),
          status: lead.status,
          // "Contacted" from what actually happened, not from a status an
          // operator may never have updated.
          contacted: Boolean(lead.lastContactedAt) || ["contacted", "replied", "interested", "won", "closed_won"].includes(String(lead.status)),
          score: lead.leadScore,
        }))
        .filter((lead) => !onlyNotContacted || !lead.contacted);
      return {
        totalMatched: matched.length,
        // Said out loud, so a plan that asked for "20" and got 7 reports 7
        // rather than assuming the rest exist.
        returned: Math.min(limit, matched.length),
        leads: matched.slice(0, limit),
      };
    },
  },
  {
    name: "draft_outreach_messages",
    description:
      "Write a first WhatsApp message for each of up to 10 leads, for a person to review. It SAVES nothing and SENDS " +
      "nothing — the drafts come back as text. Give the lead ids and what the message is for.",
    input: {
      type: "object",
      properties: {
        leadIds: { type: "string", description: "Comma-separated lead ids, at most 10." },
        purpose: { type: "string", description: "What the message is for, e.g. introduce our zari thread range." },
      },
      required: ["leadIds"],
    },
    async run(args, { workspaceId, repos }) {
      const ids = String(args.leadIds || "").split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length) return { error: "leadIds is required" };
      // Bounded: each id is one model call. A plan that asks for 200 drafts in
      // one go is asking for 200 billed calls from a single tool request.
      const batch = [...new Set(ids)].slice(0, DRAFT_BATCH_LIMIT);
      const purpose = String(args.purpose || "introduce our products").slice(0, 300);
      const { LLMService } = await import("@/llm/LLMService");
      const drafts: Array<{ leadId: string; company?: string; draft?: string; skipped?: string }> = [];
      for (let offset = 0; offset < batch.length; offset += 4) {
        const wave = batch.slice(offset, offset + 4);
        drafts.push(...(await Promise.all(wave.map(async (leadId) => {
          const lead = await repos.lead.getLeadById(workspaceId, leadId);
          if (!lead) return { leadId, skipped: "no such lead in this workspace" };
          // Checked here, not trusted to the plan: a draft addressed to someone
          // who asked never to be contacted must not be produced at all.
          if (lead.doNotContact) return { leadId, company: lead.companyName, skipped: "marked do-not-contact" };
          try {
            const result = await new LLMService(undefined, repos).runTask<{ body?: string; message?: string }>(
              "message_generation",
              { lead: { companyName: lead.companyName, contactName: lead.contactName, buyerType: lead.buyerType, city: lead.city }, ownerNote: purpose },
              { workspaceId },
            );
            const draft = String(result.output?.body || result.output?.message || "").trim();
            return draft ? { leadId, company: lead.companyName, draft } : { leadId, company: lead.companyName, skipped: "the AI returned nothing usable" };
          } catch (error) {
            return { leadId, company: lead.companyName, skipped: `could not draft: ${error instanceof Error ? error.message : String(error)}` };
          }
        }))));
      }
      return {
        drafts,
        ...(ids.length > batch.length ? { notDrafted: ids.length - batch.length, note: `Only ${DRAFT_BATCH_LIMIT} per request.` } : {}),
        sent: 0,
        saved: 0,
      };
    },
  },
  // ── 2026-09-25: tools for the four helpers added to the master's team ──────
  // All four READ, except research_market, which spends web searches — bounded
  // here and shown to the owner as a maximum before they approve the plan.
  {
    name: "get_lead_profile",
    description:
      "Read what we know about ONE lead: company, place, what kind of business, how it was found, why it was thought " +
      "to fit, its review state and score, and which ways of contacting it we have. Use it to judge whether a lead " +
      "fits. It never returns phone numbers or e-mail addresses — only whether we have them.",
    input: {
      type: "object",
      properties: { leadId: { type: "string", description: "The id of the lead to read." } },
      required: ["leadId"],
    },
    async run(args, { workspaceId, repos }) {
      const leadId = String(args.leadId || "").trim();
      if (!leadId) return { error: "leadId is required" };
      const lead = await repos.lead.getLeadById(workspaceId, leadId);
      if (!lead) return { error: `No lead with id ${leadId} in this workspace.` };
      const icp = lead.icpId ? await repos.icp.getById(workspaceId, lead.icpId) : undefined;
      return {
        leadId: lead.id,
        company: lead.companyName,
        city: lead.city,
        country: lead.country,
        website: lead.websiteUrl,
        kind: [lead.buyerType, lead.industry].filter(Boolean).join(" · "),
        size: lead.companySizeBucket,
        foundThrough: lead.source,
        whyItMightFit: String(lead.fitReason || "").slice(0, 400),
        whatWasFound: String(lead.discoveredInfo || "").slice(0, 800),
        reviewState: lead.reviewStatus,
        status: lead.status,
        score: lead.leadScore,
        targetCustomerType: icp?.name,
        doNotContact: Boolean(lead.doNotContact),
        hasPhone: Boolean(lead.phone || lead.whatsappNumber),
        hasEmail: Boolean(lead.email),
      };
    },
  },
  {
    name: "get_ideal_customers",
    description:
      "Read the owner's description of who they sell to — and who they do NOT sell to. Use it before judging whether " +
      "a lead fits. A lead matching a 'not for' phrase is a warning to report, not something to overrule.",
    input: { type: "object", properties: {}, required: [] },
    async run(_args, { workspaceId, repos }) {
      const icps = (await repos.icp.listByWorkspace(workspaceId))
        .filter((icp) => icp.status === "selected" || icp.status === "suggested")
        .sort((a, b) => Number(b.status === "selected") - Number(a.status === "selected"));
      return {
        customerTypes: icps.slice(0, 8).map((icp) => ({
          name: icp.name,
          chosenByOwner: icp.status === "selected",
          buyerType: icp.buyerType,
          industries: icp.industries,
          places: icp.geography,
          qualifies: (icp.qualificationRules || []).slice(0, 8),
          notFor: icp.exclusions || [],
        })),
      };
    },
  },
  {
    name: "get_campaign_results",
    description:
      "Read how this company's campaigns have gone, from what actually happened: leads found, approved and rejected, " +
      "messages drafted and used, replies and what kind they were, and deals won. Use it to answer 'what worked'. " +
      "Optionally name one campaign.",
    input: {
      type: "object",
      properties: { campaign: { type: "string", description: "Words from one campaign's name. Optional." } },
      required: [],
    },
    async run(args, { workspaceId, repos }) {
      const wanted = String(args.campaign || "").trim().toLowerCase();
      const [campaigns, leads, messages, replies] = await Promise.all([
        repos.campaign.listByWorkspace(workspaceId),
        repos.lead.listLeads(workspaceId),
        repos.messageTemplate.listByWorkspace(workspaceId),
        repos.reply.listByWorkspace(workspaceId),
      ]);
      const chosen = campaigns
        .filter((campaign) => !wanted || campaign.name.toLowerCase().includes(wanted))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 10);
      return {
        campaignsFound: chosen.length,
        campaigns: chosen.map((campaign) => {
          const own = leads.filter((lead) => lead.campaignId === campaign.id);
          const ownIds = new Set(own.map((lead) => lead.id));
          const ownReplies = replies.filter((reply) => reply.campaignId === campaign.id || (reply.leadId && ownIds.has(reply.leadId)));
          const kinds: Record<string, number> = {};
          for (const reply of ownReplies) {
            const kind = reply.classification || "not sorted yet";
            kinds[kind] = (kinds[kind] || 0) + 1;
          }
          const ownMessages = messages.filter((message) => message.campaignId === campaign.id);
          return {
            name: campaign.name,
            status: campaign.status,
            goal: campaign.goal,
            startedOn: String(campaign.createdAt || "").slice(0, 10),
            leads: own.length,
            approved: own.filter((lead) => lead.reviewStatus === "approved").length,
            rejected: own.filter((lead) => lead.reviewStatus === "rejected").length,
            contacted: own.filter((lead) => Boolean(lead.lastContactedAt) || ["contacted", "replied", "interested", "won", "closed_won"].includes(String(lead.status))).length,
            won: own.filter((lead) => ["won", "closed_won"].includes(String(lead.status))).length,
            messagesDrafted: ownMessages.length,
            messagesUsed: ownMessages.filter((message) => message.status === "used").length,
            replies: ownReplies.length,
            replyKinds: kinds,
          };
        }),
      };
    },
  },
  {
    name: "research_market",
    description:
      "Search the web (Google) for who buys a product, where, and what they look for. It runs at most " +
      `${MARKET_RESEARCH_QUERIES} searches per use and COSTS money per search, so use it once with a clear topic. ` +
      "Report only what the results say, with their links; never add companies or figures that are not in them.",
    input: {
      type: "object",
      properties: { topic: { type: "string", description: "What to research, e.g. buyers of zari thread for bridal wear in Gujarat." } },
      required: ["topic"],
    },
    async run(args, context) {
      const { workspaceId, repos } = context;
      const topic = String(args.topic || "").trim().slice(0, 200);
      if (!topic) return { error: "topic is required" };
      // The allowance is reserved BEFORE the await, so searches asked for in
      // the same turn cannot both see the same remaining budget.
      const ledger = context.webSearches;
      const allowed = ledger ? Math.min(MARKET_RESEARCH_QUERIES, ledger.limit - ledger.used) : 0;
      if (!ledger || allowed <= 0) {
        return { error: "No web searches are left for this job. Answer with what you already found." };
      }
      // Never given back, even when fewer searches ran: each use also costs a
      // planning call, so the allowance is what bounds the number of USES too.
      ledger.used += allowed;
      const { runMarketResearch } = await import("@/services/MarketResearchService");
      const result = await runMarketResearch(workspaceId, topic, repos, { maxQueries: allowed });
      return {
        searchesRun: result.queriesRun,
        source: result.provider === "serpapi" ? "Google search" : "no live search available",
        note: result.reason,
        findings: result.findings.slice(0, 12).map((finding) => ({ title: finding.title, snippet: finding.snippet.slice(0, 300), link: finding.url })),
      };
    },
  },
  // ── AGENTS OFFERED AS TOOLS ───────────────────────────────────────────────
  // An agent is a tool that happens to think. The caller sees a name and a
  // result and never learns that a second model ran inside — which is exactly
  // what makes this composable rather than a special case.
  //
  // Both guards live in askAgent below, not in the child: a child on its own
  // first step cannot see that it is the fourth link in a chain, or that the
  // agent calling it is the one it is about to call back.
  {
    name: "ask_lead_scorer",
    description:
      "Ask the lead-scoring specialist to judge how promising a lead is and why. Use before recommending outreach or " +
      "deciding how much effort a lead deserves. It answers with a judgement, not a number you should quote to anyone.",
    input: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "The lead to judge." },
        question: { type: "string", description: "What you want to know about this lead." },
      },
      required: ["leadId"],
    },
    run: (args, context) =>
      askAgent("lead-scoring-agent", context, {
        question: `Lead ${String(args.leadId || "")}: ${String(args.question || "How promising is this lead, and why?")}`,
        instructions:
          "You judge how promising a lead is for a zari and embroidery thread manufacturer. Look up what you need. " +
          "Answer in two or three sentences: how warm, and the reason. Never invent order history.",
      }),
  },
  {
    name: "ask_knowledge_agent",
    description:
      "Ask the knowledge specialist a question about this company's own facts — products, prices, policies, terms. " +
      "Use when you need a considered answer rather than raw search results.",
    input: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer from company knowledge." },
      },
      required: ["question"],
    },
    run: (args, context) =>
      askAgent("knowledge-base-agent", context, {
        question: String(args.question || ""),
        instructions:
          "You answer questions about this company's own facts, using the knowledge base. If it is not there, say so " +
          "plainly rather than guessing. Keep it to a few sentences.",
      }),
  },
];

/**
 * Run a sub-agent as a tool, with the two guards that only the CALLER can apply.
 *
 * Depth: a chain of agents each doing its own loop multiplies calls — three
 * agents at six steps each is eighteen model calls from one question. The cap
 * makes the ceiling knowable.
 *
 * Cycles: A asks B and B asks A is a loop that no step limit inside either one
 * can detect, because each thinks it is on its first step. Refusing to re-enter
 * an agent already on the chain ends it at the only place with the whole picture.
 *
 * Both refusals are returned as RESULTS, not thrown: the asking model can then
 * answer without the sub-agent instead of the request dying.
 */
async function askAgent(
  agentName: string,
  context: ToolContext,
  input: { question: string; instructions: string },
): Promise<unknown> {
  const depth = context.depth ?? 0;
  const callStack = context.callStack ?? [];
  const { MAX_AGENT_DEPTH, runAgentLoop } = await import("./AgentLoop");

  if (depth + 1 > MAX_AGENT_DEPTH) {
    return { error: `Cannot ask ${agentName}: already ${depth} agents deep (limit ${MAX_AGENT_DEPTH}). Answer with what you have.` };
  }
  if (callStack.includes(agentName)) {
    return { error: `Cannot ask ${agentName}: it is already waiting on this chain (${callStack.join(" → ")}). That would be a loop.` };
  }

  const result = await runAgentLoop({
    agentName,
    workspaceId: context.workspaceId,
    instructions: input.instructions,
    question: input.question,
    repos: context.repos,
    depth: depth + 1,
    callStack,
  });
  return { answer: result.answer, toolsUsed: result.steps.filter((step) => step.kind === "tool_call").length, stoppedBy: result.stoppedBy };
}

/** Drafts per `draft_outreach_messages` request — one billed call each. */
export const DRAFT_BATCH_LIMIT = 10;

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Which tools this agent may see. An agent absent from this map gets NOTHING:
 * a new agent has to be given tools deliberately, rather than inheriting every
 * tool that happens to exist by the time it is written.
 */
const AGENT_TOOLS: Record<string, string[]> = {
  "whatsapp-conversation-agent": ["search_knowledge_base", "get_lead_history"],
  "knowledge-base-agent": ["search_knowledge_base"],
  "lead-scoring-agent": ["get_lead_history", "ask_knowledge_agent"],
  "owner-copilot": ["search_knowledge_base", "get_lead_history", "ask_lead_scorer", "ask_knowledge_agent"],
  // N8 — the orchestrator's subordinates. Each gets only what its job needs;
  // the master itself gets NO tools, because it plans and merges and never acts.
  "crm-researcher": ["find_leads", "get_lead_history"],
  "outreach-drafter": ["get_lead_history", "search_knowledge_base", "draft_outreach_messages"],
  // 2026-09-25 — four more helpers. Advice and reading only; the market
  // researcher is the one that spends (web searches), bounded above.
  "quality-review-agent": ["search_knowledge_base"],
  "campaign-learning-agent": ["get_campaign_results"],
  "lead-review-agent": ["find_leads", "get_lead_profile", "get_ideal_customers"],
  "product-application-research-agent": ["research_market", "search_knowledge_base"],
};

export function toolsForAgent(agentName: string): ToolDefinition[] {
  return (AGENT_TOOLS[agentName] || []).map((name) => BY_NAME.get(name)!).filter(Boolean);
}

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/** Every tool, for the screen that shows an operator what agents can reach. */
export function allTools(): ToolDefinition[] {
  return [...TOOLS];
}

export function defaultToolContext(workspaceId: string): ToolContext {
  return { workspaceId, repos: createRepositories() };
}
