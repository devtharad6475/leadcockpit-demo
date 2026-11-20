/**
 * D-2026-09-27-b (CEO) — "Replies the AI may send by itself".
 *
 * One tick box per kind of question the AI may answer alone when a customer
 * messages first, each with its trial record: how many AI drafts of that kind
 * the owner reviewed and how many went out without a change. A kind can be
 * ticked once the trial proves it (the server checks too). The locked kinds
 * are listed so the owner knows they always come to them.
 * Plan: docs/planning/AUTO-REPLY-PLAN.md.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Badge, Checkbox } from "@/components/ui";
import { api } from "@/lib/api-client";
import { displayReplyClassification } from "@/lib/display-labels";

type TrialRecord = {
  topic: string;
  reviewed: number;
  sentUnchanged: number;
  sentChanged: number;
  rejected: number;
  sentByAi: number;
  proven: boolean;
};
type TrialResponse = { records: TrialRecord[]; minReviewed: number; minUnchangedShare: number; windowDays: number };

const LOCKED = ["price_request", "payment_question", "delivery_question", "return_question", "complaint", "customization_question", "export_question", "bulk_order_interest"];

export function AutoReplyTopicsPanel({ topics, onChange, automaticMode }: { topics: string[]; onChange: (next: string[]) => void; automaticMode: boolean }) {
  const [trial, setTrial] = useState<TrialResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<TrialResponse>("/api/whatsapp-agent/auto-reply-trial").then(setTrial).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the trial record."));
  }, []);

  function toggle(topic: string, on: boolean) {
    onChange(on ? [...new Set([...topics, topic])] : topics.filter((item) => item !== topic));
  }

  const share = trial ? Math.round(trial.minUnchangedShare * 100) : 90;
  return (
    <div className="mt-4 rounded-md border border-border-default bg-surface-muted p-3" data-testid="auto-reply-topics">
      <p className="text-sm font-medium">Replies the AI may send by itself</p>
      <p className="mt-1 text-xs text-muted">
        When a customer messages you first, the AI can answer these kinds of question without waiting for you.
        A kind can be switched on after you have reviewed at least {trial?.minReviewed ?? 10} of its drafts and sent {share}% of them without changes
        (last {trial?.windowDays ?? 60} days). {automaticMode ? "" : "Nothing is sent by itself until the mode above is set to automatic replies."}
      </p>
      {error ? <p className="mt-2 text-xs text-danger-fg">{error}</p> : null}
      <ul className="mt-2 space-y-1">
        {(trial?.records ?? []).map((record) => {
          const on = topics.includes(record.topic);
          const canTick = on || record.proven;
          return (
            <li key={record.topic} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Checkbox
                label={displayReplyClassification(record.topic)}
                checked={on}
                disabled={!canTick}
                onChange={(checked) => toggle(record.topic, checked)}
              />
              <span className="text-xs text-muted tabular-nums">
                {record.reviewed === 0
                  ? "No drafts reviewed yet"
                  : `${record.reviewed} reviewed · ${record.sentUnchanged} sent as written · ${record.sentChanged} changed · ${record.rejected} not sent`}
                {record.sentByAi > 0 ? ` · ${record.sentByAi} sent by the AI` : ""}
              </span>
              {on ? <Badge tone="success">On</Badge> : record.proven ? <Badge tone="info">Ready</Badge> : <Badge tone="neutral">Still in trial</Badge>}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Always wait for you: {LOCKED.map((category) => displayReplyClassification(category).toLowerCase()).join(", ")}, abusive messages, opt-outs, and anything the AI isn&apos;t sure of.
      </p>
    </div>
  );
}
