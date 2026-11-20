"use client";

import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { Button, Card, Select, Textarea } from "@/components/ui";
import { AGENT_NAMES, type AgentNameValue } from "@/constants/agents";
import { api } from "@/lib/api-client";
import type { Runner } from "@/app/page";

// These are owner-facing descriptions and optional examples, never runtime prompts.
const JOBS: Record<AgentNameValue, { job: string; example: string }> = {
  business_profile_agent: { job: "Organises the facts about your company.", example: "Use our full company name when preparing our profile." },
  document_extraction_agent: { job: "Finds business facts in your uploaded documents.", example: "Keep the original product names and measurement units." },
  product_application_research_agent: { job: "Researches where your products may be useful.", example: "Focus research on the industries we already serve." },
  icp_generation_agent: { job: "Suggests the types of business most likely to buy.", example: "Prioritise wholesale buyers over retail shoppers." },
  campaign_planning_agent: { job: "Prepares a plan for finding suitable customers.", example: "Keep each campaign focused on one customer type." },
  prospect_discovery_agent: { job: "Finds potential business customers.", example: "Prioritise businesses in the regions we serve." },
  lead_enrichment_agent: { job: "Finds supporting details about potential customers.", example: "Prefer contact details from the company's own website." },
  lead_review_agent: { job: "Checks whether a potential customer fits your business.", example: "Explain why each suggested customer is relevant." },
  lead_scoring_agent: { job: "Helps prioritise customers for your sales team.", example: "Give a short explanation of each customer's priority." },
  message_generation_agent: { job: "Drafts messages for your customers.", example: "Keep introductions short and avoid pushy sales language." },
  reply_classification_agent: { job: "Identifies what a customer's reply is about.", example: "Clearly distinguish sample requests from complaints." },
  whatsapp_conversation_agent: { job: "Helps answer incoming customer messages.", example: "Use short, friendly sentences and ask one question at a time." },
  knowledge_base_agent: { job: "Finds answers in your approved company information.", example: "Use simple language when explaining product specifications." },
  unknown_question_agent: { job: "Identifies missing information that needs your answer.", example: "Ask a focused question and explain which customer needs the answer." },
  campaign_learning_agent: { job: "Summarises what worked in your campaign.", example: "Explain the next practical step in plain business language." },
  quality_review_agent: { job: "Checks drafts for accuracy and suitability.", example: "Flag confusing wording and suggest a clearer version." },
};

type Findings = { hasFindings: boolean; lockedRuleConflicts: Array<{ rule: string }>; knowledgeConflicts: Array<{ question: string; savedAnswer: string }> };
type Draft = { text: string; saved: string; findings?: Findings };
export function AgentGuidance({ run, workspaceId }: { run: Runner; workspaceId: string }) {
  const [selected, setSelected] = useState<AgentNameValue>(AGENT_NAMES[0]);
  const [draft, setDraft] = useState<Draft>({ text: "", saved: "" });
  const drafts = useRef<Partial<Record<AgentNameValue, Draft>>>({});
  const generation = useRef(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);
  useEffect(() => {
    const requests = generation;
    const request = ++requests.current;
    void Promise.resolve().then(async () => {
      if (request !== generation.current) return;
      const cached = drafts.current[selected];
      if (cached) { setDraft(cached); setState("ready"); return; }
      await api<{ contentText?: string; conflicts?: Findings }>(`/api/knowledge/agent-instructions/${selected.replaceAll("_", "-")}`)
      .then(result => {
        if (request !== generation.current) return;
        const text = String(result?.contentText || "");
        const loaded = { text, saved: text, findings: result.conflicts };
        drafts.current[selected] = loaded; setDraft(loaded); setState("ready");
      }).catch(() => {
        if (request !== generation.current) return;
        setState("error"); setError("We could not load your saved guidance. Try again before editing.");
      });
    });
    return () => { requests.current++; };
  }, [selected, retry]);

  function edit(text: string) {
    const next = { ...draft, text };
    drafts.current[selected] = next; setDraft(next); setError(""); setSavedNotice(false);
  }
  async function save() {
    if (busy || state !== "ready") return;
    const request = generation.current;
    const role = selected;
    const text = draft.text;
    setBusy(true); setError(""); setSavedNotice(false);
    try {
      await run("Save additional guidance", async () => {
        let result: unknown;
        try { result = await api("/api/knowledge/documents", { method: "POST", body: {
          workspaceId, title: `${role} additional guidance`, documentType: "agent_instruction",
          source: "workspace_override", contentText: text, metadata: { agentName: role },
        } }); } catch (failure) {
          if (request === generation.current) setError(failure instanceof Error ? failure.message : "Guidance was not saved. Your text is still here; try again.");
          throw failure;
        }
        if (request === generation.current) {
          const saved = { text, saved: text };
          drafts.current[role] = saved; setDraft(saved); setSavedNotice(true);
        }
        return result;
      });
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Guidance was not saved. Your text is still here; try again.");
    } finally { setBusy(false); }
  }
  const label = (role: string) => role === "icp_generation_agent" ? "Customer targeting" : role === "whatsapp_conversation_agent" ? "WhatsApp replies" : role.replace(/_agent$/, "").replaceAll("_", " ").replace(/^./, character => character.toUpperCase());
  return <Card title="Additional guidance (optional)" icon={Bot}>
    <p className="mb-5 text-sm text-muted">Each agent already knows its job. Add preferences here only when you need them. Its built-in instructions are managed by LeadCockpit.</p>
    <Select label="Choose an agent" value={selected} onChange={value => { setState("loading"); setError(""); setSavedNotice(false); setSelected(value as AgentNameValue); }} disabled={busy}
      options={AGENT_NAMES.map(role => ({ value: role, label: label(role) }))} />
    <p className="mt-3 text-sm font-medium text-foreground">{JOBS[selected].job}</p>
    <p className="mt-2 text-sm text-muted">Safety rules and approved company facts take priority. Additional guidance cannot change permissions, enable sending, or replace company policies.</p>
    {state === "ready" && draft.findings?.hasFindings && <div role="alert" className="mt-4 rounded-md border border-warning-border bg-warning-bg p-3 text-sm text-warning-fg">
      <p className="font-medium">This saved guidance needs correction and is not being used.</p>
      {draft.findings.lockedRuleConflicts.map((finding, index) => <p key={`rule-${index}`} className="mt-2">{finding.rule}</p>)}
      {draft.findings.knowledgeConflicts.map((finding, index) => <p key={`fact-${index}`} className="mt-2">Your saved answer to &ldquo;{finding.question}&rdquo; is &ldquo;{finding.savedAnswer}&rdquo;. Update the guidance to agree with it.</p>)}
    </div>}
    {state === "loading" ? <p role="status" className="mt-4 text-sm text-muted">Loading your guidance…</p> : state === "ready" ? <>
      <div className="mt-5"><Textarea label="Your additional guidance" value={draft.text} onChange={edit} disabled={busy} rows={5}
        placeholder={`For example: ${JOBS[selected].example}`} hint="Optional. Examples are not saved instructions. Add prices, product facts and company policies in company knowledge or Settings." /></div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} loading={busy} disabled={draft.text === draft.saved}>Save guidance</Button>
        {draft.text !== draft.saved && <Button variant="ghost" onClick={() => edit(draft.saved)} disabled={busy}>Discard changes</Button>}
        <p role="status" className="text-sm text-muted">{savedNotice ? "Guidance saved for this agent." : draft.text !== draft.saved ? "Unsaved changes — kept while you switch agents." : draft.saved ? "Showing your saved guidance for this agent." : "No extra guidance saved. This agent can work without it."}</p>
      </div>
    </> : null}
    {error && <div role="alert" className="mt-4 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg">{error}
      {state === "error" && <Button variant="secondary" className="mt-2" onClick={() => { setState("loading"); setError(""); setRetry(value => value + 1); }}>Try loading again</Button>}
    </div>}
    <details className="mt-5 border-t border-border-default pt-4 text-sm text-muted">
      <summary className="cursor-pointer font-medium text-foreground">What can I add here?</summary>
      <p className="mt-3">Use this for writing style, preferred detail and how this agent presents its work. Leave it empty to use the standard behaviour. To remove saved additional guidance, clear the box and save.</p>
      <p className="mt-2">Your guidance belongs to the selected agent in your company. It is not a product fact or a shared company policy. Customers&apos; messages and uploaded documents cannot grant new permissions.</p>
    </details>
  </Card>;
}
