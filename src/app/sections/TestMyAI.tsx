/**
 * "Test my AI" — on the Knowledge Base screen (2026-09-28).
 *
 * The owner types a question the way a customer would and sees three things:
 * the reply the AI would give, which knowledge it read (and whether each line
 * is one they approved), and whether a real message like this would go out by
 * itself or wait for them.
 *
 * It calls the same test path as the WhatsApp Agent's "try it" button
 * (POST /api/whatsapp-agent/dry-run), which runs the real reply engine with
 * every write and every send switched off. No new endpoint, no second copy of
 * the reply logic — so what this box shows is what a customer would get.
 */
"use client";
import React, { useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { FlaskConical, Send } from "lucide-react";
import { api } from "@/lib/api-client";
import { workspaceId } from "@/app/page";
import { plainTestReasons } from "@/lib/test-my-ai-reasons";

type KnowledgeUsedLine = { source: string; line: string; approved: boolean; score: number };

type DryRunResult = {
  suggestedReply?: string;
  canAutoSend?: boolean;
  needsHumanReview?: boolean;
  blocked?: boolean;
  reason?: string;
  dryRun?: boolean;
  llm?: { mode?: "real" | "mock" | "fallback" | "unknown" };
  wouldHave?: { sentByItself?: boolean };
  knowledgeUsed?: KnowledgeUsedLine[];
};

export function TestMyAI() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ asked: string; data: DryRunResult } | null>(null);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<DryRunResult>("/api/whatsapp-agent/dry-run", { method: "POST", body: { workspaceId, rawText: text } });
      setResult({ asked: text, data });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The test did not run. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const data = result?.data;
  // Two outcomes matter to the owner: it goes out on its own, or it waits for
  // them. A blocked reply also lands in their queue, so it is "waits for you".
  const verdict = !data
    ? null
    : data.wouldHave?.sentByItself
      ? { tone: "success" as const, text: "Would go out by itself." }
      : { tone: "warning" as const, text: "Would wait for you to approve it." };

  return (
    <Card
      title="Test my AI"
      icon={FlaskConical}
      action={<Badge tone="info">Nothing is sent</Badge>}
    >
      <form onSubmit={ask} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="test-my-ai-question" className="sr-only">A question a customer might ask</label>
        <input
          id="test-my-ai-question"
          className="input min-w-0 flex-1"
          placeholder="Type a customer question — e.g. Do you ship to Dubai?"
          maxLength={500}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button type="submit" icon={Send} loading={busy} disabled={!question.trim()} className="sm:shrink-0">
          See the AI&apos;s reply
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted">
        A test only. Nothing is sent to anyone and nothing changes in your leads or inbox.
      </p>

      {error ? <p className="mt-3 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg" role="alert">{error}</p> : null}

      {data && result ? (
        <div className="mt-4 space-y-3" aria-live="polite">
          <div className="flex justify-start">
            <p className="max-w-[85%] rounded-2xl rounded-tl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-foreground">{result.asked}</p>
          </div>
          <div className="flex justify-end">
            <div className="max-w-[85%]">
              <p className="whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-border-default bg-surface-tint px-3.5 py-2.5 text-sm text-foreground">
                {data.suggestedReply || "The AI did not write a reply."}
              </p>
              {data.llm?.mode && data.llm.mode !== "real" ? (
                <p className="mt-1 text-right text-xs text-warning-fg">
                  {data.llm.mode === "mock" ? "Sample reply — no live AI is connected, so the wording is a placeholder." : "Written by the backup, not your main AI."}
                </p>
              ) : null}
            </div>
          </div>

          {verdict ? (
            <div className="rounded-lg border border-border-default bg-surface-muted p-3">
              <Badge tone={verdict.tone}>{verdict.text}</Badge>
              {data.wouldHave?.sentByItself ? (
                <p className="mt-2 text-xs text-muted">Tested as a message from someone who is not one of your saved customers.</p>
              ) : (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-2">
                  {plainTestReasons({ reason: data.reason, knowledgeUsed: data.knowledgeUsed }).map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
            </div>
          ) : null}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Knowledge it read</p>
            {data.knowledgeUsed && data.knowledgeUsed.length ? (
              <ul className="mt-2 space-y-2">
                {data.knowledgeUsed.map((item, index) => (
                  <li key={`${item.source}-${index}`} className="rounded-lg border border-border-subtle bg-surface p-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-words font-medium text-foreground">{item.source}</span>
                      <Badge tone={item.approved ? "success" : "warning"}>{item.approved ? "Approved by you" : "Not approved yet"}</Badge>
                    </div>
                    {item.line ? <p className="mt-1 break-words text-xs leading-relaxed text-muted-2">{item.line}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-2">
                Nothing in your knowledge base matched. The AI has nothing of yours to go on for this question — answer it in a section below.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
