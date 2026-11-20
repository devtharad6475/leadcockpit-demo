/**
 * Stage 5 / WP3 (2026-07-28) — Help & Support screen.
 *
 * The workspace user (owner/admin) side of the support flow. This is the
 * "raise a problem to the SaaS operator" inbox. The OPERATOR's inbox lives
 * separately at /admin (production-only, separate auth — see
 * src/services/PlatformAdminAuthService.ts).
 *
 * What this screen does (per docs/LOGIC.md 2026-07-28 Stage 5 WP3):
 *   - Lists the workspace's platform tickets (workspace-scoped read).
 *   - Opens a new ticket (owner/admin only — the route re-checks RBAC).
 *   - Shows a ticket's thread (created / commented / status_changed / ...).
 *   - Lets the user add a comment. A user comment on a resolved/closed ticket
 *     within 7 days REOPENS it; after 7 days the backend rejects it and we
 *     show the error + suggest opening a new ticket.
 *
 * SACRED no-auto-outreach: every action here is a logged-in human typing into
 * a form. Nothing sends anything to an external contact.
 *
 * Backend: /api/platform-tickets (list) · POST /api/platform-tickets (create) ·
 * GET /api/platform-tickets/:id · GET /api/platform-tickets/:id/events ·
 * POST /api/platform-tickets/:id/comments.
 *
 * Pinned: golden:platform-ticket (math), smoke:stage5-platform-ticket
 * (lifecycle), and a Playwright Golden Thread test (this screen renders a real
 * opened ticket + its category label).
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, Modal } from "@/components/ui";
import {
  displayPlatformTicketCategory,
  displayPlatformTicketStatus,
  displayPlatformTicketStatusTone,
  displayPlatformTicketEvent,
  displayTicketPriority,
  displayTicketPriorityTone,
} from "@/lib/display-labels";
import type {
  PlatformTicket,
  PlatformTicketCategory,
  PlatformTicketEvent,
  PlatformTicketPriority,
} from "@/lib/types";
import { LifeBuoy, Plus, MessageSquare, AlertCircle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";

const CATEGORIES: { value: PlatformTicketCategory; label: string; hint: string }[] = [
  { value: "bug", label: "Bug or error", hint: "Something is broken, crashing, or showing wrong data." },
  { value: "account", label: "Account or login", hint: "Can't sign in, locked out, or user management issue." },
  { value: "billing", label: "Billing or plan", hint: "Subscription, invoices, or plan limits." },
  { value: "how_to", label: "How-to question", hint: "You want to know how to do something in the app." },
  { value: "data_request", label: "My data request", hint: "Export, correction, or deletion of your data (DPDPA)." },
  { value: "other", label: "Something else", hint: "Anything not covered above." },
];

const PRIORITIES: PlatformTicketPriority[] = ["low", "medium", "high", "urgent"];

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateTime(d);
}

export function Help() {
  const [tickets, setTickets] = useState<PlatformTicket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<PlatformTicketEvent[]>([]);
  const [eventsTicketId, setEventsTicketId] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const threadRequest = useRef(0);
  const currentTicketId = useRef<string | null>(null);
  const listRequest = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  // S6 U-10 (auto-scroll check): on narrow viewports the list + detail stack.
  // Clicking a ticket must scroll to the detail, not leave the user on the list.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId]);

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api<PlatformTicket[]>(`/api/platform-tickets`);
      if (request === listRequest.current) setTickets(list);
    } catch (e) {
      if (request === listRequest.current) setError(e instanceof Error ? e.message : "Failed to load your support tickets");
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, []);

  const invalidateList = useCallback(() => { ++listRequest.current; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); invalidateList(); };
  }, [load, invalidateList]);

  const loadThread = useCallback(async (ticketId: string) => {
    if (currentTicketId.current !== ticketId) return;
    const request = ++threadRequest.current;
    setEventsTicketId(ticketId);
    setThreadLoading(true);
    setThreadError(null);
    setEvents([]);
    try {
      const rows = await api<PlatformTicketEvent[]>(`/api/platform-tickets/${ticketId}/events`);
      if (request === threadRequest.current) setEvents(rows);
    } catch (e) {
      if (request === threadRequest.current) setThreadError(e instanceof Error ? e.message : "Couldn't load this conversation.");
    } finally {
      if (request === threadRequest.current) setThreadLoading(false);
    }
  }, []);
  const invalidateThread = useCallback(() => { ++threadRequest.current; currentTicketId.current = null; }, []);
  useEffect(() => {
    currentTicketId.current = selectedId;
    const timer = window.setTimeout(() => { if (selectedId) void loadThread(selectedId); }, 0);
    return () => { window.clearTimeout(timer); invalidateThread(); };
  }, [selectedId, loadThread, invalidateThread]);

  const selected = tickets.find((t) => t.id === selectedId);

  // --- New ticket modal -----------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [formCategory, setFormCategory] = useState<PlatformTicketCategory>("bug");
  const [formSubject, setFormSubject] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPriority, setFormPriority] = useState<PlatformTicketPriority>("medium");

  function openCreate() {
    setFormCategory("bug");
    setFormSubject("");
    setFormDescription("");
    setFormPriority("medium");
    setCreateOpen(true);
    setCreateError(null);
    setError(null);
  }

  async function submitCreate() {
    if (busy) return;
    setCreateError(null);
    if (!formSubject.trim()) { setCreateError("Please add a short subject."); return; }
    if (!formDescription.trim()) { setCreateError("Please describe what happened."); return; }
    setBusy("Opening ticket...");
    try {
      const created = await api<PlatformTicket>(`/api/platform-tickets`, {
        method: "POST",
        body: {
          // workspaceId is resolved server-side from the session (never trusted
          // from the body); the route ignores it. We don't send it.
          subject: formSubject.trim(),
          description: formDescription.trim(),
          category: formCategory,
          priority: formPriority,
        },
      });
      setCreateOpen(false);
      await load();
      setSelectedId(created.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not open the ticket. Please try again.");
    } finally {
      setBusy("");
    }
  }

  // --- Add comment ----------------------------------------------------------
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const comment = selectedId ? commentDrafts[selectedId] || "" : "";
  function setComment(value: string) {
    if (selectedId) setCommentDrafts(previous => ({ ...previous, [selectedId]: value }));
  }

  async function submitComment() {
    if (!selectedId || !comment.trim()) return;
    setBusy("Sending comment...");
    setError(null);
    try {
      await api(`/api/platform-tickets/${selectedId}/comments`, {
        method: "POST",
        body: { note: comment.trim() },
      });
      setComment("");
      // Refresh both the ticket list (status may have changed on reopen) + thread.
      await load();
      await loadThread(selectedId);
    } catch (e) {
      // Backend rejects reopen-after-7d with a clear message; surface it.
      setError(e instanceof Error ? e.message : "Could not add your comment.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      {/* 2026-09-04 (N-UX-15) — this was a bordered card titled "Help & Support"
          sitting directly under a page heading reading "Help and support". The
          title was the page title again, spelt with an ampersand — which is why
          the walk's duplicate-title check, matching exact strings, did not see
          it. The card also carried a second "Open a ticket" button, identical
          to the one in the empty state below it.
          What is left is the part the page heading does not say: when someone
          answers, and how to make a sensitive request reach the right person. */}
      <p className="text-sm text-muted-2">
        Tell us what&rsquo;s wrong or what you need. We answer Monday to Saturday, 9:00&ndash;18:00 IST.
        For anything sensitive &mdash; pricing, payment, legal, or a data-deletion request &mdash; pick the
        matching category so it reaches the right person.
      </p>

      {error && (
        <div className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-2"><span>{error}</span><div><Button variant="secondary" onClick={() => void load()}>Try support list again</Button></div></div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : tickets.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title="No support tickets yet"
          description="If something breaks, or you have a question about your account, billing, or your data, open a ticket and we'll take it from there."
          action={<Button icon={Plus} onClick={openCreate}>Open your first ticket</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* List (left) */}
          <div className="lg:col-span-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground-muted">Your tickets ({tickets.length})</h3>
              {/* N-UX-52 (2026-09-05). The ONLY way to open a ticket used to be
                  the empty state's button, so the moment a workspace had one
                  ticket there was no way to raise a second — the screen that
                  exists for reporting problems stopped letting you report one.
                  The 2026-09-04 de-duplication removed the always-present
                  button and kept the empty-state one, which looked like the
                  same button twice and was not. Found by the e2e suite, whose
                  case is called "Help screen ALWAYS offers the Open a ticket
                  action"; it had been failing and unread. */}
              <div className="flex items-center gap-1">
                <Button icon={Plus} size="sm" onClick={openCreate}>Open a ticket</Button>
                <Button variant="ghost" size="sm" icon={RefreshCw} onClick={load} aria-label="Refresh tickets">
                  Refresh
                </Button>
              </div>
            </div>
            {tickets.map((t) => (
              <button
                key={t.id}
                onClick={() => { setSelectedId(t.id); setError(null); }}
                className={`w-full text-left rounded-md border p-3 transition-colors ${
                  selectedId === t.id
                    ? "border-primary bg-surface-tint"
                    : "border-border-default bg-surface hover:bg-surface-muted"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-foreground-muted">#{t.ticketNumber}</span>
                  <Badge tone={displayPlatformTicketStatusTone(t.status)}>
                    {displayPlatformTicketStatus(t.status)}
                  </Badge>
                </div>
                <div className="mt-1 font-medium text-sm text-foreground line-clamp-2">{t.subject}</div>
                <div className="mt-1 flex items-center gap-2 text-xs text-foreground-muted">
                  <span>{displayPlatformTicketCategory(t.category)}</span>
                  <span aria-hidden>·</span>
                  <Badge tone={displayTicketPriorityTone(t.priority)}>{displayTicketPriority(t.priority)}</Badge>
                </div>
              </button>
            ))}
          </div>

          {/* Detail (right) */}
          <div className="lg:col-span-3" ref={detailRef}>
            {!selected ? (
              <Card title="Ticket details" icon={MessageSquare}>
                <p className="text-sm text-foreground-muted">
                  Select a ticket on the left to see its details and conversation.
                </p>
              </Card>
            ) : (
              <Card title={`Ticket #${selected.ticketNumber}`} icon={MessageSquare}>
                <div className="space-y-3">
                  <div>
                    <div className="text-base font-semibold text-foreground">{selected.subject}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone={displayPlatformTicketStatusTone(selected.status)}>
                        {displayPlatformTicketStatus(selected.status)}
                      </Badge>
                      <Badge tone="neutral">{displayPlatformTicketCategory(selected.category)}</Badge>
                      <Badge tone={displayTicketPriorityTone(selected.priority)}>
                        {displayTicketPriority(selected.priority)}
                      </Badge>
                      <span className="text-foreground-muted">Opened {formatDate(selected.createdAt)}</span>
                    </div>
                  </div>

                  <div className="rounded-md bg-surface-muted p-3 text-sm text-foreground">
                    {selected.description}
                  </div>

                  {/* Thread */}
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-2">
                      Conversation
                    </h4>
                    {eventsTicketId !== selectedId || threadLoading ? (
                      <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading conversation…</p>
                    ) : threadError ? (
                      <div className="space-y-2">
                        <p role="alert" className="text-sm text-danger-fg">{threadError}</p>
                        <Button variant="secondary" onClick={() => void loadThread(selectedId!)}>Try conversation again</Button>
                      </div>
                    ) : events.length === 0 ? (
                      <p className="text-sm text-foreground-muted">No activity yet.</p>
                    ) : (
                      <ol className="space-y-3">
                        {events.map((ev) => {
                          const isUser = ev.actorType === "user";
                          const isComment = ev.eventType === "commented";
                          return (
                            <li key={ev.id} className="flex gap-3">
                              <div className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${isUser ? "bg-primary" : "bg-foreground-muted"}`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="text-xs font-medium text-foreground">
                                    {isComment
                                      ? (isUser ? "You" : "Support")
                                      : displayPlatformTicketEvent(ev.eventType)}
                                  </span>
                                  <span className="text-xs text-foreground-muted">{formatDate(ev.createdAt)}</span>
                                </div>
                                {ev.note ? (
                                  <p className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">{ev.note}</p>
                                ) : (
                                  <p className="mt-0.5 text-xs text-foreground-muted italic">
                                    {displayPlatformTicketEvent(ev.eventType)}
                                    {ev.toStatus ? ` → ${displayPlatformTicketStatus(ev.toStatus)}` : ""}
                                  </p>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>

                  {/* Reply box. Hidden once the ticket is closed AND past the
                      7-day reopen window would be enforced by the backend; we
                      still show it so the user can try (and get the clear
                      "open a new ticket" message if it's too late). */}
                  <div className="border-t border-border-default pt-3">
                    <label htmlFor="help-comment" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                      Add a reply
                    </label>
                    <textarea
                      id="help-comment"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      rows={3}
                      placeholder="Type your reply. If the ticket is resolved, replying within 7 days reopens it."
                      className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                    <div className="mt-2 flex justify-end">
                      <Button
                        onClick={submitComment}
                        loading={busy.startsWith("Sending")}
                        disabled={!comment.trim() || busy !== ""}
                      >
                        Send reply
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* New ticket modal */}
      <Modal
        open={createOpen}
        onClose={() => { if (!busy) setCreateOpen(false); }}
        title="Open a support ticket"
        disableDismiss={Boolean(busy)}
      >
        <fieldset disabled={Boolean(busy)} className="space-y-4">
          {createError && <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger-fg">{createError}</p>}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">
              What is this about?
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setFormCategory(c.value)}
                  className={`text-left rounded-md border p-2.5 transition-colors ${
                    formCategory === c.value
                      ? "border-primary bg-surface-tint"
                      : "border-border-default bg-surface hover:bg-surface-muted"
                  }`}
                >
                  <div className="text-sm font-medium text-foreground">{c.label}</div>
                  <div className="text-xs text-foreground-muted mt-0.5">{c.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="help-subject" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">
              Subject
            </label>
            <input
              id="help-subject"
              value={formSubject}
              onChange={(e) => setFormSubject(e.target.value)}
              placeholder="One line summary"
              className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="help-desc" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">
              Describe what happened
            </label>
            <textarea
              id="help-desc"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              rows={4}
              placeholder="What were you trying to do? What went wrong? Any error message you saw?"
              className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">
              How urgent is this?
            </label>
            <div className="flex flex-wrap gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  // N-A11Y-14 — which urgency is chosen was carried only by a
                  // border and background colour. This is a required choice on
                  // a support ticket, so "which one is selected" must be
                  // stated, not implied by paint.
                  aria-pressed={formPriority === p}
                  onClick={() => setFormPriority(p)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    formPriority === p
                      ? "border-primary bg-surface-tint text-foreground"
                      : "border-border-default bg-surface text-foreground-muted hover:bg-surface-muted"
                  }`}
                >
                  {displayTicketPriority(p)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} loading={busy.startsWith("Opening")} disabled={busy !== ""}>
              Open ticket
            </Button>
          </div>
        </fieldset>
      </Modal>
    </div>
  );
}
