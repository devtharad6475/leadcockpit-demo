/**
 * 2026-09-28 — the owner's mark on a reply the AI sent BY ITSELF, in the
 * Replies inbox. Either mark feeds the trial record; "should not have sent"
 * also switches that kind of reply off for this company until a fresh trial.
 */
"use client";
import React from "react";
import { Button } from "@/components/ui";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Runner } from "@/app/page";
import { workspaceId } from "@/app/page";

export function AutoReplyMark({ log, run, reload }: { log: { id: string; status: string; ownerVerdict?: string }; run: Runner; reload?: () => void }) {
  if (log.status !== "auto_sent") return null;
  const mark = (verdict: "looked_fine" | "should_not_have_sent") => run(
    verdict === "looked_fine" ? "Marked as fine" : "Marked — this kind now waits for you",
    async () => {
      await api(`/api/auto-reply-logs/${log.id}/mark`, { method: "POST", body: { workspaceId, verdict } });
      reload?.();
    },
  );
  return (
    <div className="mt-4 rounded-lg border border-border-default bg-surface-muted p-3" data-testid="auto-reply-mark">
      <p className="text-sm font-medium text-foreground">The AI sent this reply by itself. Was it right?</p>
      {log.ownerVerdict ? (
        <p className="mt-1 text-xs text-muted">
          You marked it: {log.ownerVerdict === "looked_fine" ? "looked fine." : "should not have sent. Replies of this kind now wait for you."}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">Your answer counts in the trial. &ldquo;Should not have sent&rdquo; stops the AI answering this kind of question by itself.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant={log.ownerVerdict === "looked_fine" ? "primary" : "secondary"} icon={ThumbsUp} onClick={() => mark("looked_fine")}>Looked fine</Button>
        <Button variant={log.ownerVerdict === "should_not_have_sent" ? "primary" : "secondary"} icon={ThumbsDown} onClick={() => mark("should_not_have_sent")}>Should not have sent</Button>
      </div>
    </div>
  );
}
