"use client";
/**
 * Assistant — the owner's one AI, as a full-page conversation (2026-09-25).
 *
 * CEO: "make it as 1 only… full screen… conversational, just like how I'm
 * talking to Claude Code and it is doing my work." This replaces two things
 * that each did half of it:
 *   - the Command Center: a centred 750px column; type a job, approve a plan,
 *     read a report, and the exchange was over — no follow-up possible;
 *   - the Copilot: a 350px side panel that could not remember what was said.
 *
 * Now one page: conversations down the left (like a chat app), the thread
 * across the rest, the composer pinned at the bottom. The assistant remembers
 * the conversation (OwnerConversationBrain), asks back when unsure, and does
 * the work inside the thread: a plan appears as a card you run or discard,
 * its progress ticks in place, the report arrives as its reply, and you keep
 * talking. It also walks the owner through the business setup, one question
 * at a time (N13).
 *
 * The rules are unchanged and still enforced by the server, not this page:
 * nothing is sent to a customer, a plan runs only after "Run", drafts wait for
 * approval, and T4/T5 requests are refused.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, CheckCircle2, ClipboardList, Loader2, MessageSquarePlus, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { Badge, Button, useToast } from "@/components/ui";
import type { SetupAnswerProposal } from '@/lib/types';
import {
  DecisionBar, HowItWasDone, PlanSteps, ReportText, RunProgress, StepDrawer, TeamDrawer,
  jobStatus, when,
  type Busy, type JobRecord, type Outcome, type TeamMember,
} from "@/app/sections/command-center-parts";

type EntityType = "quote" | "reply" | "ticket" | "lead" | "icp" | "campaign" | "unknown_question" | "orchestration_job" | "knowledge_question" | "knowledge_answer_confirm";
type Message = {
  id: string;
  role: "owner" | "copilot";
  kind: string;
  text: string;
  tier?: "T1" | "T2" | "T3" | "T4" | "T5";
  pendingAction?: { intent: string; entityId?: string; entityType?: EntityType; proposal?: SetupAnswerProposal };
  createdAt: string;
};
type TurnResponse = { text: string; kind: string; tier: Message["tier"]; intent: string; aiStatus?: string; pendingAction?: Message["pendingAction"] };
type ConversationSummary = { id: string; title: string; messageCount: number; updatedAt: string };
type SetupProgress = { missing: number; total: number; checklist: { description: string; source: string } };

const POLL_MS = 2000;
const STARTERS = [
  { label: "Set up my business details", text: "Let's fill in my business details." },
  { label: "Who should I follow up today?", text: "Which leads should I follow up with today, and why?" },
  { label: "Draft messages for new leads", text: "Look through my newest approved leads and draft a first WhatsApp message for the best five." },
  { label: "What is our minimum order?", text: "What do we tell buyers about minimum order and delivery time?" },
];

export function Assistant({ activeLeadId, activeLeadName, onClearLead }: { activeLeadId?: string; activeLeadName?: string; onClearLead?: () => void }) {
  const { toast } = useToast();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationListError, setConversationListError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [conversationLead, setConversationLead] = useState<{ id?: string; name?: string }>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openingConversation, setOpeningConversation] = useState(true);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [teamOpen, setTeamOpen] = useState(false);
  const [openStep, setOpenStep] = useState<Outcome | null>(null);
  const [setup, setSetup] = useState<SetupProgress | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Which conversation load is current. A slow first load that finishes after
  // "New conversation" was pressed must not paint the old thread over the new
  // one (seen in the browser 2026-09-26: the old messages showed while new
  // messages went to the new conversation).
  const loadSeq = useRef(0);

  const labelFor = useCallback((agent: string) => team.find((member) => member.name === agent)?.label || agent, [team]);

  const loadConversations = useCallback(async () => {
    setConversationListError(null);
    try {
      setConversations(await api<ConversationSummary[]>("/api/copilot/conversations?list=1"));
    } catch (error) {
      setConversationListError(error instanceof Error ? error.message : "Couldn't load your saved conversations.");
    }
  }, []);

  const loadSetup = useCallback(() => {
    api<SetupProgress>("/api/copilot/setup-progress").then(setSetup).catch(() => setSetup(null));
  }, []);

  const openConversation = useCallback(async (id?: string) => {
    setLoadError(null);
    const seq = ++loadSeq.current;
    setOpeningConversation(true);
    try {
      const query = id ? `?id=${encodeURIComponent(id)}` : activeLeadId ? `?leadId=${encodeURIComponent(activeLeadId)}` : "";
      const convo = await api<{ id: string; activeLeadId?: string; activeLeadName?: string }>(`/api/copilot/conversations${query}`);
      const thread = await api<Message[]>(`/api/copilot/conversations/${convo.id}/messages`);
      if (seq !== loadSeq.current) return;
      setConversationId(convo.id);
      setConversationLead({ id: convo.activeLeadId, name: convo.activeLeadName });
      setMessages(thread);
    } catch (error) {
      if (seq !== loadSeq.current) return;
      setLoadError(error instanceof Error ? error.message : "Could not open the conversation.");
    } finally {
      if (seq === loadSeq.current) setOpeningConversation(false);
    }
  }, [activeLeadId]);

  useEffect(() => {
    void openConversation();
    void loadConversations();
    loadSetup();
    api<{ team: TeamMember[] }>("/api/copilot/jobs").then((data) => setTeam(data.team || [])).catch(() => undefined);
  }, [openConversation, loadConversations, loadSetup]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  function appendAssistant(response: TurnResponse) {
    setMessages((list) => [...list, { id: `a-${Date.now()}-${list.length}`, role: "copilot", kind: response.kind, text: response.text, tier: response.tier, pendingAction: response.pendingAction, createdAt: new Date().toISOString() }]);
  }

  async function send(text: string, extra: Record<string, unknown> = {}) {
    const clean = text.trim();
    if (!clean || thinking || !conversationId || openingConversation || loadError) return;
    setInput("");
    setThinking(true);
    const seq = loadSeq.current;
    setMessages((list) => [...list, { id: `o-${Date.now()}`, role: "owner", kind: "owner_input", text: clean, createdAt: new Date().toISOString() }]);
    try {
      const res = await api<{ ok: boolean; response: TurnResponse; error?: { message?: string } }>("/api/copilot/message", {
        method: "POST",
        body: { conversationId, text: clean, leadId: conversationLead.id, ...extra },
      });
      if (!res.ok) throw new Error(res.error?.message || "The assistant could not answer.");
      // The owner switched conversation while waiting: the reply is saved in
      // its own conversation and shows when that one is opened.
      if (seq !== loadSeq.current) return;
      appendAssistant(res.response);
      if (res.response.pendingAction?.entityType === "knowledge_question" || res.response.intent === "record_answer") loadSetup();
    } catch (error) {
      if (seq !== loadSeq.current) return;
      appendAssistant({ text: `Something went wrong: ${error instanceof Error ? error.message : "no answer"}. I could not confirm what was saved. Refresh the conversation and check the result before repeating the action.`, kind: "copilot_info", tier: "T1", intent: "error" });
    } finally {
      setThinking(false);
      void loadConversations();
      inputRef.current?.focus();
    }
  }

  // A double-click used to open several empty conversations at once.
  const creating = useRef(false);
  async function newConversation(options?: { clearLead?: boolean }) {
    if (creating.current) return;
    creating.current = true;
    const seq = ++loadSeq.current;
    setOpeningConversation(true);
    try {
      const leadId = options?.clearLead ? undefined : activeLeadId;
      const convo = await api<{ id: string; activeLeadId?: string }>("/api/copilot/conversations", { method: "POST", body: { leadId } });
      if (seq !== loadSeq.current) return;
      setLoadError(null);
      setConversationId(convo.id);
      setConversationLead({ id: convo.activeLeadId, name: leadId ? activeLeadName : undefined });
      setMessages([]);
      void loadConversations();
      inputRef.current?.focus();
    } catch (error) {
      toast({ tone: "danger", title: "Could not start a new conversation", description: error instanceof Error ? error.message : undefined });
    } finally {
      creating.current = false;
      if (seq === loadSeq.current) setOpeningConversation(false);
    }
  }

  async function confirmJob(intent: string, pendingActionId: string) {
    const seq = loadSeq.current;
    const res = await api<{ ok: boolean; response: TurnResponse; error?: { message?: string } }>("/api/copilot/confirm", {
      method: "POST",
      body: { conversationId, pendingActionId, intent },
    });
    if (!res.ok) throw new Error(res.error?.message || "The job did not run.");
    if (seq === loadSeq.current) {
      setMessages(list => list.map(message => message.pendingAction?.entityId === pendingActionId && message.pendingAction.entityType !== "orchestration_job" ? { ...message, pendingAction: undefined } : message));
      appendAssistant(res.response);
    }
  }

  async function approveQuote(quoteId: string) {
    const seq = loadSeq.current;
    try {
      const res = await api<{ ok: boolean; quote: { status: string }; error?: { message?: string } }>("/api/copilot/approve", { method: "POST", body: { quoteId } });
      if (!res.ok) throw new Error(res.error?.message || "Approve failed.");
      if (seq === loadSeq.current) appendAssistant({ text: `Quote approved. Nothing was sent to the customer — send it from Quotes & Orders when you are ready.`, kind: "copilot_action_done", tier: "T2", intent: "approve_quote" });
    } catch (error) {
      toast({ tone: "danger", title: "Approve failed", description: error instanceof Error ? error.message : undefined });
    }
  }

  // The owner's yes/no to "that sounds like the answer to another question —
  // save it there?". The server acts on the proposal it stored itself.
  async function settleAnswer(save: boolean) {
    if (thinking || !conversationId) return;
    setThinking(true);
    const seq = loadSeq.current;
    setMessages((list) => [...list, { id: `o-${Date.now()}`, role: "owner", kind: "owner_input", text: save ? "Yes, save it there" : "No, don't save it", createdAt: new Date().toISOString() }]);
    try {
      const res = await api<{ ok: boolean; response: TurnResponse; error?: { message?: string } }>("/api/copilot/setup-answer", { method: "POST", body: { conversationId, save } });
      if (!res.ok) throw new Error(res.error?.message || "Could not confirm the saved result.");
      if (seq !== loadSeq.current) return;
      appendAssistant(res.response);
      loadSetup();
    } catch (error) {
      if (seq !== loadSeq.current) return;
      appendAssistant({ text: `Something went wrong: ${error instanceof Error ? error.message : "no answer"}. I could not confirm what was saved. Refresh the conversation and check the result before repeating the action.`, kind: "copilot_info", tier: "T1", intent: "error" });
    } finally {
      setThinking(false);
      void loadConversations();
    }
  }

  async function saveFact(questionText: string) {
    const seq = loadSeq.current;
    try {
      const res = await api<{ ok: boolean; response: TurnResponse; error?: { message?: string } }>("/api/copilot/save-fact", { method: "POST", body: { conversationId, questionText, leadId: conversationLead.id } });
      if (!res.ok) throw new Error(res.error?.message || "Save failed.");
      if (seq === loadSeq.current) appendAssistant(res.response);
    } catch (error) {
      toast({ tone: "danger", title: "Save failed", description: error instanceof Error ? error.message : undefined });
    }
  }

  const lastAssistant = [...messages].reverse().find((message) => message.role === "copilot");
  const inSetup = lastAssistant?.pendingAction?.entityType === "knowledge_question" || lastAssistant?.pendingAction?.entityType === "knowledge_answer_confirm";

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[32rem] overflow-hidden rounded-xl border border-border-default bg-surface shadow-sm">
      {/* ── Conversations ─────────────────────────────────────────────── */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border-default bg-surface-muted/60 md:flex" aria-label="Your conversations">
        <div className="p-3">
          <Button icon={MessageSquarePlus} className="w-full" onClick={() => void newConversation()}>New conversation</Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {conversationListError ? <div className="space-y-2 px-3 py-2"><p role="alert" className="text-xs text-danger-fg">{conversationListError}</p><Button size="sm" variant="secondary" onClick={() => void loadConversations()}>Try conversations again</Button></div> : null}
          {conversations.length ? conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              aria-current={conversation.id === conversationId ? "true" : undefined}
              onClick={() => void openConversation(conversation.id)}
              className={`mb-1 block w-full rounded-lg px-3 py-2 text-left ${conversation.id === conversationId ? "bg-surface ring-1 ring-primary" : "hover:bg-surface"}`}
            >
              <span className="line-clamp-2 text-sm text-foreground">{conversation.messageCount ? conversation.title : "New conversation"}</span>
              <span className="mt-0.5 block text-xs text-muted">{when(conversation.updatedAt)}</span>
            </button>
          )) : <p className="px-3 py-2 text-xs text-muted">Your conversations will appear here.</p>}
        </nav>
        {setup && setup.total > 0 ? (
          <div className="border-t border-border-default p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Business setup</p>
            <p className="mt-1 text-sm text-foreground">{setup.total - setup.missing} of {setup.total} details known</p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(((setup.total - setup.missing) / setup.total) * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted">{setup.checklist.description}</p>
            {setup.missing ? (
              <button type="button" className="mt-2 text-xs font-semibold text-primary underline" onClick={() => void send("Let's continue setting up my business details.")}>Continue setup</button>
            ) : null}
          </div>
        ) : null}
        <div className="border-t border-border-default p-3">
          <button type="button" className="flex items-center gap-2 text-xs text-muted hover:text-foreground" onClick={() => setTeamOpen(true)}>
            <Users className="h-3.5 w-3.5" aria-hidden="true" /> Your AI team
          </button>
        </div>
      </aside>

      {/* ── Thread ────────────────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 lg:px-8">
            {loadError ? (
              <div role="alert" className="rounded-lg border border-danger-bg bg-danger-bg p-4 text-sm text-danger-fg">
                <p className="font-semibold">The conversation could not be opened.</p>
                <p className="mt-1">{loadError}</p>
                <Button variant="secondary" className="mt-3" onClick={() => void openConversation()}>Try again</Button>
              </div>
            ) : null}
            {openingConversation ? <p role="status" className="py-4 text-sm text-muted">Opening your conversation…</p> : null}
            {!messages.length && !loadError && !openingConversation ? (
              <div className="flex flex-col items-center gap-5 pt-[8vh] text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-tint text-primary"><Sparkles className="h-6 w-6" aria-hidden="true" /></span>
                <div>
                  <h2 className="text-xl font-semibold text-foreground">What should we work on?</h2>
                  <p className="mx-auto mt-1 max-w-xl text-sm text-muted-2">Ask anything, give it work, or set up your business together. It remembers the conversation and asks when something is unclear. Nothing is sent to a customer from here.</p>
                </div>
                <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                  {STARTERS.map((starter) => (
                    <button key={starter.label} type="button" onClick={() => void send(starter.text)} className="rounded-xl border border-border-default bg-surface px-4 py-3 text-left text-sm text-foreground shadow-sm hover:border-primary">
                      {starter.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {!openingConversation && messages.map((message) => message.role === "owner" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-white">{message.text}</div>
              </div>
            ) : (
              <div key={message.id} className="flex gap-3">
                <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${message.tier === "T5" ? "bg-danger-bg text-danger-fg" : "bg-surface-tint text-primary"}`}><Bot className="h-4 w-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <div className={message.tier === "T5" ? "rounded-lg border border-danger-bg bg-danger-bg p-3 text-danger-fg" : ""}>
                    {/* A plan's steps and cost are on the plan card below; the
                        message keeps only its one-line summary, not the raw
                        step list with helper codes. */}
                    <ReportText text={message.pendingAction?.entityType === "orchestration_job" ? message.text.split("\n")[0] : message.text} />
                  </div>
                  <ActionCard
                    message={message.pendingAction?.entityType !== "orchestration_job" && messages.some(item => item.role === "owner" && item.pendingAction?.entityId && item.pendingAction.entityId === message.pendingAction?.entityId) ? { ...message, pendingAction: undefined } : message}
                    labelFor={labelFor}
                    onOpenStep={setOpenStep}
                    onConfirm={confirmJob}
                    onApproveQuote={approveQuote}
                    onSaveFact={saveFact}
                    onSend={(text, extra) => void send(text, extra)}
                    onSettleAnswer={(save) => void settleAnswer(save)}
                    isLatest={message.id === lastAssistant?.id}
                  />
                </div>
              </div>
            ))}
            {thinking ? (
              <div className="flex items-center gap-3 text-sm text-muted">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-tint text-primary"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /></span>
                Thinking…
              </div>
            ) : null}
          </div>
        </div>

        {/* ── Composer ─────────────────────────────────────────────────── */}
        <div className="border-t border-border-default bg-surface px-4 py-3 lg:px-8">
          <div className="mx-auto max-w-4xl">
            {conversationLead.name || inSetup ? (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {conversationLead.name ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-tint px-3 py-1 text-xs text-primary-strong">
                    About: <strong>{conversationLead.name}</strong>
                    <button type="button" aria-label="Stop talking about this customer" onClick={() => void newConversation({ clearLead: true }).then(() => onClearLead?.())}><X className="h-3 w-3" /></button>
                  </span>
                ) : null}
                {inSetup ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-3 py-1 text-xs text-muted-2">
                    <ClipboardList className="h-3 w-3" aria-hidden="true" /> Setting up your business — your original words stay as proof; review suggested changes before saving
                    <button type="button" className="ml-1 font-semibold text-primary underline" onClick={() => void send("Skip this one.")}>Skip</button>
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-end gap-2 rounded-2xl border border-border-default bg-background px-3 py-2 focus-within:border-primary">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(input); }
                }}
                rows={Math.min(8, Math.max(1, input.split("\n").length))}
                placeholder={inSetup ? "Type your answer…" : "Ask or tell your assistant anything… (English or Hindi)"}
                aria-label="Message your assistant"
                className="max-h-48 min-h-[1.75rem] flex-1 resize-none bg-transparent py-1 text-sm outline-none"
                disabled={!conversationId || openingConversation || Boolean(loadError)}
              />
              <button type="button" aria-label="Send" onClick={() => void send(input)} disabled={!input.trim() || thinking || !conversationId || openingConversation || Boolean(loadError)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-white disabled:opacity-40">
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted"><ShieldCheck className="h-3 w-3 text-success-fg" aria-hidden="true" /> Enter to send · Shift+Enter for a new line · nothing is sent to a customer from here</p>
          </div>
        </div>
      </section>

      <TeamDrawer open={teamOpen} onOpenChange={setTeamOpen} team={team} />
      <StepDrawer outcome={openStep} labelFor={labelFor} onClose={() => setOpenStep(null)} />
    </div>
  );
}

/** What sits under an assistant message: a plan to run, a draft to approve, a form to fill. */
function ActionCard({ message, labelFor, onOpenStep, onConfirm, onApproveQuote, onSaveFact, onSend, onSettleAnswer, isLatest }: {
  message: Message;
  labelFor: (agent: string) => string;
  onOpenStep: (outcome: Outcome) => void;
  onConfirm: (intent: string, pendingActionId: string) => Promise<void>;
  onApproveQuote: (quoteId: string) => Promise<void>;
  onSaveFact: (questionText: string) => Promise<void>;
  onSend: (text: string, extra?: Record<string, unknown>) => void;
  onSettleAnswer: (save: boolean) => void;
  isLatest: boolean;
}) {
  const pending = message.pendingAction;
  if (!pending) return null;
  if (pending.entityType === "orchestration_job" && pending.entityId) {
    return <PlanCard jobId={pending.entityId} labelFor={labelFor} onOpenStep={onOpenStep} onRun={() => onConfirm("orchestrated_job", pending.entityId!)} />;
  }
  if ((pending.entityType === "icp" || pending.entityType === "campaign") && pending.entityId) {
    return <ConfirmCard onRun={() => onConfirm(pending.intent, pending.entityId!)} />;
  }
  if (pending.entityType === "quote" && pending.entityId) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-info-bg bg-surface p-3">
        <Badge tone="info">Draft quote</Badge>
        <Button onClick={() => void onApproveQuote(pending.entityId!)}>Approve quote</Button>
        <span className="text-xs text-muted">Nothing is sent to the customer.</span>
      </div>
    );
  }
  if (pending.entityType === "knowledge_answer_confirm" && isLatest) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => onSettleAnswer(true)}>{pending.proposal?.revision ? 'Save revised answer' : 'Save it there'}</Button>
        <Button variant="secondary" onClick={() => onSettleAnswer(false)}>Don&apos;t save</Button>
        <span className="text-xs text-muted">Or just type your reply.</span>
      </div>
    );
  }
  if (pending.entityType === "unknown_question" && isLatest) {
    return <div className="mt-3"><Button variant="secondary" onClick={() => void onSaveFact(message.text)}>Yes, save it</Button></div>;
  }
  if (message.kind === "copilot_question" && pending.intent === "draft_quote" && isLatest) {
    return <QuoteForm onSubmit={(fields) => onSend(`quote: ${fields.product} ${fields.qty} ${fields.unit} @ ${fields.rate}`, { quoteCapture: { productName: fields.product, quantity: Number(fields.qty), unit: fields.unit, unitPrice: Number(fields.rate), currencyCode: "INR" } })} />;
  }
  return null;
}

function ConfirmCard({ onRun }: { onRun: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  if (state === "done") return <p className="mt-2 flex items-center gap-1.5 text-xs text-success-fg"><CheckCircle2 className="h-3.5 w-3.5" /> Done — see the reply below.</p>;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-surface-muted px-4 py-3">
      <Button loading={state === "running"} onClick={async () => { setState("running"); try { await onRun(); setState("done"); } catch { setState("failed"); } }}>Yes, run it</Button>
      <span className="text-xs text-muted">{state === "failed" ? "Could not confirm completion. Check the conversation before trying again." : "Nothing is sent to customers."}</span>
    </div>
  );
}

/** A plan from the master AI: run or discard it, watch it work, see how it was done. */
function PlanCard({ jobId, labelFor, onOpenStep, onRun }: { jobId: string; labelFor: (agent: string) => string; onOpenStep: (outcome: Outcome) => void; onRun: () => Promise<void> }) {
  const { toast } = useToast();
  const [job, setJob] = useState<JobRecord | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // 2026-09-27 (A4): "Run it again" makes a fresh copy of the job; the card
  // then follows the copy. The copy runs through its own endpoint and shows
  // its report here, since the chat's confirm belongs to the original.
  const [currentId, setCurrentId] = useState(jobId);
  const isCopy = currentId !== jobId;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const working = (status?: string) => status === "running" || status === "cancelling";

  const load = useCallback(async () => {
    const record = await api<JobRecord>(`/api/copilot/jobs/${encodeURIComponent(currentId)}`);
    setJob(record);
    return record;
  }, [currentId]);
  const stop = () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };

  useEffect(() => {
    load().then((record) => { if (working(record.status)) watch(); }).catch(() => undefined);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  function watch() {
    stop();
    pollRef.current = setInterval(() => { load().then((record) => { if (!working(record.status)) stop(); }).catch(() => undefined); }, POLL_MS);
  }

  async function stopJob() {
    setBusy("stopping");
    try {
      const result = await api<{ cancelled: boolean; reason?: string }>(`/api/copilot/jobs/${encodeURIComponent(currentId)}/cancel`, { method: "POST", body: {} });
      if (!result.cancelled && result.reason) toast({ tone: "warning", title: "Not stopped", description: result.reason });
      const record = await load();
      if (working(record.status)) watch();
    } finally {
      setBusy(null);
    }
  }

  async function runAgain() {
    setBusy("copying");
    try {
      const copy = await api<{ jobId: string }>(`/api/copilot/jobs/${encodeURIComponent(currentId)}/again`, { method: "POST", body: {} });
      setCurrentId(copy.jobId);
    } catch (error) {
      toast({ tone: "danger", title: "Could not set it up again", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    setBusy("starting");
    setJob((current) => (current ? { ...current, status: "running" } : current));
    watch();
    try {
      if (isCopy) await api(`/api/copilot/jobs/${encodeURIComponent(currentId)}/run`, { method: "POST", body: {} });
      else await onRun();
    } catch (error) {
      toast({ tone: "danger", title: "The job stopped", description: error instanceof Error ? error.message : String(error) });
    } finally {
      stop();
      setBusy(null);
      await load().catch(() => undefined);
    }
  }

  async function discard() {
    setBusy("discarding");
    try {
      const result = await api<{ cancelled: boolean; reason?: string }>(`/api/copilot/jobs/${encodeURIComponent(currentId)}/cancel`, { method: "POST", body: {} });
      if (!result.cancelled && result.reason) toast({ tone: "warning", title: "Not discarded", description: result.reason });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!job) return <p className="mt-2 text-xs text-muted">Loading the plan…</p>;
  // A run the owner stopped is "cancelled" like a discarded plan, but it did
  // work; it has outcomes, and it says "Stopped", not "Discarded".
  const stoppedRun = job.status === "cancelled" && Boolean(job.result?.outcomes?.length);
  const status = stoppedRun ? { label: "Stopped", tone: "neutral" as const } : jobStatus(job.status);
  const finished = ["completed", "partial", "failed"].includes(job.status) || stoppedRun;
  const finishedText = job.status === "failed"
    ? job.errorMessage || "The job failed."
    : stoppedRun
      ? "You stopped this job."
      : isCopy ? "Finished." : "Finished — the report is in the reply below.";
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border-default bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Plan</span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {working(job.status) ? <RunProgress job={job} /> : null}
      {job.status === "awaiting_confirmation" || working(job.status) ? <PlanSteps job={job} labelFor={labelFor} onOpenStep={onOpenStep} /> : null}
      {working(job.status) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-muted px-4 py-3">
          <p className="text-xs text-muted">
            {job.status === "cancelling" ? "Stopping — helpers already working finish their step; nothing new starts." : "You can stop this job. Nothing new starts after you do."}
          </p>
          {job.status === "running" ? (
            <Button variant="ghost" size="sm" loading={busy === "stopping"} disabled={busy !== null && busy !== "starting"} onClick={() => void stopJob()}>Stop</Button>
          ) : null}
        </div>
      ) : null}
      {job.status === "awaiting_confirmation" ? (
        <DecisionBar maxCalls={Number(job.payload?.maxCalls || 0)} maxSearches={Number(job.payload?.maxSearches || 0)} busy={busy} onRun={() => void run()} onDiscard={() => void discard()} />
      ) : null}
      {finished ? (
        <>
          <p className="text-sm text-muted-2">{finishedText}</p>
          {isCopy && job.result?.text && !stoppedRun ? <ReportText text={job.result.text} /> : null}
          <HowItWasDone job={job} labelFor={labelFor} onOpenStep={onOpenStep} />
          {job.status === "failed" || stoppedRun ? (
            <div>
              <Button variant="secondary" size="sm" loading={busy === "copying"} disabled={busy !== null} onClick={() => void runAgain()}>Run it again</Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function QuoteForm({ onSubmit }: { onSubmit: (fields: { product: string; qty: string; unit: string; rate: string }) => void }) {
  const [fields, setFields] = useState({ product: "", qty: "", unit: "", rate: "" });
  const valid = fields.product.trim() && Number(fields.qty) > 0 && fields.unit.trim() && Number(fields.rate) >= 0 && fields.rate !== "";
  const input = "rounded-lg border border-border-default bg-background px-3 py-2 text-sm";
  return (
    <div className="mt-3 grid gap-2 rounded-xl border border-border-default bg-surface p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
      <input className={input} placeholder="Product" aria-label="Product name" value={fields.product} onChange={(e) => setFields({ ...fields, product: e.target.value })} />
      <input className={input} placeholder="Qty" type="number" aria-label="Quantity" value={fields.qty} onChange={(e) => setFields({ ...fields, qty: e.target.value })} />
      <input className={input} placeholder="Unit" aria-label="Unit" value={fields.unit} onChange={(e) => setFields({ ...fields, unit: e.target.value })} />
      <input className={input} placeholder="Rate ₹" type="number" aria-label="Rate per unit in rupees" value={fields.rate} onChange={(e) => setFields({ ...fields, rate: e.target.value })} />
      <Button disabled={!valid} onClick={() => onSubmit(fields)}>Draft quote</Button>
    </div>
  );
}
