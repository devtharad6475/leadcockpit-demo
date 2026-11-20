/**
 * 2026-07-21 (M6) — Tickets screen.
 *
 * Per docs/UI-DESIGN.md M6: a unified inbox pattern (list on the left,
 * detail on the right). Replaces the "no UI" gap from the audit.
 *
 * Backend: src/services/TicketService.ts + the new /api/tickets endpoints
 * (GET list, GET :id, GET :id/events, GET sla-settings, POST :id/status,
 * POST :id/assign).
 *
 * Uses the new design system (Card, Button, Badge, EmptyState) + the
 * displayLabel map (so "in_progress" shows as "In progress", not raw).
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useEffect, useRef, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, Modal } from "@/components/ui";
import {
  displayTicketStatus, displayTicketPriority, displayTicketPriorityTone,
  displayLabel,
} from "@/lib/display-labels";
import type { Ticket, TicketEvent, Order, Quote, Lead, WorkspaceRole } from "@/lib/types";
import { Inbox, Ticket as TicketIcon, AlertCircle, Plus, ExternalLink } from "lucide-react";
// Stage A+ / Cluster 10a (P2-3): shared api() chokepoint.
import { api } from "@/lib/api-client";
import { formatWaitingFor } from "@/lib/format";

type TicketWithLive = Ticket & { liveBreached?: boolean; liveRemainingMinutes?: number };
type ClosureDraft = { id: string; body: string; status: string; sendStatus?: string; createdAt: string; ticketId: string; leadId: string };
type ClosureEditor = { draft: ClosureDraft | null; body: string; loading: boolean; error: string | null; loaded: boolean; replace: boolean; dirty: boolean };
const emptyClosureEditor: ClosureEditor = { draft: null, body: "", loading: false, error: null, loaded: false, replace: false, dirty: false };

/**
 * 2026-09-08 — who is handling this ticket.
 *
 * This screen's own subtitle says it shows "who is handling each one". The
 * server has had `POST /api/tickets/:id/assign` since M6 — this file's header
 * comment lists it — and `TicketService` has three assignment modes. Nothing in
 * the product ever called any of it: the detail pane rendered a bare "Assigned"
 * badge that could not be reached, because there was no control that set
 * `assignedTo`. Found by working a ticket in the live demo.
 *
 * Only an ACTIVE member can be assigned. An invited member has no User row yet
 * (`userId` is null until they accept), and on Postgres writing that id is a
 * foreign-key violation, so offering them would be offering a crash.
 */
type AssignableMember = { id: string; userId: string | null; email: string; name?: string; role: string; status: string };

// (Stage A+ / Cluster 10a) local api() removed — imported from @/lib/api-client.

// `TabId` mirrors the string union in page.tsx; kept loose here to avoid a
// circular type import. onFocusLead jumps the operator to the lead's CRM
// record (the "Everything Connected" rule — bidirectional A↔B links).
export function Tickets({ workspaceId, focusLeadId, focusAssigneeId, onClearAssignee, onFocusLead, onReviewReplies, currentUserId, role = "owner" }: { workspaceId: string; focusLeadId?: string; focusAssigneeId?: string; onClearAssignee?: () => void; onFocusLead?: (leadId: string, section: "crm" | "replies") => void; onReviewReplies?: (leadId: string) => Promise<void>; currentUserId?: string; role?: WorkspaceRole }) {
  const canMutate = role !== "viewer";
  const [workView, setWorkView] = useState<"mine" | "all">((role === "admin" || role === "sales_member") && currentUserId ? "mine" : "all");
  const [workStatus, setWorkStatus] = useState<"all" | "unfinished" | "settled">("all");
  const [statusDialog, setStatusDialog] = useState<{ ticketId: string; toStatus: Ticket["status"] } | null>(null);
  const [statusNote, setStatusNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  // Working text belongs to a ticket, not the currently visible detail pane.
  // This cache lasts only while this Tickets screen remains mounted.
  const [closureEditors, setClosureEditors] = useState<Record<string, ClosureEditor>>({});
  const closureReadVersions = useRef<Record<string, number>>({});
  const [savingClosureId, setSavingClosureId] = useState<string | null>(null);
  const [closureVersion, setClosureVersion] = useState(0);
  const [tickets, setTickets] = useState<TicketWithLive[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const closureEditor = selectedId ? closureEditors[selectedId] || emptyClosureEditor : emptyClosureEditor;
  const { draft: closureDraft, body: closureBody, loading: closureLoading, error: closureError, replace: replaceClosure } = closureEditor;
  const closureLoadedId = closureEditor.loaded ? selectedId : null;
  function updateClosure(ticketId: string, update: (current: ClosureEditor) => ClosureEditor) {
    setClosureEditors(editors => ({ ...editors, [ticketId]: update(editors[ticketId] || emptyClosureEditor) }));
  }
  function setClosureError(error: string | null) {
    if (selectedId) updateClosure(selectedId, current => ({ ...current, error }));
  }
  function setReplaceClosure(replace: boolean) {
    if (selectedId) updateClosure(selectedId, current => ({ ...current, replace }));
  }
  function setClosureBody(body: string, dirty = true) {
    if (selectedId) updateClosure(selectedId, current => ({ ...current, body, dirty }));
  }
  // S6 U-10: on narrow viewports the list/detail stack vertically. Without
  // auto-scroll, clicking a ticket leaves the user staring at the list while
  // the detail renders below the fold. This ref + effect scrolls the detail
  // into view when a ticket is selected (desktop lg+ layout is side-by-side,
  // so we only scroll below the lg breakpoint).
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId]);
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [eventsTicketId, setEventsTicketId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
    // 2026-08-05 E-P1-1: action errors show inline (list stays visible), not full-screen wipe.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [members, setMembers] = useState<AssignableMember[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await api<Ticket[]>(`/api/tickets`);
      setTickets(list);
      // 2026-09-04 N-UX-22 — half this screen was an empty "Select a ticket"
      // box on every visit, because nothing was ever selected for you. The
      // list is already sorted with the ticket that needs attention first, so
      // open that one. Only when nothing is selected: a reload after changing
      // a status must not throw the operator off the ticket they are working.
      setSelectedId((current) => current && list.some(ticket => ticket.id === current) ? current : list.find(ticket => (!focusLeadId || ticket.leadId === focusLeadId) && (focusAssigneeId ? ticket.assignedTo === focusAssigneeId && !["resolved", "closed"].includes(ticket.status) : workView === "all" || ticket.assignedTo === currentUserId))?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tickets");
    } finally {
      setLoading(false);
    }
    // N-P1-2 (2026-08-07): fetched alongside tickets (not lazily on modal
    // open) so the "Order #N" / "Quote #N" badge on an already-linked
    // ticket's detail view resolves on first load, not only after the
    // operator happens to open the New Ticket modal once.
    api<Order[]>(`/api/orders`).then(setOrders).catch(() => setOrders([]));
    api<Quote[]>(`/api/quotes`).then(setQuotes).catch(() => setQuotes([]));
    api<AssignableMember[]>(`/api/workspace-members`).then(setMembers).catch(() => setMembers([]));
  }

  /** Who this ticket is assigned to, in words the operator recognises. */
  function memberLabel(userId: string | null | undefined) {
    if (!userId) return "";
    const member = members.find((m) => m.userId === userId);
    return member ? member.name || member.email : "Former team member";
  }

  async function assignTicket(ticketId: string, assignedTo: string) {
    if (!canMutate) return;
    setBusy("Assigning...");
    setActionError(null);
    try {
      await api(`/api/tickets/${ticketId}/assign`, {
        method: "POST",
        // Empty string means "unassign" — the route writes it straight through,
        // and only a truthy value records an "assigned" event.
        body: { assignedTo: assignedTo || undefined },
      });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to assign this ticket");
    } finally {
      setBusy("");
    }
  }

  useEffect(() => { load(); }, []);

  // Refresh history after mutations as well as selection; ignore a late
  // response belonging to a previously selected ticket.
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    api<TicketEvent[]>(`/api/tickets/${selectedId}/events`)
      .then(rows => { if (active) { setEvents(rows); setEventsTicketId(selectedId); } })
      .catch(() => { if (active) { setEvents([]); setEventsTicketId(selectedId); setActionError("Could not load this ticket's history. Refresh to try again."); } });
    return () => { active = false; };
  }, [selectedId, tickets]);

  async function changeStatus(ticketId: string, toStatus: Ticket["status"], note?: string) {
    if (!canMutate) return;
    setBusy(`Updating...`);
    setActionError(null);
    try {
      await api(`/api/tickets/${ticketId}/status`, {
        method: "POST",
        body: { toStatus, actorType: "owner", note: note?.trim() || undefined },
      });
      setStatusDialog(null);
      setStatusNote("");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to update status");
    } finally {
      setBusy("");
    }
  }

  const selected = tickets.find((t) => t.id === selectedId && (!focusLeadId || t.leadId === focusLeadId));
  const scopedTickets = tickets.filter(ticket => (!focusLeadId || ticket.leadId === focusLeadId) && (focusAssigneeId ? ticket.assignedTo === focusAssigneeId : workView === "all" || ticket.assignedTo === currentUserId));
  const matchesStatus = (ticket: Ticket) => focusAssigneeId ? !["resolved", "closed"].includes(ticket.status) : workStatus === "all" || (workStatus === "settled") === ["resolved", "closed"].includes(ticket.status);
  const visibleTickets = scopedTickets.filter(matchesStatus);
  const selectedOutsideView = selected && !visibleTickets.some(ticket => ticket.id === selected.id);

  useEffect(() => {
    if (!selected?.leadId || !["resolved", "closed"].includes(selected.status)) return;
    let active = true;
    const readVersion = (closureReadVersions.current[selected.id] || 0) + 1;
    closureReadVersions.current[selected.id] = readVersion;
    Promise.resolve().then(async () => {
      if (!active) return;
      updateClosure(selected.id, current => ({ ...current, loading: true, error: null, replace: false }));
      try {
        const result = await api<{ draft: ClosureDraft | null }>(`/api/tickets/${selected.id}/closure-draft`);
        if (active && closureReadVersions.current[selected.id] === readVersion) {
          updateClosure(selected.id, current => ({ ...current, draft: result.draft, body: current.dirty ? current.body : result.draft?.body || "", loaded: true }));
        }
      } catch (error) {
        if (active && closureReadVersions.current[selected.id] === readVersion) updateClosure(selected.id, current => ({ ...current, error: error instanceof Error ? error.message : "Could not load the customer follow-up." }));
      } finally {
        if (active && closureReadVersions.current[selected.id] === readVersion) updateClosure(selected.id, current => ({ ...current, loading: false }));
      }
    });
    return () => { active = false; };
  }, [selected?.id, selected?.status, selected?.leadId, closureVersion]);

  async function saveClosure(replaceExisting = false) {
    if (!selected || !canMutate || busy) return;
    if (!closureBody.trim()) { setClosureError("Write the message you want the owner to review."); return; }
    if (closureDraft && ["held_for_review", "drafted"].includes(closureDraft.status) && closureDraft.body.trim() !== closureBody.trim() && !replaceExisting) { setReplaceClosure(true); return; }
    setBusy("Saving customer follow-up...");
    setSavingClosureId(selected.id);
    setClosureError(null);
    const ticketId = selected.id;
    try {
      const result = await api<{ draft: ClosureDraft | null; reused: boolean }>(`/api/tickets/${ticketId}/closure-draft`, { method: "POST", body: { body: closureBody.trim(), replaceExisting } });
      closureReadVersions.current[ticketId] = (closureReadVersions.current[ticketId] || 0) + 1;
      updateClosure(ticketId, current => ({ ...current, draft: result.draft, body: result.draft?.body || "", loaded: true, loading: false, error: null, replace: false, dirty: false }));
    } catch (error) {
      updateClosure(ticketId, current => ({ ...current, error: error instanceof Error ? error.message : "Could not save the customer follow-up." }));
    } finally { setBusy(""); setSavingClosureId(null); }
  }

  async function reviewCustomerReply() {
    if (!selected?.leadId || !onReviewReplies || busy) return;
    setBusy("Opening customer reply...");
    setActionError(null);
    try { await onReviewReplies(selected.leadId); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Could not load the customer reply. Try again."); }
    finally { setBusy(""); }
  }

  function requestStatus(toStatus: Ticket["status"]) {
    if (!selected || !canMutate) return;
    setStatusDialog({ ticketId: selected.id, toStatus });
    setStatusNote("");
    setNoteError(null);
    setActionError(null);
  }

  function saveStatus() {
    if (!statusDialog) return;
    if (!statusNote.trim()) { setNoteError("Please explain the outcome so your team can follow what happened."); return; }
    void changeStatus(statusDialog.ticketId, statusDialog.toStatus, statusNote);
  }

  // Cluster 7 / P1-8: New ticket button + modal. POST /tickets existed but
  // had no UI; the empty-state promised "you can also create one manually"
  // — now there's an actual button + form.
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [formSubject, setFormSubject] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formType, setFormType] = useState<Ticket["type"]>("question");
  const [formPriority, setFormPriority] = useState<Ticket["priority"]>("medium");
  // N-P1-2 (2026-08-07): the ticket-to-order/quote link. Orders/quotes are
  // fetched lazily (only when the New Ticket modal actually opens) — no
  // reason to load them just for viewing the ticket list.
  const [formLeadId, setFormLeadId] = useState("");
  const [formOrderId, setFormOrderId] = useState("");
  const [formQuoteId, setFormQuoteId] = useState("");
  const [leadNameById, setLeadNameById] = useState<Record<string, string>>({});

  function openCreate() {
    if (!canMutate) return;
    setCreateError(null);
    setFormSubject("");
    setFormDescription("");
    setFormType("question");
    setFormPriority("medium");
    setFormLeadId(focusLeadId || "");
    setFormOrderId("");
    setFormQuoteId("");
    setCreateOpen(true);
    setError(null);
    // For readable option labels ("#12 — Aarna Bridal Studio") instead of raw
    // leadIds. Best-effort: an empty map just falls back to showing the id.
    api<Lead[]>(`/api/leads`).then((list) => {
      setLeadNameById(Object.fromEntries(list.map((l) => [l.id, l.companyName || l.contactName || l.email || "Unnamed lead"])));
    }).catch(() => setLeadNameById({}));
  }

  async function submitCreate() {
    if (!canMutate) return;
    setCreateError(null);
    if (!formSubject.trim()) { setCreateError("Subject is required."); return; }
    setBusy("Creating ticket...");
    try {
      await api(`/api/tickets`, {
        method: "POST",
        body: {
          workspaceId,
          leadId: formLeadId || undefined,
          subject: formSubject.trim(),
          description: formDescription.trim(),
          type: formType,
          priority: formPriority,
          orderId: formOrderId || undefined,
          quoteId: formQuoteId || undefined,
          sourceChannel: "manual",
        },
      });
      setCreateOpen(false);
      setCreateError(null);
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Create ticket failed");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <Card title="Tickets" icon={TicketIcon}>
        <div className="flex items-center gap-2 py-8 justify-center text-muted">
          <Spinner /> Loading tickets...
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Tickets" icon={AlertCircle}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load tickets"
          description={error}
          action={<Button onClick={load}>Try again</Button>}
        />
      </Card>
    );
  }

  // 2026-08-05 E-P1-1: action errors show inline (list stays visible).
  const actionBanner = actionError ? (
    <div role="alert" className="mb-3 flex items-start justify-between gap-3 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg">
      <span>{actionError}</span>
      <button className="text-xs font-semibold underline" onClick={() => setActionError(null)}>Dismiss</button>
    </div>
  ) : null;

  if (tickets.length === 0) {
    return (
      <Card title="Tickets" icon={TicketIcon}>
        <EmptyState
          icon={Inbox}
          title="No tickets yet"
          description={canMutate ? "Customer issues will appear here when they are recorded. Create a ticket to track an issue through to its outcome." : "There are no customer issues recorded yet. You can read tickets here when your team adds them."}
          action={canMutate ? <Button icon={Plus} onClick={openCreate}>New ticket</Button> : undefined}
        />
        <NewTicketModal
          open={createOpen}
          error={createError}
          onClose={() => setCreateOpen(false)}
          subject={formSubject} setSubject={setFormSubject}
          description={formDescription} setDescription={setFormDescription}
          type={formType} setType={setFormType}
          priority={formPriority} setPriority={setFormPriority}
          leadId={formLeadId} setLeadId={(id) => { setFormLeadId(id); setFormOrderId(""); setFormQuoteId(""); }}
          orderId={formOrderId} setOrderId={setFormOrderId}
          quoteId={formQuoteId} setQuoteId={setFormQuoteId}
          orders={orders} quotes={quotes} leadNameById={leadNameById}
          busy={busy}
          onSubmit={submitCreate}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {actionBanner}
      {focusAssigneeId && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-info-border bg-info-subtle p-3 text-sm"><div><p className="font-semibold text-info-fg">Hand over work from {memberLabel(focusAssigneeId)}</p><p className="mt-1 text-muted">Showing their unfinished tickets. Choose a new person under “Who is handling this” for each ticket, then return to Workspace to change their access.</p></div>{onClearAssignee && <Button size="sm" variant="secondary" onClick={onClearAssignee}>Finish handover view</Button>}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!focusAssigneeId && <div className="flex flex-wrap items-center gap-2" aria-label="Ticket work view">
          {currentUserId && canMutate && <Button size="sm" variant={workView === "mine" ? "primary" : "secondary"} onClick={() => setWorkView("mine")}>My assigned work ({tickets.filter(ticket => ticket.assignedTo === currentUserId && !["resolved", "closed"].includes(ticket.status)).length} unfinished)</Button>}
          <Button size="sm" variant={workView === "all" ? "primary" : "secondary"} onClick={() => setWorkView("all")}>All company tickets</Button>
        </div>}
        {canMutate ? <Button size="sm" icon={Plus} onClick={openCreate}>New ticket</Button> : <Badge>View only</Badge>}
      </div>
      {!focusAssigneeId && <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="ticket-work-status" className="text-sm font-medium text-foreground">Show</label>
        <select id="ticket-work-status" className="input max-w-52" value={workStatus} onChange={event => setWorkStatus(event.target.value as typeof workStatus)}>
          <option value="all">All statuses</option><option value="unfinished">Unfinished work</option><option value="settled">Resolved and closed</option>
        </select>
        <span className="text-sm text-muted">{scopedTickets.filter(ticket => !["resolved", "closed"].includes(ticket.status)).length} unfinished · {scopedTickets.filter(ticket => ["resolved", "closed"].includes(ticket.status)).length} settled</span>
      </div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
      {/* List */}
      {/* 2026-08-02 audit P2-2 — when drilled in from a Lead, pre-filter to that
          lead's tickets. The focus ribbon (page.tsx) tells the operator why the
          list is filtered + offers a one-click clear. */}
      {(() => {
        // 2026-08-02 (UX redesign): sort by priority then recency so the
        // most urgent + freshest tickets float to the top (Help Scout /
        // Zendesk triage pattern). Urgent > high > medium > low; ties broken
        // by most-recently-updated first.
        const priorityRank: Record<Ticket["priority"], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
        const sorted = [...visibleTickets].sort((a, b) => {
          const pr = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
          if (pr !== 0) return pr;
          return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
        });
        // Priority → left-border accent so urgent/high tickets jump out at a
        // glance without reading every row (preattentive color cue).
        const priorityAccent: Record<Ticket["priority"], string> = {
          urgent: "border-l-danger-fg",
          high: "border-l-warning-fg",
          medium: "border-l-info-fg",
          low: "border-l-border-subtle",
        };
        return (
        <>
      <Card title={`Tickets (${visibleTickets.length}${focusLeadId ? ` of ${tickets.length}` : ""})`} icon={TicketIcon} padding="none">
        {sorted.length === 0 && <EmptyState icon={Inbox} title={focusAssigneeId ? "No unfinished tickets left to hand over" : workView === "mine" ? "No tickets in your work list" : "No tickets match this view"} description={focusAssigneeId ? "Their remaining work is clear. Return to Workspace to change their access when you are ready." : workView === "mine" ? "Your assigned tickets will appear here. Check all company tickets or choose another status." : "Choose another status to find earlier or unfinished work."} action={focusAssigneeId ? onClearAssignee && <Button size="sm" variant="secondary" onClick={onClearAssignee}>Return to team</Button> : <Button size="sm" variant="secondary" onClick={() => { setWorkView("all"); setWorkStatus("all"); }}>Show all company tickets</Button>} />}
        <ul className="divide-y divide-border-subtle max-h-[70vh] overflow-y-auto">
          {sorted.map((t) => {
            const isActive = t.id === selectedId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  aria-current={isActive ? "true" : undefined}
                  className={`w-full border-l-4 px-3 py-3 text-left transition-colors ${
                    isActive
                      ? "border-l-primary bg-surface-tint"
                      : priorityAccent[t.priority] ?? "border-l-border-subtle hover:bg-surface-muted"
                  } ${isActive ? "" : "hover:bg-surface-muted"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground truncate">#{t.ticketNumber} · {t.subject}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(t.status)}>{displayTicketStatus(t.status)}</Badge>
                    <Badge tone={displayTicketPriorityTone(t.priority)}>{displayTicketPriority(t.priority)}</Badge>
                    {/* 2026-09-04 N-UX-21 — the channel printed the stored code
                        ("whatsapp", "email"), and there was no waiting time at
                        all even though this screen's own subtitle promises
                        "how long it has been waiting". A closed ticket is not
                        waiting for anything, so it says when it was settled
                        instead of pretending to still be running. */}
                    <span className="text-xs text-muted">{displayLabel(t.sourceChannel)}</span>
                    <span className="text-xs text-muted">{t.assignedTo ? `Handling: ${memberLabel(t.assignedTo)}` : "Needs assignment"}</span>
                    <span className="text-xs text-muted">
                      {["resolved", "closed"].includes(t.status)
                        ? `Settled ${formatWaitingFor(t.updatedAt || t.createdAt)} ago`
                        : `Waiting ${formatWaitingFor(t.createdAt)}`}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
        </>
        );
      })()}

      {/* Detail */}
      <div ref={detailRef}>
      <Card title={selected ? `Ticket #${selected.ticketNumber}` : "Ticket detail"} icon={TicketIcon}>
        {!selected ? (
          <EmptyState
            icon={TicketIcon}
            title="Select a ticket"
            description="Choose a ticket from the list to see its details and work it through to resolution."
          />
        ) : (
          <div className="space-y-4">
            {selectedOutsideView && <p role="status" className="rounded-md border border-info-border bg-info-subtle p-3 text-sm text-info-fg">This ticket no longer matches your work view. It remains open here so you can finish reviewing the outcome. Choose another ticket to move on.</p>}
            {/* Header */}
            <div>
              <h3 className="text-lg font-semibold text-foreground">{selected.subject}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(selected.status)}>{displayTicketStatus(selected.status)}</Badge>
                <Badge tone={displayTicketPriorityTone(selected.priority)}>{displayTicketPriority(selected.priority)} priority</Badge>
                {selected.assignedTo && <Badge>Assigned to {memberLabel(selected.assignedTo)}</Badge>}
                <span className="text-xs text-muted">via {displayLabel(selected.sourceChannel)}</span>
                {/* N-P1-2 (2026-08-07) — the order/quote this ticket is about. */}
                {selected.orderId && <Badge tone="info">Order #{orders.find((o) => o.id === selected.orderId)?.orderNumber ?? "?"}</Badge>}
                {selected.quoteId && <Badge tone="info">Quote #{quotes.find((q) => q.id === selected.quoteId)?.quoteNumber ?? "?"}</Badge>}
                {/* 2026-08-05 UX audit (Everything Connected): the reverse jump
                    ticket→lead was the one missing link. An operator working a
                    complaint needs to reach the customer's full record (orders,
                    replies, consent) in one click, not by switching tabs + searching. */}
                {selected.leadId && onFocusLead && (
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary underline"
                    onClick={() => onFocusLead(selected.leadId!, "crm")}
                  >
                    <ExternalLink className="h-3 w-3" /> View customer record
                  </button>
                )}
                {selected.leadId && onFocusLead && <Button size="sm" variant="secondary" onClick={() => onFocusLead(selected.leadId!, "replies")}>Customer conversations</Button>}
              </div>
            </div>

            {/* Who is handling it. See AssignableMember above for why only
                active members are offered. */}
            <div>
              <label className="label" htmlFor="ticket-assignee">Who is handling this</label>
              {canMutate ? <select
                id="ticket-assignee"
                className="input"
                value={selected.assignedTo || ""}
                disabled={Boolean(busy)}
                onChange={(e) => assignTicket(selected.id, e.target.value)}
              >
                <option value="">Nobody yet</option>
                {members
                  .filter((m) => m.status === "active" && m.userId && m.role !== "viewer")
                  .map((m) => (
                    <option key={m.id} value={m.userId as string}>
                      {/* The role only when it adds something: a member named
                          "Owner" read "Owner — Owner". */}
                      {(m.name || m.email || "") + ((m.name || m.email || "").toLowerCase() === displayLabel(m.role).toLowerCase() ? "" : " — " + displayLabel(m.role))}
                    </option>
                  ))}
              </select> : <p className="text-sm text-foreground">{selected.assignedTo ? memberLabel(selected.assignedTo) : "Nobody yet"}</p>}
              {canMutate && members.filter((m) => m.status === "active" && m.userId && m.role !== "viewer").length <= 1 && (
                <p className="mt-1 text-xs text-muted">
                  Only you can be assigned so far. Invite a teammate in Workspace &amp; admin &rarr; Workspace to
                  hand tickets to somebody else.
                </p>
              )}
            </div>

            {/* Description */}
            <div>
              <p className="label">Customer&apos;s original message</p>
              <p className="rounded-md border border-border-subtle bg-surface-muted p-3 text-sm text-foreground whitespace-pre-wrap">
                {selected.description}
              </p>
            </div>

            {/* Status actions — a proper ticket lifecycle, not a free-for-all.
                2026-08-02 (UI fix): pre-fix EVERY status button showed for EVERY
                current status (only the matching one was hidden). So a RESOLVED
                ticket still offered "Start working" and "Waiting on customer" —
                nonsense, and exactly what the operator spotted. Now the buttons
                follow the real flow:
                  open → Start working → in_progress
                  in_progress → Waiting on customer / Mark resolved
                  waiting_customer → Start working (resume) / Mark resolved
                  resolved → Reopen (or Close)
                  closed → Reopen
                  reopened → back to the active flow (Start working)
                "Reopen" is the ONLY path out of resolved/closed — matching the
                backend (reopened clears resolvedAt, line 213). */}
            {canMutate && <div>
              <p className="label">{(selected.status === "resolved" || selected.status === "closed") ? "This ticket is done" : "Move to"}</p>
              <div className="flex flex-wrap gap-2">
                {(selected.status === "open" || selected.status === "waiting_customer" || selected.status === "reopened") && (
                  <Button size="sm" loading={busy !== ""} onClick={() => changeStatus(selected.id, "in_progress")}>
                    {selected.status === "waiting_customer" ? "Resume working" : "Start working"}
                  </Button>
                )}
                {(selected.status === "in_progress") && (
                  <Button size="sm" variant="secondary" loading={busy !== ""} onClick={() => changeStatus(selected.id, "waiting_customer")}>Waiting on customer</Button>
                )}
                {(selected.status === "open" || selected.status === "in_progress" || selected.status === "waiting_customer" || selected.status === "reopened") && (
                  <Button size="sm" variant="secondary" loading={busy !== ""} onClick={() => requestStatus("resolved")}>Mark resolved</Button>
                )}
                {(selected.status === "resolved") && (
                  <Button size="sm" variant="secondary" loading={busy !== ""} onClick={() => requestStatus("closed")}>Close</Button>
                )}
                {(selected.status === "closed" || selected.status === "resolved") && (
                  <Button size="sm" loading={busy !== ""} onClick={() => requestStatus("reopened")}>Reopen</Button>
                )}
              </div>
              {busy && <p className="mt-2 text-xs text-muted">{savingClosureId && savingClosureId !== selected.id ? "Saving another ticket's customer follow-up..." : busy}</p>}
            </div>}
            {["resolved", "closed"].includes(selected.status) && <div className="space-y-3 rounded-md border border-border-subtle bg-surface-muted p-3 text-sm">
              <p className="font-medium text-foreground">Customer follow-up</p>
              <p className="text-muted">The resolution is recorded internally. Write a separate customer message for owner review. Saving a draft does not send it.</p>
              {canMutate && selected.leadId && <p className="text-xs text-muted">You can switch tickets while writing here. Save your draft before leaving Tickets or refreshing.</p>}
              {!selected.leadId ? <p className="text-muted">This ticket is not linked to a customer record. Record any follow-up in the closure note and arrange it through your approved channel.</p> : closureLoading ? <p role="status" className="flex items-center gap-2 text-muted"><Spinner /> Loading customer follow-up...</p> : closureError && closureLoadedId !== selected.id ? <div role="alert"><p className="text-danger-fg">{closureError}</p><Button size="sm" variant="secondary" onClick={() => setClosureVersion(version => version + 1)}>Try again</Button></div> : closureLoadedId === selected.id && <>
                {closureDraft && <p role="status" className="text-muted">{savingClosureId === selected.id ? "Saving your updated draft..." : ["held_for_review", "drafted"].includes(closureDraft.status) && closureBody.trim() !== closureDraft.body.trim() ? "You have unsaved changes. The owner still sees the previous saved draft." : closureDraft.sendStatus === "unconfirmed" ? "Approved, but delivery has not been confirmed. Check the customer conversation before sending again." : closureDraft.sendStatus === "sent" || closureDraft.status === "sent" ? "Recorded as sent. Delivery still depends on your channel." : closureDraft.status === "approved" ? "Approved by the owner. Review the reply record for the sending step." : closureDraft.status === "rejected" ? "The previous draft was rejected. Write an updated message for review." : "Draft saved for owner review. No customer message has been sent."}</p>}
                {canMutate && (!closureDraft || ["held_for_review", "drafted", "rejected"].includes(closureDraft.status)) ? <>
                  <label htmlFor="ticket-closure-message" className="label">Message for the customer</label>
                  <textarea disabled={Boolean(busy)} id="ticket-closure-message" className="input min-h-28" maxLength={4000} value={closureBody} onChange={event => { setClosureBody(event.target.value); setClosureError(null); setReplaceClosure(false); }} placeholder="Explain the agreed outcome and next steps. Include only confirmed information." />
                  {closureError && <p role="alert" className="text-danger-fg">{closureError}</p>}
                  {replaceClosure ? <div className="space-y-2"><p className="text-muted">Replace the existing unapproved draft? The earlier version will be rejected and kept in the review history.</p><div className="flex gap-2"><Button size="sm" disabled={Boolean(busy)} loading={savingClosureId === selected.id} onClick={() => saveClosure(true)}>Replace draft</Button><Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => { setClosureBody(closureDraft?.body || "", false); setReplaceClosure(false); setClosureError(null); }}>Keep existing draft</Button></div></div> : <Button size="sm" disabled={Boolean(busy)} loading={savingClosureId === selected.id} onClick={() => saveClosure()}>Save customer follow-up draft</Button>}
                </> : closureDraft && <p className="whitespace-pre-wrap rounded-md border border-border-subtle bg-surface p-3">{closureDraft.body}</p>}
                {role === "owner" && closureDraft && onReviewReplies && <Button size="sm" variant="secondary" disabled={Boolean(busy)} loading={busy === "Opening customer reply..."} onClick={() => void reviewCustomerReply()}>Review customer reply</Button>}
              </>}
            </div>}

            {/* Event history */}
            {eventsTicketId === selectedId && events.length > 0 && (
              <div>
                <p className="label">History</p>
                <ul className="space-y-1">
                  {events.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border-subtle bg-surface-muted p-2 text-sm">
                      <span className="text-foreground">
                        <Badge tone="neutral">{displayLabel(e.eventType)}</Badge>
                        {" "} {plainTicketNote(e.note)}
                        {e.actorUserId ? <span className="ml-2 text-xs text-muted">By {members.find(member => member.userId === e.actorUserId)?.name || members.find(member => member.userId === e.actorUserId)?.email || "a team member"}</span> : null}
                      </span>
                      <time className="text-xs text-muted">{formatDateTime(e.createdAt)}</time>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
      </div>
      </div>
      <Modal open={Boolean(statusDialog)} onClose={() => { if (!busy) setStatusDialog(null); }} title={statusDialog?.toStatus === "resolved" ? "Record the resolution" : statusDialog?.toStatus === "closed" ? "Close this ticket" : "Reopen this ticket"} size="md">
        <div className="space-y-3">
          <p className="text-sm text-muted">{statusDialog?.toStatus === "resolved" ? "Explain what was done and any remaining customer follow-up. Your team will see this in the ticket history." : statusDialog?.toStatus === "closed" ? "Confirm how the issue was finished, including customer follow-up if it happened. Closing records your decision; it does not send a customer message." : "Explain why this issue needs more work so the next person has the right context."}</p>
          <label htmlFor="ticket-outcome-note" className="label">{statusDialog?.toStatus === "reopened" ? "Reason for reopening" : "Outcome and follow-up"}</label>
          <textarea id="ticket-outcome-note" className="input min-h-32" maxLength={5000} value={statusNote} onChange={event => { setStatusNote(event.target.value); setNoteError(null); }} placeholder="What did you do? What should happen next?" aria-invalid={Boolean(noteError)} aria-describedby={noteError ? "ticket-note-error" : undefined} />
          {noteError && <p id="ticket-note-error" role="alert" className="text-sm text-danger-fg">{noteError}</p>}
          {actionBanner}
          <div className="flex justify-end gap-2"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => setStatusDialog(null)}>Cancel</Button><Button loading={Boolean(busy)} onClick={saveStatus}>{statusDialog?.toStatus === "resolved" ? "Save resolution" : statusDialog?.toStatus === "closed" ? "Confirm close" : "Confirm reopen"}</Button></div>
        </div>
      </Modal>
      <NewTicketModal
        open={createOpen}
        error={createError}
        onClose={() => setCreateOpen(false)}
        subject={formSubject} setSubject={setFormSubject}
        description={formDescription} setDescription={setFormDescription}
        type={formType} setType={setFormType}
        priority={formPriority} setPriority={setFormPriority}
        leadId={formLeadId} setLeadId={(id) => { setFormLeadId(id); setFormOrderId(""); setFormQuoteId(""); }}
        orderId={formOrderId} setOrderId={setFormOrderId}
        quoteId={formQuoteId} setQuoteId={setFormQuoteId}
        orders={orders} quotes={quotes} leadNameById={leadNameById}
        busy={busy}
        onSubmit={submitCreate}
      />
    </div>
  );
}

/** Cluster 7 / P1-8: shared New-ticket modal used by both empty + populated states. */
function NewTicketModal(props: {
  open: boolean;
  error: string | null;
  onClose: () => void;
  subject: string; setSubject: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  type: Ticket["type"]; setType: (v: Ticket["type"]) => void;
  priority: Ticket["priority"]; setPriority: (v: Ticket["priority"]) => void;
  leadId: string; setLeadId: (v: string) => void;
  orderId: string; setOrderId: (v: string) => void;
  quoteId: string; setQuoteId: (v: string) => void;
  orders: Order[]; quotes: Quote[]; leadNameById: Record<string, string>;
  busy: string;
  onSubmit: () => void;
}) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="New ticket" size="md" disableDismiss={props.busy === "Creating ticket..."}>
      <fieldset className="space-y-3" disabled={props.busy === "Creating ticket..."}>
        {props.error && <p role="alert" className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg">{props.error}</p>}
        <p className="text-sm text-muted">
          Use this to manually track a customer issue that needs follow-up
          (complaint, return request, escalation). It will appear in your ticket list.
        </p>
        <div>
          <label htmlFor="ticket-customer" className="label">Customer (optional)</label>
          <select id="ticket-customer" className="input mt-1" value={props.leadId} onChange={(event) => props.setLeadId(event.target.value)}>
            <option value="">No customer selected</option>
            {Object.entries(props.leadNameById).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <p className="text-xs text-muted mt-1">Choose the customer to keep their issue, conversation and follow-up together.</p>
        </div>
        <div>
          <label htmlFor="ticket-subject" className="label">Subject <span className="text-danger-fg">*</span></label>
          <input
            id="ticket-subject"
            className="input mt-1"
            value={props.subject}
            onChange={(e) => props.setSubject(e.target.value)}
            placeholder="e.g. Ramesh — short supply complaint for Order #4"
          />
        </div>
        <div>
          <label htmlFor="ticket-description" className="label">Description</label>
          <textarea
            id="ticket-description"
            className="input mt-1 min-h-[80px]"
            value={props.description}
            onChange={(e) => props.setDescription(e.target.value)}
            placeholder="What's the issue? What does the customer want?"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="ticket-type" className="label">Type</label>
            <select
              id="ticket-type"
              className="input mt-1"
              value={props.type}
              onChange={(e) => props.setType(e.target.value as Ticket["type"])}
            >
              <option value="question">Question</option>
              <option value="complaint">Complaint</option>
              <option value="return">Return / refund</option>
              <option value="support">Support</option>
              <option value="escalation">Escalation</option>
            </select>
          </div>
          <div>
            <label htmlFor="ticket-priority" className="label">Priority</label>
            <select
              id="ticket-priority"
              className="input mt-1"
              value={props.priority}
              onChange={(e) => props.setPriority(e.target.value as Ticket["priority"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
        {/* N-P1-2 (2026-08-07): optional link to the order/quote this ticket
            is about — the placeholder text above ("complaint for Order #4")
            had promised this for a while with no field to back it. */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="ticket-order" className="label">Related order (optional)</label>
            <select
              id="ticket-order"
              className="input mt-1"
              value={props.orderId}
              onChange={(e) => props.setOrderId(e.target.value)}
            >
              <option value="">None</option>
              {props.orders.filter(o => !props.leadId || o.leadId === props.leadId).map((o) => (
                <option key={o.id} value={o.id}>#{o.orderNumber} — {props.leadNameById[o.leadId] || o.leadId}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ticket-quote" className="label">Related quote (optional)</label>
            <select
              id="ticket-quote"
              className="input mt-1"
              value={props.quoteId}
              onChange={(e) => props.setQuoteId(e.target.value)}
            >
              <option value="">None</option>
              {props.quotes.filter(q => !props.leadId || q.leadId === props.leadId).map((q) => (
                <option key={q.id} value={q.id}>#{q.quoteNumber} — {props.leadNameById[q.leadId] || q.leadId}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={props.busy === "Creating ticket..."} onClick={props.onSubmit}>
            Create ticket
          </Button>
        </div>
      </fieldset>
    </Modal>
  );
}

function statusTone(status: Ticket["status"]): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "open": return "warning";
    case "in_progress": return "info";
    case "waiting_customer": return "neutral";
    case "resolved": return "success";
    case "closed": return "neutral";
    case "reopened": return "danger";
    default: return "neutral";
  }
}

/** Notes written by older versions used internal words ("via round_robin mode"). */
function plainTicketNote(note?: string): string {
  return (note || "")
    .replace(/Auto-assigned via round_robin mode\.?/g, "Assigned automatically, taking turns across the team.")
    .replace(/Auto-assigned via auto_rule mode\.?/g, "Assigned automatically by your rule.")
    .replace(/Ticket auto-created from whatsapp inbound\.?/gi, "Created automatically from a WhatsApp message.")
    .replace(/\b([a-z]+)_([a-z]+)\b/g, "$1 $2");
}
