/**
 * Knowledge Base screen — guided company brain (domains, guided blocks,
 * question/answer review workflow), source documents, and keyword search.
 *
 * Extracted from src/app/page.tsx (chokepoint-rule cleanup, F-5) — pure
 * mechanical move, no behavior change. See src/app/sections/Compliance.tsx
 * for the extraction pattern this file follows.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, EmptyState, Button, Badge, Checkbox, ConfirmModal, Drawer, DrawerBody, DrawerFooter } from "@/components/ui";
import { Panel, Empty } from "@/components/ui/primitives";
import { Sparkles, AlertCircle, BookOpen, FileText, Search, RefreshCw, Check, Settings, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { displayLabel, displayStoredTitle } from "@/lib/display-labels";
import { knowledgeAreaName } from "@/lib/knowledge-area-names";
import { aiAnswerCoverage, isWaitingForOwnerOk, knowledgeReadiness } from "@/lib/knowledge-readiness";
import { TestMyAI } from "@/app/sections/TestMyAI";
import { RemovedKnowledgeFacts } from "@/app/sections/RemovedKnowledgeFacts";
import type { Runner, TabId, KnowledgeDocument, ExtractionStatusResponse } from "@/app/page";
import { workspaceId, formatDate } from "@/app/page";

type KnowledgeQuestionAnswerItem = {
  id: string;
  domainKey: string;
  questionKey: string;
  question: string;
  answer?: string;
  answerStatus: "answered" | "unanswered" | "partial" | "conflict" | "needs_review" | "not_applicable";
  sourceType: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceFileName?: string;
  confidenceScore: number;
  usedByAgentsJson?: { values?: string[] };
  humanReviewRequired: boolean;
  sourceSnippet?: string;
  conflictReason?: string;
  evidenceJson?: {
    sources?: Array<{
      sourceType: string;
      sourceId?: string;
      sourceTitle?: string;
      sourceUrl?: string;
      sourceFileName?: string;
      sourceSnippet?: string;
      confidenceScore?: number;
      createdAt?: string;
    }>;
  };
  reviewedAt?: string;
  isUserApproved?: boolean;
  updatedAt: string;
  // Fixed-choice UI (2026-08-14, UA-3 follow-up): stamped on by the API from
  // the question framework. When set, the edit control below renders a
  // dropdown (single_choice) or Yes/No buttons (boolean) instead of a free
  // text box, so answers for fixed-choice questions can't drift off-topic.
  answerType?: string;
  options?: string[];
  /** Stamped by the server: what "Approve safe answers" would approve. */
  safeToBulkApprove?: boolean;
  /** N13 — false when the question is not on this business's checklist (an
   * answer kept from before the kind of business was set or changed). */
  onChecklist?: boolean;
  /** Whether a blank answer here counts as "not known yet". */
  countsAsMissing?: boolean;
};
type BusinessKindId = "manufacturer" | "trader" | "retailer" | "service";
type ChecklistInfo = { kinds: BusinessKindId[]; exports: boolean; source: "confirmed" | "proposed" | "unknown"; description: string };
const KIND_CHOICES: Array<{ id: BusinessKindId; label: string; note: string }> = [
  { id: "manufacturer", label: "Manufacturer", note: "You make what you sell." },
  { id: "trader", label: "Trader / wholesaler", note: "You buy from makers and sell on to businesses." },
  { id: "retailer", label: "Retailer", note: "You sell from a shop or online to end buyers." },
  { id: "service", label: "Service provider", note: "You sell work or time, not goods." },
];
type KnowledgeFrameworkSummary = {
  totalQuestions: number;
  domainCount: number;
  highPriorityCount: number;
  requiredCount: number;
  humanReviewCount: number;
  frontendPresentation?: { message: string; categoryCounts: Record<string, number> };
  domains: Array<{ domainKey: string; domainTitle: string; questionCount: number; highPriorityCount: number; requiredCount: number; sampleQuestions: string[] }>;
  checklist?: ChecklistInfo;
};
type GuidedKnowledgeBlockItem = {
  blockKey: string;
  domainKey: string;
  title: string;
  prompt: string;
  example: string;
  mappedQuestionKeys: string[];
  answeredCount: number;
  partialCount: number;
  missingCount: number;
  conflictCount: number;
  sampleAnswers: string[];
};
type GuidedBlocksResponse = { blocks: GuidedKnowledgeBlockItem[]; totalInternalQuestions: number };

/** A line in an uploaded document that answers the same question as a correction. */
type SupersedeCandidate = {
  chunkId: string;
  documentTitle?: string;
  sourceFileName?: string;
  text: string;
  score: number;
};

type SettingsSyncSummaryView = {
  synced?: boolean;
  status?: "synced" | "not_configured" | "failed";
  label?: string;
  message?: string;
  updatedAnswers?: number;
  action?: string;
  error?: string;
  sourceDetails?: {
    reviewedInformationNeeded?: number;
    directSettingsFields?: number;
    pendingReview?: number;
    reviewedDraftTitles?: string[];
    message?: string;
  };
};

/**
 * 2026-09-25 (cleanup pass, CEO: "one section is totally blank… everything is
 * grey… I can't tell what needs me"). The screen was four stacked panels that
 * each re-counted the same answers: a header with two badges, a "Knowledge
 * review workflow" panel whose left half was mostly empty and whose right half
 * was a 26-card "Domain Quality Overview" with grey badges — the SAME 26
 * sections, with the same counts, as the list directly under it — then the
 * sections, then documents and search taking another 1000px.
 *
 * Now: four coloured tiles say what needs the owner (and filter the section
 * list when pressed), one progress line, the actions, then ONE section list
 * with a coloured status per section beside the selected section's content.
 * Documents and search are one press away in drawers. Every number that was
 * on the screen is still reachable; none is shown twice.
 */
type SectionFilter = "all" | "conflict" | "signoff" | "missing";

const SECTION_STATUS = {
  conflict: { label: "Answers disagree", tone: "danger", bar: "bg-danger-fg" },
  not_started: { label: "Not started", tone: "neutral", bar: "bg-muted" },
  complete: { label: "Complete", tone: "success", bar: "bg-success-fg" },
  in_progress: { label: "In progress", tone: "info", bar: "bg-primary" },
} as const;

function sectionStatus(domain: DomainSummary): keyof typeof SECTION_STATUS {
  if (domain.conflicts) return "conflict";
  if (domain.answered === 0) return "not_started";
  if (domain.answered >= domain.total) return "complete";
  return "in_progress";
}

export function KnowledgeBase({ run, documents, load, setActive }: { run: Runner; documents: KnowledgeDocument[]; load: () => Promise<void>; setActive: (tab: TabId) => void }) {
  const [activeSection, setActiveSection] = useState("company_knowledge");
  const [answers, setAnswers] = useState<KnowledgeQuestionAnswerItem[]>([]);
  const [editingId, setEditingId] = useState("");
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [confirmCancelEdit, setConfirmCancelEdit] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [searchResult, setSearchResult] = useState<Record<string, unknown> | null>(null);
  const [frameworkSummary, setFrameworkSummary] = useState<KnowledgeFrameworkSummary | null>(null);
  const [extractionStatus, setExtractionStatus] = useState<ExtractionStatusResponse | null>(null);
  const [guidedBlocks, setGuidedBlocks] = useState<GuidedKnowledgeBlockItem[]>([]);
  const [filter, setFilter] = useState<SectionFilter>("all");
  const [docsOpen, setDocsOpen] = useState(false);
  const [removedFactsOpen, setRemovedFactsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Cluster 5 P1-10: load-error state.
  const [loadError, setLoadError] = useState<string | null>(null);
  // 2026-09-08 — removing a source document. Until now nothing in the product
  // could: whatever was ingested stayed in the agent's retrieval path for the
  // life of the workspace, including a bad extraction run's canned filler.
  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  // N13 — the owner confirms or changes the kind of business the checklist follows.
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [draftKinds, setDraftKinds] = useState<BusinessKindId[]>([]);
  const [draftExports, setDraftExports] = useState(false);
  const [checklistProblem, setChecklistProblem] = useState<string | null>(null);

  // N10 (2026-09-23) — whether meaning search is really working. It degrades
  // silently to word-matching by design, so without this line "on and working"
  // and "on and doing nothing" looked identical.
  const [searchStatus, setSearchStatus] = useState<{ meaningSearch: "on" | "partial" | "off"; summary: string } | null>(null);

  async function loadAnswers() {
    setLoadError(null);
    api<{ meaningSearch: "on" | "partial" | "off"; summary: string }>("/api/knowledge/search-status")
      .then(setSearchStatus)
      .catch(() => setSearchStatus(null));
    const [items, framework, status, guided] = await Promise.all([
      api<KnowledgeQuestionAnswerItem[]>("/api/knowledge/question-answers"),
      api<KnowledgeFrameworkSummary>("/api/knowledge/question-framework"),
      api<ExtractionStatusResponse>("/api/extraction-runs/active"),
      api<GuidedBlocksResponse>("/api/knowledge/guided-blocks"),
    ]);
    setAnswers(items);
    setFrameworkSummary(framework);
    setExtractionStatus(status);
    setGuidedBlocks(guided.blocks);
    if (!items.some((item) => item.domainKey === activeSection) && items[0]) setActiveSection(items[0].domainKey);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load knowledge documents"));
      loadAnswers().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load knowledge answers"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (loadError) {
    return (
      <Card title="Knowledge Base" icon={Sparkles}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={loadError}
          action={<Button onClick={() => {
            load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load knowledge documents"));
            loadAnswers().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load knowledge answers"));
          }}>Try again</Button>}
        />
      </Card>
    );
  }

  // N13 — only this business's checklist counts. Answers to questions that
  // are not on it are kept and listed separately, never deleted.
  const checklistAnswers = answers.filter((a) => a.onChecklist !== false);
  const keptAnswers = answers.filter((a) => a.onChecklist === false && a.answer?.trim());
  const checklist = frameworkSummary?.checklist;
  const openChecklist = () => {
    setDraftKinds(checklist?.kinds || []);
    setDraftExports(Boolean(checklist?.exports));
    setChecklistProblem(null);
    setChecklistOpen(true);
  };
  // 2026-09-30 (page guide): the sections are counted over the same questions
  // and with the same rule as the headline, so they add up to it. They used to
  // count every checklist question (195, headline 190) and leave a question
  // out of "answered" while its answers disagreed (58 answered, headline 61).
  const domains = groupQuestionAnswers(checklistAnswers.filter((a) => a.countsAsMissing !== false));
  const matchesFilter = (domain: DomainSummary) =>
    filter === "all" ? true : filter === "conflict" ? domain.conflicts > 0 : filter === "signoff" ? domain.unapproved > 0 : domain.missing > 0;
  const shownDomains = domains.filter(matchesFilter);
  const activeDomain = shownDomains.find((domain) => domain.domainKey === activeSection) || shownDomains[0] || domains[0];
  const activeAnswers = checklistAnswers.filter((answer) => answer.domainKey === activeDomain?.domainKey);
  const activeGuidedBlocks = guidedBlocks.filter((block) => block.domainKey === activeDomain?.domainKey);

  // Counted the same way as each section's "8/17" (answered or answered but
  // flagged for review), so the sections add up to this line.
  // 2026-09-26 — counted exactly as the assistant's "Business setup" card
  // counts (SetupInterviewService): only questions whose blank counts as
  // missing, and "not known" = blank, unanswered or only partly answered.
  const countedAnswers = checklistAnswers.filter((a) => a.countsAsMissing !== false);
  const isNotKnown = (a: KnowledgeQuestionAnswerItem) => a.answerStatus === "unanswered" || a.answerStatus === "partial" || !a.answer?.trim();
  const missingCount = countedAnswers.filter(isNotKnown).length;
  const answeredCount = countedAnswers.length - missingCount;
  const conflictCount = checklistAnswers.filter((a) => a.answerStatus === "conflict").length;
  // 2026-09-04 N-UX-35 — approving IS waiting for a person, so it counts.
  // 2026-09-29 (owner walk-through K1): the screen showed four numbers for one
  // thing — "29 of 190" (headline), "60 answered, 33 approved", "30 waiting",
  // "1 of 27 sections" — counted over different sets of questions, so they
  // could not be added up. Now every question-count on this screen is over the
  // same questions (countedAnswers) and splits exactly three ways:
  //   ready for the AI (the headline's rule) + waiting for your OK + not known
  //   yet = the total.
  // The server decides what is safe (it also excludes prices, payment,
  // delivery and other sensitive topics); the screen only counts its verdict.
  const safeCandidates = answers.filter((item) => item.safeToBulkApprove);
  // 2026-09-04 N-UX-34 — a section is ready when every question mapped to it
  // has been answered.
  // 2026-09-25 — counted in the same unit as the section list beside it
  // (it used to count the smaller "parts" inside sections: "1 of 26 parts"
  // next to a list of 25 sections).
  // 2026-09-27 (K7): "ready for the AI" means the AI can USE it — every
  // question answered AND OK'd by the owner (or not applying). It used to count
  // answered-but-unapproved answers, which the AI never serves.
  const readiness = knowledgeReadiness(checklistAnswers);
  // 2026-09-28 — the one-line headline: approved answers only, same rule the
  // AI's searchable copy is built from (isAnswerServable).
  // Same questions as the "N of M questions answered" line below, so the two
  // totals on one screen agree.
  const coverage = aiAnswerCoverage(countedAnswers);
  const awaitingApprovalCount = Math.max(0, answeredCount - coverage.canAnswer);
  const readySectionCount = readiness.readySections;
  const totalQuestions = countedAnswers.length;
  const quality = extractionStatus?.run?.quality;
  const usedBackup = quality?.realLlmBatchCount !== undefined && quality.fallbackBatchCount > 0;
  const pickFilter = (next: SectionFilter) => {
    const value = filter === next ? "all" : next;
    setFilter(value);
    setEditingId("");
    const first = domains.find((d) => value === "all" || (value === "conflict" ? d.conflicts > 0 : value === "signoff" ? d.unapproved > 0 : d.missing > 0));
    if (first) setActiveSection(first.domainKey);
  };
  const editText = answerDrafts[editingId] ?? answers.find(answer => answer.id === editingId)?.answer ?? "";
  const setEditText = (value: string) => {
    if (editingId) setAnswerDrafts(drafts => ({ ...drafts, [editingId]: value }));
  };
  const unsavedAnswerCount = Object.entries(answerDrafts).filter(([id, value]) => value !== (answers.find(answer => answer.id === id)?.answer || "")).length;
  const finishEditing = () => {
    setAnswerDrafts(drafts => { const next = { ...drafts }; delete next[editingId]; return next; });
    setEditingId("");
    setConfirmCancelEdit(false);
  };
  const cancelEditing = () => {
    if (editText !== (answers.find(answer => answer.id === editingId)?.answer || "")) setConfirmCancelEdit(true);
    else finishEditing();
  };

  return (
    <div className="space-y-4">
      {unsavedAnswerCount > 0 && <p role="status" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">
        {unsavedAnswerCount} unfinished answer{unsavedAnswerCount === 1 ? " is" : "s are"} kept while you switch sections or filters. Open Edit on the answer to continue. Save it before leaving this page.
      </p>}
      <ConfirmModal open={confirmCancelEdit} title="Discard this unfinished answer?" confirmLabel="Discard answer edits" cancelLabel="Keep editing" tone="danger" onClose={() => setConfirmCancelEdit(false)} onConfirm={finishEditing}>
        Your saved answer stays as it is. Only these unfinished edits will be discarded.
      </ConfirmModal>
      <p className="text-lg font-semibold text-foreground" data-testid="kb-ai-coverage">
        AI can answer from {coverage.canAnswer} of {coverage.of} questions
        <span className="block text-sm font-normal text-muted sm:ml-2 sm:inline">Only answers you&apos;ve approved count. Only these can ever go out without you — a draft that uses an unapproved document always waits for you.</span>
      </p>
      <TestMyAI />
      {/* 2026-09-30 (page guide): the same numbers used to appear three times —
          the headline, four tiles and a progress line. One row now: the bar,
          then the three parts that add up to the total, each a filter. */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border-default bg-surface px-4 py-3 shadow-sm">
        {/* basis: the chips need room for one line; when the buttons do not fit beside them, the buttons wrap below. */}
        <div className="min-w-0 flex-1 basis-[36rem]">
          <div className="flex h-2 w-full max-w-md overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((coverage.canAnswer / Math.max(totalQuestions, 1)) * 100)}%` }} />
            <div className="h-full bg-warning-border transition-all" style={{ width: `${Math.round((awaitingApprovalCount / Math.max(totalQuestions, 1)) * 100)}%` }} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Show only">
            <FilterChip tone="success" label={`${coverage.canAnswer} ready for the AI`} />
            <FilterChip tone="warning" label={`${awaitingApprovalCount} waiting for your OK`} active={filter === "signoff"} onClick={awaitingApprovalCount ? () => pickFilter("signoff") : undefined} />
            <FilterChip tone="neutral" label={`${missingCount} not known yet`} active={filter === "missing"} onClick={missingCount ? () => pickFilter("missing") : undefined} />
            {conflictCount ? <FilterChip tone="danger" label={`${conflictCount} where answers disagree`} active={filter === "conflict"} onClick={() => pickFilter("conflict")} /> : null}
          </div>
          <p className="mt-2 text-xs text-muted">
            Out of {totalQuestions} questions. {readySectionCount} of {domains.length} areas are complete and approved.
            {awaitingApprovalCount ? ` ${awaitingApprovalCount} answer${awaitingApprovalCount === 1 ? "" : "s"} your AI can't use until you OK ${awaitingApprovalCount === 1 ? "it" : "them"}.` : ""}
            {safeCandidates.length ? ` ${safeCandidates.length} answers are safe to approve in one click.` : ""}
          </p>
          {checklist ? (
            <p className="mt-2 text-xs text-muted">
              Your checklist: <strong className="text-foreground">{checklist.description}</strong>
              {checklist.source === "proposed" ? " (our guess from your documents)" : checklist.source === "unknown" ? " — only the basic questions until you say" : ""}
              {" · "}
              <button type="button" className="font-semibold text-primary underline" onClick={openChecklist}>
                {checklist.source === "confirmed" ? "Change" : "Confirm or change"}
              </button>
            </p>
          ) : null}
          {usedBackup ? <p className="mt-2 text-xs text-warning-fg">Some answers came from backup mode, not a real AI. Check them before approving.</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {safeCandidates.length ? (
            <Button icon={Check} onClick={() => run("Approve safe answers", async () => {
              const response = await api<{ message?: string }>("/api/knowledge/question-answers/approve-safe", { method: "POST", body: { workspaceId } });
              setResult({ message: response.message || "Safe answers approved." });
              await loadAnswers();
            })}>
              Approve {safeCandidates.length} safe answers
            </Button>
          ) : null}
          <Button variant="secondary" icon={RefreshCw} title="Rebuild what the AI searches from your latest answers and settings" onClick={() => run("Refresh the AI's copy", async () => {
            const syncResult = await api<Record<string, unknown>>("/api/knowledge/sync", { method: "POST", body: { workspaceId } });
            setResult({ syncSummary: syncResult });
            await load();
            await loadAnswers();
            if (syncResult.status === "partial" || syncResult.status === "failed") {
              throw new Error("Some knowledge could not be refreshed. Check the sync details below, then try again. Successfully refreshed areas have been kept.");
            }
          })}>
            Refresh the AI&apos;s copy
          </Button>
          <Button variant="secondary" icon={FileText} onClick={() => setDocsOpen(true)}>Documents ({documents.length})</Button>
          <Button variant="secondary" onClick={() => setRemovedFactsOpen(true)}>Removed source facts</Button>
          <Button variant="secondary" icon={Search} onClick={() => setSearchOpen(true)}>Search</Button>
        </div>
      </div>
      {result?.syncSummary ? <SyncSummaryPanel summary={result.syncSummary as Record<string, unknown>} onOpenSettings={() => setActive("settings")} /> : null}
      <RemovedKnowledgeFacts open={removedFactsOpen} onClose={() => setRemovedFactsOpen(false)} />
      {typeof result?.message === "string" ? <p className="rounded-md border border-success-bg bg-surface-tint p-2 text-sm text-success-fg">{String(result.message)}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="max-h-80 space-y-1 self-start overflow-y-auto rounded-xl border border-border-default bg-surface p-2 shadow-sm lg:max-h-none lg:overflow-visible">
          {filter !== "all" ? (
            <div className="flex items-center justify-between gap-2 px-2 pb-2 text-xs text-muted">
              <span>{shownDomains.length} of {domains.length} sections</span>
              <button type="button" className="font-semibold text-primary underline" onClick={() => setFilter("all")}>Show all</button>
            </div>
          ) : null}
          {shownDomains.map((domain) => {
            const status = SECTION_STATUS[sectionStatus(domain)];
            const selected = activeDomain?.domainKey === domain.domainKey;
            return (
              <button
                key={domain.domainKey}
                type="button"
                aria-pressed={selected}
                onClick={() => { setActiveSection(domain.domainKey); setEditingId(""); }}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${selected ? "bg-surface-tint ring-1 ring-primary" : "hover:bg-surface-muted"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={`font-medium ${selected ? "text-primary-strong" : "text-foreground"}`}>{domain.domainTitle}</span>
                  <Badge tone={status.tone} className="shrink-0 whitespace-nowrap">{status.label}</Badge>
                </span>
                <span className="mt-1.5 flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                    <span className={`block h-full rounded-full ${status.bar}`} style={{ width: `${Math.round((domain.answered / Math.max(domain.total, 1)) * 100)}%` }} />
                  </span>
                  <span className="text-xs tabular-nums text-muted">{domain.answered}/{domain.total}</span>
                </span>
              </button>
            );
          })}
        </aside>
        <Panel title={activeDomain ? activeDomain.domainTitle : "Sections"} icon={BookOpen}>
          <div className="space-y-3">
            {activeGuidedBlocks.length ? activeGuidedBlocks.map((block) => (
              <GuidedKnowledgeBlockCard
                key={block.blockKey}
                block={block}
                answers={activeAnswers.filter((answer) => block.mappedQuestionKeys.includes(answer.questionKey))}
                editingId={editingId}
                editText={editText}
                setEditingId={setEditingId}
                setEditText={setEditText}
                finishEditing={finishEditing}
                cancelEditing={cancelEditing}
                run={run}
                loadAnswers={loadAnswers}
              />
            )) : <Empty text="Nothing here yet. Upload or paste company documents in Onboarding and the AI will fill this in." />}
          </div>
        </Panel>
      </div>

      {keptAnswers.length ? (
        <details className="rounded-xl border border-border-default bg-surface px-4 py-3 shadow-sm">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Kept from before, not on your checklist ({keptAnswers.length})
          </summary>
          <p className="mt-2 text-xs text-muted">These don&apos;t count as missing for your kind of business. They are kept, and the AI can still use the approved ones.</p>
          <ul className="mt-2 divide-y divide-border-subtle">
            {keptAnswers.map((item) => (
              <li key={item.id} className="py-2 text-sm">
                <p className="font-medium text-foreground">{item.question}</p>
                <p className="mt-0.5 text-muted">{item.answer}</p>
                {item.answerStatus === "conflict" ? <Badge tone="danger" className="mt-1">Two sources disagree</Badge> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Drawer
        open={checklistOpen}
        onOpenChange={setChecklistOpen}
        title="What kind of business are you?"
        description="The checklist asks only what applies to your kind of business. Pick all that fit."
      >
        <DrawerBody>
          <div className="space-y-3">
            {KIND_CHOICES.map((kind) => (
              <Checkbox
                key={kind.id}
                checked={draftKinds.includes(kind.id)}
                onChange={(on) => setDraftKinds((list) => (on ? [...list, kind.id] : list.filter((item) => item !== kind.id)))}
                label={<span><span className="font-medium text-foreground">{kind.label}</span><span className="block text-xs text-muted">{kind.note}</span></span>}
              />
            ))}
            <div className="border-t border-border-subtle pt-3">
              <Checkbox
                checked={draftExports}
                onChange={setDraftExports}
                label={<span><span className="font-medium text-foreground">We export</span><span className="block text-xs text-muted">Adds questions on shipping terms, export papers and payment from abroad.</span></span>}
              />
            </div>
            {checklistProblem ? <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">{checklistProblem}</p> : null}
            <p className="text-xs text-muted">Answers you already gave are kept, whatever you pick.</p>
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="secondary" onClick={() => setChecklistOpen(false)}>Cancel</Button>
          <Button
            disabled={!draftKinds.length}
            onClick={() => run("Save your kind of business", async () => {
              setChecklistProblem(null);
              try {
                await api("/api/knowledge/checklist", { method: "PUT", body: { kinds: draftKinds, exports: draftExports } });
              } catch (error) {
                setChecklistProblem(error instanceof Error ? error.message : "Could not save.");
                return;
              }
              setChecklistOpen(false);
              await loadAnswers();
            })}
          >
            Save
          </Button>
        </DrawerFooter>
      </Drawer>

      <Drawer open={docsOpen} onOpenChange={setDocsOpen} title={`Source documents (${documents.length})`} description="Everything here is searched when the AI answers a customer. Remove anything wrong or out of date — it is being quoted." size="lg">
        <DrawerBody>
          {searchStatus && searchStatus.meaningSearch !== "on" ? (
            <p className="mb-3 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">Search matches exact words only for {searchStatus.meaningSearch === "partial" ? "part of" : "all of"} your documents, so a customer who words a question differently may not get an answer.</p>
          ) : null}
          {documents.length ? (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-default p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{displayStoredTitle(doc.title)}</p>
                    <p className="text-xs text-muted">{displayLabel(doc.documentType)} · updated {formatDate(doc.updatedAt)}</p>
                  </div>
                  <Button variant="secondary" icon={Trash2} onClick={() => setPendingDelete(doc)} aria-label={`Remove ${displayStoredTitle(doc.title)}`}>Remove</Button>
                </div>
              ))}
            </div>
          ) : <Empty text="No documents yet. Add them in Onboarding." />}
        </DrawerBody>
      </Drawer>
      <ConfirmModal
        open={Boolean(pendingDelete)}
        title="Remove this document from the Knowledge Base?"
        confirmLabel="Remove document"
        tone="danger"
        loading={deleting}
        onClose={() => { if (!deleting) setPendingDelete(null); }}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleting(true);
          try {
            await run("Remove knowledge document", async () => {
              await api(`/api/knowledge/documents/${pendingDelete.id}`, { method: "DELETE" });
              await load();
            });
            setPendingDelete(null);
          } finally {
            setDeleting(false);
          }
        }}
      >
        <p><strong>{pendingDelete ? displayStoredTitle(pendingDelete.title) : ""}</strong> and everything indexed from it are removed. The agent stops using it immediately. This cannot be undone — if the content is still needed, upload it again from Onboarding.</p>
      </ConfirmModal>

      <Drawer open={searchOpen} onOpenChange={setSearchOpen} title="Search what the AI knows" description="Type a customer's question to see what the AI would find." size="lg">
        <DrawerBody>
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); run("Knowledge search", async () => setSearchResult(await api("/api/knowledge/search", { method: "POST", body: { workspaceId, query } }))); }}>
            <input className="input" aria-label="Search the knowledge" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. What is your minimum order?" />
            <Button type="submit" icon={Search} disabled={!query.trim()}>Search</Button>
          </form>
          {searchResult ? <KnowledgeSearchResultView result={searchResult} /> : null}
        </DrawerBody>
      </Drawer>
    </div>
  );
}

function GuidedKnowledgeBlockCard({ block, answers, editingId, editText, setEditingId, setEditText, finishEditing, cancelEditing, run, loadAnswers }: {
  block: GuidedKnowledgeBlockItem;
  answers: KnowledgeQuestionAnswerItem[];
  editingId: string;
  editText: string;
  setEditingId: (value: string) => void;
  setEditText: (value: string) => void;
  finishEditing: () => void;
  cancelEditing: () => void;
  run: Runner;
  loadAnswers: () => Promise<void>;
}) {
  const visibleAnswers = answers.filter((answer) => answer.answerStatus !== "unanswered" && answer.answer?.trim());
  // K7 (2026-09-27): answered is not the same as usable — the AI only uses
  // answers the owner has OK'd.
  const waitingForOk = answers.filter(isWaitingForOwnerOk).length;
  return (
    <div className="rounded-md border border-border-default bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-foreground">{block.title}</h3>
          <p className="mt-1 text-sm text-muted-2">{block.prompt}</p>
          <p className="mt-2 rounded-md bg-surface-muted p-2 text-xs text-muted">Example: {block.example}</p>
          {/* 2026-09-03 (N-UX-12) — this row used to be up to NINE badges on
              every block: five counts (mapped / answered / partial / missing /
              conflicts) plus four source types. With ~20 blocks on screen that
              is where most of the 202 numbers the screen walk counted came
              from, and none of them told the operator what to DO.

              One badge now says the block's state, ranked worst-first, because
              only the worst thing is actionable — a block with a contradiction
              in it is not "80% answered", it is wrong. The counts stay, as one
              quiet checkable pair ("14 of 20 answered") rather than five peers.
              Source types moved out entirely: they are evidence, and every
              answer below already carries its own "View sources". */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {block.conflictCount ? (
              <Badge tone="danger">{block.conflictCount} contradict each other</Badge>
            ) : block.missingCount ? (
              <Badge tone="warning">{block.missingCount} still missing</Badge>
            ) : block.partialCount ? (
              <Badge tone="warning">{block.partialCount} half answered</Badge>
            ) : waitingForOk ? (
              <Badge tone="warning">{waitingForOk} waiting for your OK</Badge>
            ) : (
              <Badge tone="success">Ready for the AI to use</Badge>
            )}
            <span className="text-xs text-muted">
              {block.answeredCount} of {block.mappedQuestionKeys.length} answered
            </span>
          </div>
        </div>
      </div>
      {visibleAnswers.length ? (
        <div className="mt-4 space-y-3">
          {visibleAnswers.slice(0, 4).map((answer) => (
            <GuidedAnswerRow
              key={answer.id}
              answer={answer}
              editingId={editingId}
              editText={editText}
              setEditingId={setEditingId}
              setEditText={setEditText}
              finishEditing={finishEditing}
              cancelEditing={cancelEditing}
              run={run}
              loadAnswers={loadAnswers}
            />
          ))}
          {visibleAnswers.length > 4 ? (
            <details className="rounded-md border border-border-subtle bg-surface p-3 text-sm">
              <summary className="cursor-pointer font-semibold text-primary-strong">Show {visibleAnswers.length - 4} more answers</summary>
              <div className="mt-3 space-y-3">
                {visibleAnswers.slice(4).map((answer) => (
                  <GuidedAnswerRow
                    key={answer.id}
                    answer={answer}
                    editingId={editingId}
                    editText={editText}
                    setEditingId={setEditingId}
                    setEditText={setEditText}
                    finishEditing={finishEditing}
                    cancelEditing={cancelEditing}
                    run={run}
                    loadAnswers={loadAnswers}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-border-default bg-surface-muted p-3 text-sm text-muted-2">
          Nothing known yet for this part. Answer it in Questions from AI, or upload a document that covers it in Onboarding.
        </div>
      )}
    </div>
  );
}

/**
 * How sure the AI has to be before its answer stops being worth a second look.
 *
 * 2026-09-03 (N-UX-12) — this number already existed, buried in the
 * "safe to approve" filter below. It is lifted out because the answer rows now
 * use it too: an answer at or above this bar shows no confidence badge at all,
 * and one below it says so and asks to be checked. Two places reading one
 * constant cannot drift into telling the operator different things about the
 * same answer.
 */
const CONFIDENT_ENOUGH = 0.75;

function GuidedAnswerRow({ answer, editingId, editText, setEditingId, setEditText, finishEditing, cancelEditing, run, loadAnswers }: {
  answer: KnowledgeQuestionAnswerItem;
  editingId: string;
  editText: string;
  setEditingId: (value: string) => void;
  setEditText: (value: string) => void;
  finishEditing: () => void;
  cancelEditing: () => void;
  run: Runner;
  loadAnswers: () => Promise<void>;
}) {
  const sources = answer.evidenceJson?.sources || [];
  // 2026-09-18 (session 57) — after a correction, the lines in the uploaded
  // documents that say something else are shown to the owner BEFORE anything is
  // retired. The system proposes; the owner disposes: it cannot reliably tell a
  // contradiction ("MOQ 50 kg") from a different case ("50 kg stocked, 100 kg
  // custom"), and retiring the wrong line deletes a true fact silently. State
  // lives here rather than in the screen because the panel belongs to one
  // answer and closes with it.
  const [supersedeFor, setSupersedeFor] = useState<{ answerId: string; replacedBy: string } | null>(null);
  const [supersedeCandidates, setSupersedeCandidates] = useState<SupersedeCandidate[]>([]);
  const [supersedeBusy, setSupersedeBusy] = useState("");
  return (
    <div className="border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{answer.question}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {/* 2026-09-25 — was a grey "answered" plus a grey "approved" on
                every row. One coloured badge now says what the row needs. */}
            <Badge tone={answerState(answer).tone}>{answerState(answer).label}</Badge>
            {/* 2026-09-03 (N-UX-12) — this used to print "N% confidence" on
                EVERY row. On a full Knowledge Base that was 72 identical
                percentages down one screen: 72 numbers that changed nothing
                about what the operator should do, and that drowned the handful
                that did. A percentage is only actionable when it is LOW, so it
                now appears only below the bar the "safe to approve" filter
                already uses — and when it appears it says what to do about it
                instead of leaving the reader to know what 17% means.

                The percentage itself is gone too, and that is the sharper half
                of the change. Hiding it above the bar was not enough: on a real
                workspace most answers sit BELOW the bar, so 72 rows still
                carried 72 numbers. Nobody acts differently at 17% than at 23% —
                the number was never the decision, "check this one" was. A number
                that cannot change what you do is decoration, and decoration in
                the same slot as real counts is what makes a screen unreadable. */}
            {(answer.confidenceScore || 0) < CONFIDENT_ENOUGH ? (
              <Badge tone="warning">Worth checking</Badge>
            ) : null}
            {sources.length > 1 ? <Badge>confirmed by {sources.length} sources</Badge> : null}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="btn secondary text-xs"
            onClick={() => { setEditingId(answer.id); }}
            aria-label={`Edit the answer to: ${answer.question}`}
          >
            Edit
          </button>
          {answer.answer && !answer.isUserApproved ? (
            <button
              className="btn secondary text-xs"
              onClick={() => run("Approve answer", async () => { await api(`/api/knowledge/question-answers/${answer.id}/approve`, { method: "PUT", body: { workspaceId } }); await loadAnswers(); })}
              aria-label={`Approve the answer to: ${answer.question}`}
            >
              Approve
            </button>
          ) : null}
        </div>
      </div>
      {editingId === answer.id ? (
        <div className="mt-2 space-y-2">
          {/* "boolean" questions deliberately stay free text: real answers in
              this workspace are full policy sentences ("Yes, credit is
              available only to approved customers, limit ₹2,00,000, 30-day
              terms...") not a plain Yes/No — a strict toggle would truncate
              real business detail on every edit. Only single_choice (a
              question with no nuance beyond which category applies, e.g.
              business_type) gets the dropdown. */}
          {/* 2026-09-04 N-UX-51 — neither control had a label. The question it
              belongs to is on screen right above it, so a sighted reader knows
              what is being edited; a screen-reader user landing on the field
              heard only "edit text". The question itself is the label, so it is
              attached as one rather than a new line of visible copy that would
              say the question twice. */}
          {answer.answerType === "single_choice" && answer.options?.length ? (
            <select className="input text-sm" aria-label={`Answer: ${answer.question}`} value={editText} onChange={(event) => setEditText(event.target.value)}>
              <option value="">Select an answer…</option>
              {answer.options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          ) : (
            <textarea className="input min-h-24 text-sm" aria-label={`Answer: ${answer.question}`} value={editText} onChange={(event) => setEditText(event.target.value)} autoFocus />
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn text-xs" onClick={() => run("Save question answer", async () => {
              const corrected = editText;
              await api(`/api/knowledge/question-answers/${answer.id}`, { method: "PUT", body: { workspaceId, answer: corrected, answerStatus: "answered" } });
              finishEditing();
              await loadAnswers();
              // Ask which uploaded lines this correction replaces. Read-only:
              // nothing is retired until the owner picks one below.
              const found = await api<{ candidates: SupersedeCandidate[] }>(`/api/knowledge/question-answers/${answer.id}/superseded-candidates`, { method: "PUT", body: { workspaceId } });
              if (found.candidates.length) {
                setSupersedeFor({ answerId: answer.id, replacedBy: corrected });
                setSupersedeCandidates(found.candidates);
              }
            })}>Save</button>
            <button className="btn secondary text-xs" onClick={cancelEditing}>Cancel</button>
          </div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-2">{answer.answer}</p>
      )}
      {supersedeFor?.answerId === answer.id && supersedeCandidates.length ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Your uploaded documents still say something else</p>
          <p className="mt-1 text-xs text-muted">
            These lines answer the same question. Until you retire one, the AI can still quote it to a customer.
            Retiring keeps the line on file — it stops being used, it is not deleted.
          </p>
          <ul className="mt-2 space-y-2">
            {supersedeCandidates.map((candidate) => (
              <li key={candidate.chunkId} className="rounded border border-amber-200 bg-white p-2">
                <p className="whitespace-pre-wrap text-sm">{candidate.text}</p>
                <p className="mt-1 text-xs text-muted">{candidate.sourceFileName || candidate.documentTitle || "Uploaded document"}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    className="btn text-xs"
                    disabled={supersedeBusy === candidate.chunkId}
                    onClick={() => run("Retire the old line", async () => {
                      setSupersedeBusy(candidate.chunkId);
                      try {
                        await api(`/api/knowledge/chunks/${candidate.chunkId}/retire`, {
                          method: "PUT",
                          body: { workspaceId, answerId: answer.id, replacedBy: supersedeFor.replacedBy },
                        });
                        setSupersedeCandidates((current) => current.filter((item) => item.chunkId !== candidate.chunkId));
                      } finally {
                        setSupersedeBusy("");
                      }
                    })}
                    aria-label={`Stop using this line from ${candidate.sourceFileName || "the uploaded document"}`}
                  >
                    Retire this line
                  </button>
                  <button
                    className="btn secondary text-xs"
                    onClick={() => setSupersedeCandidates((current) => current.filter((item) => item.chunkId !== candidate.chunkId))}
                  >
                    Keep it — both are true
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button className="btn secondary mt-2 text-xs" onClick={() => { setSupersedeFor(null); setSupersedeCandidates([]); }}>
            Done
          </button>
        </div>
      ) : null}
      {sources.length ? (
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer font-semibold text-primary-strong">View sources ({sources.length})</summary>
          <div className="mt-2 space-y-2">
            {sources.map((source, index) => (
              <div key={`${source.sourceType}-${source.sourceId || index}`} className="rounded-md bg-surface-muted p-2">
                <span className="font-semibold">{displayLabel(source.sourceType)}</span>
                {/* 2026-09-04 N-UX-48 — the stored title was printed raw here,
                    which is how `manual_text` kept reaching the screen even
                    after N-UX-11 put the guard on the document list. A source
                    title is stored text like any other, so it goes through the
                    same guard. The URL is left alone: it is meant to look like
                    a URL. */}
                {source.sourceTitle || source.sourceFileName || source.sourceUrl ? <span> - {source.sourceTitle ? displayStoredTitle(source.sourceTitle) : source.sourceFileName ? displayStoredTitle(source.sourceFileName) : source.sourceUrl}</span> : null}
                {source.sourceSnippet ? <p className="mt-1">{source.sourceSnippet.slice(0, 260)}</p> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function KnowledgeSearchResultView({ result }: { result: Record<string, unknown> }) {
  const chunks = (result.chunks as Array<Record<string, unknown>> | undefined) || [];
  const confidence = Number(result.confidenceScore || 0);
  return (
    <div className="mt-3 space-y-3">
      <Badge tone={chunks.length && confidence >= CONFIDENT_ENOUGH ? "success" : chunks.length ? "warning" : "danger"}>
        {chunks.length ? (confidence >= CONFIDENT_ENOUGH ? "The AI would find an answer" : "Found something, but not a sure match") : "Nothing found — the AI would ask you instead of guessing"}
      </Badge>
      {chunks.length ? chunks.map((chunk, index) => (
        <div key={String(chunk.id || index)} className="rounded-md border border-border-default bg-surface-muted p-3 text-sm">
          {/* 2026-09-04 N-UX-48 — a stored document title, so it goes through
              the same guard as every other one. */}
          <p className="text-xs font-semibold text-muted">{chunk.documentTitle ? displayStoredTitle(String(chunk.documentTitle)) : `Passage ${index + 1}`}</p>
          <p className="mt-2 text-muted-2">{String(chunk.chunkText || "").replace(/\*\*/g, "").slice(0, 420)}</p>
        </div>
      )) : <Empty text="No matching company knowledge was found. The AI should ask for human help instead of guessing." />}
    </div>
  );
}

function SyncSummaryPanel({ summary, onOpenSettings }: { summary: Record<string, unknown>; onOpenSettings: () => void }) {
  const settings = (summary.settings || {}) as Record<string, SettingsSyncSummaryView>;
  const kb = (summary.knowledgeBase || {}) as Record<string, unknown>;
  const profile = (summary.profile || {}) as Record<string, unknown>;
  const conflicts = Number(summary.conflictsPending || 0);
  const agentsAffected = Array.isArray(summary.agentsAffected) ? summary.agentsAffected.map(String) : [];
  const settingsItems = [
    settings.sales || { label: "Sales settings", status: "not_configured" },
    settings.products || { label: "Product settings", status: "not_configured" },
    settings.policy || { label: "Policy settings", status: "not_configured" },
    settings.communication || { label: "WhatsApp settings", status: "not_configured" },
  ];
  const notConfiguredCount = settingsItems.filter((item) => item.status === "not_configured").length;
  const failedCount = settingsItems.filter((item) => item.status === "failed").length;
  const syncedSettingsCount = settingsItems.filter((item) => item.status === "synced" || item.synced).length;
  const incomplete = summary.status === "partial" || summary.status === "failed";
  const sources = summary.sourcesIndexed as { indexed?: boolean; documents?: number; chunks?: number; failed?: number; error?: string } | undefined;
  return (
    <div className={`mt-3 rounded-md border p-3 text-sm ${incomplete ? "border-warning-bg bg-warning-bg" : "border-success-bg bg-surface-tint"}`}>
      <p className={`font-semibold ${incomplete ? "text-warning-fg" : "text-success-fg"}`}>{incomplete ? "Knowledge sync needs attention" : "Knowledge sync completed"}</p>
      {incomplete ? <p className="mt-1 text-muted-2">Some areas could not be refreshed. The details below show what worked and what needs another attempt.</p> : null}
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div className="rounded bg-surface p-2">
          <p className="text-xs text-muted">Business profile</p>
          <p className="text-foreground">{profile.synced ? `Synced (${(profile.chunks as number) || 0} chunks)` : `Skipped: ${String(profile.error || "no profile")}`}</p>
        </div>
        <div className="rounded bg-surface p-2">
          <p className="text-xs text-muted">Structured settings</p>
          <p className="text-foreground">{syncedSettingsCount} synced, {notConfiguredCount} not set yet, {failedCount} failed</p>
          <div className="mt-2 space-y-2">
            {settingsItems.map((item) => <SettingsSyncStatusRow key={item.label || item.status} item={item} />)}
          </div>
          {notConfiguredCount ? (
            <button className="btn secondary mt-3 text-xs" onClick={onOpenSettings}>
              <Settings className="h-4 w-4" /> Open Settings
            </button>
          ) : null}
        </div>
        <div className="rounded bg-surface p-2">
          <p className="text-xs text-muted">Knowledge Base</p>
          <p className="text-foreground">
            {kb.synced
              ? `${kb.blocksSynced || 0} answers synced, ${kb.sectionsSynced || 0} sections, ${kb.chunks || 0} chunks`
              : `Skipped: ${String(kb.error || "")}`}
          </p>
        </div>
        <div className="rounded bg-surface p-2">
          <p className="text-xs text-muted">Pending conflicts</p>
          <p className="text-foreground">{conflicts > 0 ? `${conflicts} conflict(s) need review in Settings > Conflicts` : "No open conflicts"}</p>
        </div>
        {sources ? <div className="rounded bg-surface p-2 md:col-span-2">
          <p className="text-xs text-muted">Uploaded documents in search</p>
          <p className="text-foreground">{sources.error ? `Could not refresh uploaded documents: ${sources.error}` : `${sources.documents || 0} documents refreshed${sources.failed ? `; ${sources.failed} could not be refreshed and need another attempt` : ""}`}</p>
        </div> : null}
        <div className="rounded bg-surface p-2 md:col-span-2">
          <p className="text-xs text-muted">Agent contexts updated</p>
          <p className="text-foreground">
            {agentsAffected.length
              ? `${agentsAffected.length} CRM agent context${agentsAffected.length === 1 ? "" : "s"} refreshed for safer answers, lead review, messaging, and campaign planning.`
              : "No agent context updates were reported."}
          </p>
          {agentsAffected.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {agentsAffected.map((agent) => <Badge key={agent}>{agent.replace(/-/g, " ")}</Badge>)}
            </div>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Attempted at {String(summary.timestamp || new Date().toISOString())}</p>
    </div>
  );
}

function SettingsSyncStatusRow({ item }: { item: SettingsSyncSummaryView }) {
  const status = item.status || (item.synced ? "synced" : "not_configured");
  const label = item.label || "Settings";
  const message = item.message || (status === "synced" ? `${label} synced.` : `${label} are not set yet.`);
  const pillText = status === "synced" ? "Synced" : status === "failed" ? "Needs attention" : "Not set yet";
  const pillClass = status === "synced"
    ? "border-success-bg bg-surface-tint text-success-fg"
    : status === "failed"
      ? "border-danger-bg bg-danger-bg text-danger-fg"
      : "border-warning-bg bg-warning-bg text-warning-fg";
  return (
    <div className="rounded-md border border-border-subtle bg-surface p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-foreground">{label}</p>
        <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${pillClass}`}>{pillText}</span>
      </div>
      <p className="mt-1 text-xs text-muted">{message}</p>
      {item.sourceDetails ? (
        <p className="mt-1 text-[11px] font-semibold uppercase text-muted">Reviewed Questions from AI vs direct Settings</p>
      ) : null}
      {item.sourceDetails?.message ? <p className="mt-1 text-xs text-muted-2">{item.sourceDetails.message}</p> : null}
      {item.sourceDetails?.reviewedDraftTitles?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.sourceDetails.reviewedDraftTitles.map((title) => <Badge key={title}>{title}</Badge>)}
        </div>
      ) : null}
      {item.action && status === "not_configured" ? <p className="mt-1 text-xs text-muted-2">{item.action}</p> : null}
      {item.error && status === "failed" ? <p className="mt-1 text-xs text-danger-fg">{item.error}</p> : null}
    </div>
  );
}

type DomainSummary = { domainKey: string; domainTitle: string; total: number; answered: number; partial: number; conflicts: number; missing: number; unapproved: number };

function groupQuestionAnswers(answers: KnowledgeQuestionAnswerItem[]) {
  const map = new Map<string, DomainSummary>();
  for (const answer of answers) {
    const current = map.get(answer.domainKey) || { domainKey: answer.domainKey, domainTitle: titleFromDomainKey(answer.domainKey), total: 0, answered: 0, partial: 0, conflicts: 0, missing: 0, unapproved: 0 };
    current.total += 1;
    // Same rule as the headline's "not known yet" (blank, unanswered or partial), inverted.
    if (answer.answerStatus !== "unanswered" && answer.answerStatus !== "partial" && answer.answer?.trim()) current.answered += 1;
    if (answer.answerStatus === "partial") current.partial += 1;
    if (answer.answerStatus === "conflict") current.conflicts += 1;
    if (answer.answerStatus === "unanswered") current.missing += 1;
    if ((answer.answerStatus === "answered" || answer.answerStatus === "needs_review" || answer.answerStatus === "partial") && answer.answer?.trim() && !answer.isUserApproved) current.unapproved += 1;
    map.set(answer.domainKey, current);
  }
  return Array.from(map.values());
}

/**
 * 2026-09-04 N-UX-36 — this Title-Cased every word itself and then patched one
 * known misspelling by hand ("Whatsapp" → "WhatsApp"). That hand-patch is the
 * tell: the same problem existed for every other word with a fixed spelling,
 * and "faqs" duly printed as "Faqs" across the domain grid. displayLabel is
 * the project's one place for turning a stored code into words, it already
 * knows these spellings, and it produces the sentence case the rest of the UI
 * uses ("Payment credit terms", not "Payment Credit Terms").
 */
function titleFromDomainKey(key: string) {
  // 2026-09-30: plain area names ("Payment and credit", not "Payment credit terms").
  return knowledgeAreaName(key);
}

/** One of the three (or four) parts of the total; pressing it filters the areas. */
function FilterChip({ tone, label, active, onClick }: { tone: "success" | "warning" | "neutral" | "danger"; label: string; active?: boolean; onClick?: () => void }) {
  const dot = { success: "bg-success-fg", warning: "bg-warning-fg", neutral: "bg-muted", danger: "bg-danger-fg" }[tone];
  const body = (
    <>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </>
  );
  if (!onClick) return <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1 text-sm text-foreground">{body}</span>;
  return (
    <button
      type="button"
      aria-pressed={Boolean(active)}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${active ? "border-primary bg-surface-tint font-semibold text-primary-strong" : "border-border-default text-foreground hover:bg-surface-muted"}`}
    >
      {body}
    </button>
  );
}

function answerState(answer: KnowledgeQuestionAnswerItem): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  if (answer.answerStatus === "conflict") return { label: "Answers disagree", tone: "danger" };
  if (answer.answerStatus === "not_applicable") return { label: "Does not apply", tone: "neutral" };
  if (answer.answerStatus === "unanswered") return { label: "Not known yet", tone: "neutral" };
  if (answer.isUserApproved) return { label: "Approved by you", tone: "success" };
  if (answer.answerStatus === "partial") return { label: "Half answered", tone: "warning" };
  return { label: "Waiting for your OK", tone: "warning" };
}
