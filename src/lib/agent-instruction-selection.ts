import type { KnowledgeBaseDocument } from "@/lib/types";

/**
 * N-AI-12 (2026-08-27). Shared, dependency-free selection rules for the ONE
 * agent-instruction document that counts.
 *
 * This lives in lib/ rather than in KnowledgeBaseService so that both the write
 * side (the service that upserts the instruction) and the read side
 * (AgentInstructionLoader, which runs inside every agent call) can use exactly
 * the same rule without the two modules importing each other. A save rule and a
 * read rule that can drift apart is how N-AI-12 happened in the first place.
 */

/**
 * Agent names are written three different ways across the product, and the two
 * sides of this feature used different ones:
 *
 *   - the Agent Instructions SCREEN saves `business_profile_agent`
 *     (from constants/agents.ts, which carries an "_agent" suffix)
 *   - the RUNTIME looks up `business_profile`
 *     (from AgentRuntime.taskAgentMap, which does not)
 *
 * N-AI-15 (2026-08-27): because of that mismatch, workspace instructions typed
 * on that screen never reached any agent at all — not stale, never applied.
 * Normalising here collapses hyphen/underscore, case, and the optional "-agent"
 * suffix, so both spellings resolve to the same agent. Names are unique without
 * the suffix, so nothing can collide.
 */
export function normalizeAgentName(agentName: string) {
  return String(agentName || "").replace(/_/g, "-").trim().toLowerCase().replace(/-agent$/, "");
}

/**
 * Newest wins: updatedAt desc, tie-broken by createdAt then id so the answer is
 * deterministic and identical on the JSON and Postgres substrates.
 *
 * Ordering is applied HERE rather than in the repository's listByWorkspace,
 * deliberately: that list feeds document-listing screens too, and quietly
 * changing its order on one substrate only would trade this bug for a
 * substrate difference — a worse one, because it would be invisible.
 */
export function pickCurrentAgentInstruction(documents: KnowledgeBaseDocument[], agentName: string) {
  const wanted = normalizeAgentName(agentName);
  return documents
    .filter((document) => document.documentType === "agent_instruction" && normalizeAgentName(String(document.metadata?.agentName || "")) === wanted)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || (b.createdAt || "").localeCompare(a.createdAt || "") || b.id.localeCompare(a.id))[0];
}
