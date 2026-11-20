"use client";
/**
 * command-center-parts.tsx — the pieces of the Command Center (2026-09-24, v2).
 *
 * v2 follows the owner's review ("the screen should be visible and look clean;
 * things should be behind buttons") and the research on file:
 *   - NN/g progressive disclosure: show the few things needed now; put the
 *     rest behind clearly labelled buttons.
 *   - docs/UI-UX-RESEARCH-FINDINGS.md: detail in a slide-over, not stacked on
 *     the page; AI reasoning collapsed until asked for.
 * So a plan shows one line per step, a finished job leads with its report, and
 * each helper's full findings open in a side panel.
 */
import { formatDateTime } from "@/lib/format-date";
import React, { useState } from "react";
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, CircleDashed, Loader2,
  MinusCircle, PauseCircle, ShieldCheck, Sparkles, XCircle,
} from "lucide-react";
import { Badge, Button, Drawer, DrawerBody } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

export type Subtask = { id: string; agent: string; instruction: string; dependsOn: string[] };
export type Plan = { summary: string; subtasks: Subtask[] };
export type OutcomeStatus = "done" | "incomplete" | "failed" | "skipped" | "waiting_for_you";
export type Outcome = { id: string; agent: string; instruction: string; status: OutcomeStatus; detail: string; llmCalls: number };
export type TeamMember = { name: string; label: string; summary: string };
export type JobSummary = { jobId: string; goal: string; status: string; steps: number; maxCalls: number; llmCalls?: number; createdAt?: string };
export type JobRecord = {
  id: string;
  status: string;
  errorMessage?: string;
  payload?: { goal?: string; plan?: Plan; problems?: string[]; maxCalls?: number; maxSearches?: number };
  result?: {
    progress?: { outcomes: Outcome[]; running: string[]; llmCalls: number };
    summary?: string;
    outcomes?: Outcome[];
    llmCalls?: number;
    text?: string;
  };
};
export type Busy = "planning" | "starting" | "discarding" | "stopping" | "copying" | null;

export const JOB_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  awaiting_confirmation: { label: "Waiting for your go-ahead", tone: "info" },
  running: { label: "Working", tone: "info" },
  cancelling: { label: "Stopping", tone: "warning" },
  completed: { label: "Finished", tone: "success" },
  partial: { label: "Partly finished", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Could not plan", tone: "warning" },
  cancelled: { label: "Discarded", tone: "neutral" },
};

type StepKey = OutcomeStatus | "running" | "queued";
const STEP_STATUS: Record<StepKey, { label: string; tone: BadgeTone; icon: React.ComponentType<{ className?: string }> }> = {
  queued: { label: "Queued", tone: "neutral", icon: CircleDashed },
  running: { label: "Working", tone: "info", icon: Loader2 },
  done: { label: "Done", tone: "success", icon: CheckCircle2 },
  incomplete: { label: "Stopped early", tone: "warning", icon: PauseCircle },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  skipped: { label: "Skipped", tone: "neutral", icon: MinusCircle },
  waiting_for_you: { label: "Needs you", tone: "warning", icon: AlertTriangle },
};

export function jobStatus(status: string) {
  return JOB_STATUS[status] || { label: status, tone: "neutral" as BadgeTone };
}

export function when(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatDateTime(date);
}

/** The first sentence of a long instruction, for the one-line step view. */
function firstSentence(text: string) {
  const match = text.match(/^(.{20,160}?[.:;])(\s|$)/);
  // No sentence end within reach: the line clamp adds a clean "…" rather than cutting mid-word.
  return (match ? match[1] : text).replace(/[:;]$/, "");
}

/**
 * The master's report arrives as plain text with ALL-CAPS headings and "- "
 * bullets. Typeset it instead of printing a wall of text; never alter a word.
 */
export function ReportText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (key: string) => {
    if (!bullets.length) return;
    blocks.push(
      <ul key={key} className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-foreground marker:text-muted">
        {bullets.map((item, index) => <li key={index}>{item}</li>)}
      </ul>,
    );
    bullets = [];
  };
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) { flush(`u${index}`); return; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush(`u${index}`);
      blocks.push(<hr key={`r${index}`} className="my-1 border-border-subtle" />);
      return;
    }
    const bullet = line.match(/^[-•*]\s+(.*)$/) || line.match(/^\d+\.\s+(.*)$/);
    if (bullet) { bullets.push(bullet[1].replace(/\*\*/g, "")); return; }
    flush(`u${index}`);
    const plain = line.replace(/\*\*/g, "");
    const isHeading = (/^[A-Z0-9 ,'&()/-]{4,}:?$/.test(plain) && /[A-Z]{3}/.test(plain)) || /^#{1,3}\s/.test(line);
    if (isHeading) {
      blocks.push(<h3 key={`h${index}`} className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted">{plain.replace(/^#+\s*/, "").replace(/:$/, "")}</h3>);
    } else {
      blocks.push(<p key={`p${index}`} className="text-sm leading-relaxed text-foreground">{plain}</p>);
    }
  });
  flush("u-end");
  return <div className="flex flex-col gap-2">{blocks}</div>;
}

/** The planner names steps by id ("returned by t1"); the owner sees "step 1". */
function plainStepRefs(text: string, number: Map<string, number>): string {
  return text.replace(/\b(t\d+)\b/g, (match) => (number.has(match) ? `step ${number.get(match)}` : match));
}

/** The plan, as one line per step. Full instructions only when asked for. */
export function PlanSteps({ job, labelFor, onOpenStep }: {
  job: JobRecord;
  labelFor: (agent: string) => string;
  onOpenStep: (outcome: Outcome) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const plan = job.payload?.plan;
  if (!plan) return null;
  const progress = job.result?.progress;
  const outcomes = job.result?.outcomes || progress?.outcomes || [];
  const number = new Map(plan.subtasks.map((task, index) => [task.id, index + 1]));
  const showStatus = !["awaiting_confirmation", "cancelled"].includes(job.status);

  return (
    <div className="flex flex-col gap-1">
      <ol className="flex flex-col divide-y divide-border-subtle" aria-label="The plan">
        {plan.subtasks.map((task, index) => {
          const outcome = outcomes.find((item) => item.id === task.id);
          const key: StepKey = outcome ? outcome.status : job.status === "running" && progress?.running.includes(task.id) ? "running" : "queued";
          const look = STEP_STATUS[key];
          const Icon = look.icon;
          return (
            <li key={task.id} className="flex items-start gap-3 py-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-foreground tabular-nums">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">
                  <span className="font-semibold">{labelFor(task.agent)}</span>
                  {task.dependsOn.length ? <span className="text-muted"> · after step {task.dependsOn.map((dep) => number.get(dep) ?? dep).join(" & ")}</span> : null}
                </p>
                <p className={`mt-0.5 text-sm leading-relaxed text-muted ${showDetails ? "" : "line-clamp-1"}`}>
                  {plainStepRefs(showDetails ? task.instruction : firstSentence(task.instruction), number)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {showStatus ? (
                  <Badge tone={look.tone} className="gap-1">
                    <Icon className={`h-3 w-3 ${key === "running" ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
                    {look.label}
                  </Badge>
                ) : null}
                {outcome?.detail ? (
                  <Button variant="ghost" size="sm" onClick={() => onOpenStep(outcome)}>View</Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        onClick={() => setShowDetails((value) => !value)}
        aria-expanded={showDetails}
        className="flex w-fit items-center gap-1 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`} aria-hidden="true" />
        {showDetails ? "Hide full instructions" : "Show full instructions"}
      </button>
    </div>
  );
}

/** "2 of 4 steps done" — the one number that matters while a job runs. */
export function RunProgress({ job }: { job: JobRecord }) {
  const total = job.payload?.plan?.subtasks.length || 0;
  const finished = (job.result?.outcomes || job.result?.progress?.outcomes || []).length;
  const percent = total ? Math.round((finished / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          The team is working
        </span>
        <span className="text-muted tabular-nums">{finished} of {total} steps done</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished} aria-label="Steps finished">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Folded "How it was done" section under a finished report. */
export function HowItWasDone({ job, labelFor, onOpenStep }: {
  job: JobRecord;
  labelFor: (agent: string) => string;
  onOpenStep: (outcome: Outcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const steps = job.payload?.plan?.subtasks.length || 0;
  return (
    <div className="border-t border-border-subtle pt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded text-left text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-primary"
      >
        How it was done · {steps} step{steps === 1 ? "" : "s"}
        <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open ? <div className="mt-2"><PlanSteps job={job} labelFor={labelFor} onOpenStep={onOpenStep} /></div> : null}
    </div>
  );
}

/** One helper's full findings, in a side panel. */
export function StepDrawer({ outcome, labelFor, onClose }: { outcome: Outcome | null; labelFor: (agent: string) => string; onClose: () => void }) {
  const look = outcome ? STEP_STATUS[outcome.status] : null;
  return (
    <Drawer open={Boolean(outcome)} onOpenChange={(open) => { if (!open) onClose(); }} title={outcome ? `What the ${labelFor(outcome.agent).toLowerCase()} found` : "Step"} size="lg">
      <DrawerBody>
        {outcome && look ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Badge tone={look.tone}>{look.label}</Badge>
              <span className="text-xs text-muted tabular-nums">{outcome.llmCalls} AI call{outcome.llmCalls === 1 ? "" : "s"}</span>
            </div>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Findings</h3>
              <ReportText text={outcome.detail} />
            </section>
            <section className="flex flex-col gap-2 rounded-lg bg-surface-muted p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">What the master asked for</h3>
              <p className="text-sm leading-relaxed text-foreground">{outcome.instruction}</p>
            </section>
          </div>
        ) : null}
      </DrawerBody>
    </Drawer>
  );
}

/** The team, in a side panel instead of a permanent column. */
export function TeamDrawer({ open, onOpenChange, team }: { open: boolean; onOpenChange: (open: boolean) => void; team: TeamMember[] }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Your AI team" description="The master plans; each helper does one kind of work." size="md">
      <DrawerBody>
        <ul className="flex flex-col gap-4">
          <li className="flex gap-3 rounded-lg bg-surface-tint p-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">Master AI</p>
              <p className="text-sm leading-relaxed text-muted">Plans the job, gives each part to a helper, and writes you the report.</p>
            </div>
          </li>
          {team.map((member) => (
            <li key={member.name} className="flex gap-3 px-3">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-foreground">{member.label}</p>
                <p className="text-sm leading-relaxed text-muted">{member.summary}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-fg" aria-hidden="true" />
          None of them can send a message, approve or reject a lead, or change your data. Messages come back as drafts. Only the market researcher spends money beyond AI calls — a few web searches, shown on the plan before you approve it.
        </p>
      </DrawerBody>
    </Drawer>
  );
}

/** Past jobs, in a side panel. */
export function HistoryDrawer({ open, onOpenChange, jobs, error, selectedId, onSelect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobs: JobSummary[];
  error: string | null;
  selectedId?: string;
  onSelect: (jobId: string) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Past jobs" size="md">
      <DrawerBody className="px-0 py-0">
        {error ? <p className="p-5 text-sm text-danger-fg">{error}</p> : jobs.length === 0 ? (
          <p className="p-5 text-sm text-muted">No jobs yet. Your first one will appear here.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {jobs.map((summary) => {
              const status = jobStatus(summary.status);
              return (
                <li key={summary.jobId}>
                  <button
                    type="button"
                    onClick={() => onSelect(summary.jobId)}
                    aria-current={selectedId === summary.jobId ? "true" : undefined}
                    className={`flex w-full flex-col gap-1.5 px-5 py-3.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-primary ${selectedId === summary.jobId ? "bg-surface-tint" : ""}`}
                  >
                    <span className="line-clamp-2 text-sm text-foreground">{summary.goal || "(no description)"}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-xs text-muted tabular-nums">{when(summary.createdAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DrawerBody>
    </Drawer>
  );
}

/** The bar under a plan: what it can cost, the promise, and the two choices. */
export function DecisionBar({ maxCalls, maxSearches = 0, busy, onRun, onDiscard }: { maxCalls: number; maxSearches?: number; busy: Busy; onRun: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-muted px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="h-3.5 w-3.5 text-success-fg" aria-hidden="true" />
        Uses up to {maxCalls} AI calls{maxSearches ? ` and up to ${maxSearches} paid web searches` : ""}. Nothing is sent to customers.
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onDiscard} loading={busy === "discarding"} disabled={busy !== null}>Discard</Button>
        <Button onClick={onRun} loading={busy === "starting"} disabled={busy !== null} icon={ArrowRight} iconPosition="right">Run this plan</Button>
      </div>
    </div>
  );
}
