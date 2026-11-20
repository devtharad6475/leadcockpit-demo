/**
 * Stage 5 / WP3 (2026-07-28) — Platform admin panel (/admin).
 *
 * The SaaS OPERATOR's console — separate from the workspace SPA. Uses a
 * separate cookie (lc_platform_admin) + separate login (see
 * src/services/PlatformAdminAuthService.ts). Production-only: in demo mode
 * the panel is unreachable (admin auth returns null), and this page shows a
 * clear "not available in demo" message instead of a broken login.
 *
 * What this page does (docs/LOGIC.md 2026-07-28 Stage 5 WP3):
 *   - Detects auth mode + admin session via /api/admin/auth/status.
 *   - If demo → "not available" notice (with the bootstrap hint).
 *   - If production + no admin → "bootstrap the first admin" hint (CLI).
 *   - If production + admin but logged out → login form.
 *   - If logged in → operator inbox:
 *       • list ALL workspaces' platform tickets (operator sees across tenants)
 *       • detail + thread
 *       • operator reply (sets firstResponseAt on first reply)
 *       • change status (open / in_progress / waiting_on_user / resolved / closed)
 *       • flag spam (operator-only) — hides from default list, persists record
 *       • block / unblock a user from support (operator-only)
 *
 * SACRED no-auto-outreach: every action is a logged-in operator typing. The
 * admin panel NEVER sends anything to a workspace user's contacts.
 *
 * RBAC: operator can do everything; support_agent can reply + change status
 * but NOT flag spam or block users (enforced by the route, which checks
 * requirePlatformAdmin(request, "operator") on those endpoints).
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
  PlatformAdmin,
  PlatformTicket,
  PlatformTicketEvent,
  PlatformTicketStatus,
} from "@/lib/types";
import {
  LogOut, ShieldCheck, AlertCircle, RefreshCw, Ban,
  Flag, MessageSquare, Inbox, Building2, Activity,
} from "lucide-react";
// Stage 5 re-audit F-P2-6 (2026-07-28): import the SINGLE breach-rule
// chokepoint instead of re-implementing it inline (was 3 inline copies that
// would silently diverge from the service's rule on any change).
import { computeLivePlatformBreach } from "@/lib/platform-ticket-breach";
import { AdminWorkspaces } from "./sections/AdminWorkspaces";
import { AdminHealth, AdminFlags } from "./sections/AdminHealthFlags";

type StatusResponse = {
  authMode?: string;
  hasAdmin?: boolean;
  authenticated?: boolean;
  admin?: { id: string; email: string; name: string; role: PlatformAdmin["role"] } | null;
};

const ALL_STATUSES: PlatformTicketStatus[] = [
  "open", "in_progress", "waiting_on_user", "reopened", "resolved", "closed",
];

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateTime(d);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string } } | string | null;
    const msg = typeof b === "string" ? b : (b?.error?.message || `Request failed (${res.status})`);
    throw new Error(msg);
  }
  return body as T;
}

export default function AdminPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  async function loadStatus() {
    setLoadingStatus(true);
    try {
      const s = await api<StatusResponse>("/api/admin/auth/status");
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (loadingStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Spinner />
      </div>
    );
  }

  // Demo mode: panel not reachable.
  if (!status?.authenticated) {
    return <AdminLogin status={status} onLoggedIn={loadStatus} />;
  }

  return (
    <AdminConsole
      admin={status.admin!}
      onLogout={async () => {
        await api("/api/admin/auth/logout", { method: "POST" });
        await loadStatus();
      }}
    />
  );
}

// ─── Console shell (tab nav + active section) ───────────────────────────────
//
// Stage 5 / WP2 (2026-07-28) — the operator console gained Workspaces / Health
// / Flags tabs alongside the WP3 Inbox. All sections share the same header
// (admin identity + sign-out). The Inbox code below is unchanged from WP3.

type AdminTab = "inbox" | "workspaces" | "health" | "flags";

function AdminConsole({ admin, onLogout }: { admin: { id: string; email: string; name: string; role: PlatformAdmin["role"] }; onLogout: () => void }) {
  const [tab, setTab] = useState<AdminTab>("inbox");
  const isOperator = admin.role === "operator";

  const tabs: { id: AdminTab; label: string; icon: typeof Inbox }[] = [
    { id: "inbox", label: "Inbox", icon: Inbox },
    { id: "workspaces", label: "Workspaces", icon: Building2 },
    { id: "health", label: "System health", icon: Activity },
    { id: "flags", label: "Kill-switches", icon: Flag },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b border-border-default bg-surface">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <span className="font-semibold text-foreground">LeadCockpit Admin</span>
            <Badge tone={isOperator ? "info" : "neutral"}>{admin.role}</Badge>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-foreground-muted hidden sm:inline">{admin.email}</span>
            <Button variant="ghost" size="sm" icon={LogOut} onClick={onLogout}>Sign out</Button>
          </div>
        </div>
        {/* Tab nav */}
        <div className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-foreground-muted hover:text-foreground"
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4">
        {tab === "inbox" && <AdminInbox admin={admin} />}
        {tab === "workspaces" && <AdminWorkspaces admin={admin} />}
        {tab === "health" && <AdminHealth />}
        {tab === "flags" && <AdminFlags />}
      </main>
    </div>
  );
}

// ─── Login / gate screen ────────────────────────────────────────────────────

function AdminLogin({ status, onLoggedIn }: { status: StatusResponse | null; onLoggedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) { setError("Email and password are required."); return; }
    setBusy("Signing in...");
    setError(null);
    try {
      await api("/api/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-lg bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground">LeadCockpit Admin</h1>
          <p className="text-sm text-foreground-muted">Operator console — separate from workspace login.</p>
        </div>

        {/* Demo / not-bootstrapped gates */}
        {status && !status.hasAdmin && (
          <Card title="No admin account yet" icon={AlertCircle}>
            <p className="text-sm text-foreground-muted">
              The first admin must be created from the server CLI. Run:
            </p>
            <pre className="mt-2 rounded-md bg-surface-muted p-2 text-xs overflow-x-auto"><code>{`AUTH_MODE=production npm run bootstrap:admin -- --email you@example.com --password '...' --name 'Your Name' --role operator`}</code></pre>
          </Card>
        )}

        {error && (
          <div className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Card title="Sign in" icon={ShieldCheck}>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="admin-email" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">Email</label>
              <input
                id="admin-email" type="email" autoComplete="username"
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="admin-password" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">Password</label>
              <input
                id="admin-password" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <Button type="submit" className="w-full" loading={busy !== ""} disabled={busy !== ""}>
              Sign in
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

// ─── Operator inbox ─────────────────────────────────────────────────────────

function AdminInbox({ admin }: { admin: { id: string; email: string; name: string; role: PlatformAdmin["role"] } }) {
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
  const [showSpam, setShowSpam] = useState(false);
  const [statusFilter, setStatusFilter] = useState<PlatformTicketStatus | "all">("all");

  const isOperator = admin.role === "operator";

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
      const params = new URLSearchParams();
      if (showSpam) params.set("includeSpamFlagged", "true");
      const qs = params.toString();
      const list = await api<PlatformTicket[]>(`/api/admin/platform-tickets${qs ? `?${qs}` : ""}`);
      if (request === listRequest.current) setTickets(list);
    } catch (e) {
      if (request === listRequest.current) setError(e instanceof Error ? e.message : "Failed to load tickets");
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [showSpam]);

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
      const rows = await api<PlatformTicketEvent[]>(`/api/admin/platform-tickets/${ticketId}/events`);
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

  const filtered = statusFilter === "all" ? tickets : tickets.filter((t) => t.status === statusFilter);
  // Breached first (open/past-due), then by created desc.
  // Stage 5 re-audit F-P2-6: reuse computeLivePlatformBreach (was inline).
  const nowForSort = new Date();
  const sorted = [...filtered].sort((a, b) => {
    const aBreach = computeLivePlatformBreach(a, nowForSort) ? 1 : 0;
    const bBreach = computeLivePlatformBreach(b, nowForSort) ? 1 : 0;
    if (bBreach !== aBreach) return bBreach - aBreach;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // --- Operator actions -----------------------------------------------------
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const comment = selectedId ? commentDrafts[selectedId] || "" : "";
  function setComment(value: string) {
    if (selectedId) setCommentDrafts(previous => ({ ...previous, [selectedId]: value }));
  }

  async function refreshSelected() {
    if (!selectedId) return;
    await load();
    await loadThread(selectedId);
  }

  async function submitComment() {
    if (!selectedId || !comment.trim()) return;
    setBusy("Sending reply...");
    setError(null);
    try {
      await api(`/api/admin/platform-tickets/${selectedId}/comments`, {
        method: "POST", body: JSON.stringify({ note: comment.trim() }),
      });
      setComment("");
      await refreshSelected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the reply.");
    } finally { setBusy(""); }
  }

  async function changeStatus(toStatus: PlatformTicketStatus) {
    if (!selectedId) return;
    setBusy("Updating status...");
    setError(null);
    try {
      await api(`/api/admin/platform-tickets/${selectedId}/status`, {
        method: "POST", body: JSON.stringify({ toStatus }),
      });
      await refreshSelected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update status.");
    } finally { setBusy(""); }
  }

  // Spam flag modal (operator-only).
  const [spamOpen, setSpamOpen] = useState(false);
  const [spamReason, setSpamReason] = useState("");
  async function submitSpam() {
    if (!selectedId || spamReason.trim().length < 3) return;
    setBusy("Flagging...");
    setError(null);
    try {
      await api(`/api/admin/platform-tickets/${selectedId}/flag-spam`, {
        method: "POST", body: JSON.stringify({ reason: spamReason.trim() }),
      });
      setSpamOpen(false);
      setSpamReason("");
      await refreshSelected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not flag the ticket.");
    } finally { setBusy(""); }
  }

  // Block user modal (operator-only).
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockReason, setBlockReason] = useState("");
  async function submitBlock() {
    if (!selected) return;
    setBusy("Blocking user...");
    setError(null);
    try {
      await api(`/api/admin/users/block`, {
        method: "POST",
        body: JSON.stringify({
          userId: selected.raisedByUserId,
          workspaceId: selected.workspaceId,
          isBlockedFromSupport: true,
          reason: blockReason.trim() || undefined,
        }),
      });
      setBlockOpen(false);
      setBlockReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not block the user.");
    } finally { setBusy(""); }
  }

  return (
    <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PlatformTicketStatus | "all")}
            className="rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>{displayPlatformTicketStatus(s)}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-foreground-muted cursor-pointer">
            <input type="checkbox" checked={showSpam} onChange={(e) => setShowSpam(e.target.checked)} />
            Show spam-flagged
          </label>
          <div className="ml-auto">
            <Button variant="ghost" size="sm" icon={RefreshCw} onClick={load}>Refresh</Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No tickets"
            description={showSpam ? "No tickets match the current filter." : "The inbox is empty. New tickets from workspaces will appear here."}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* List */}
            <div className="lg:col-span-2 space-y-2">
              {sorted.map((t) => {
                const breach = computeLivePlatformBreach(t, new Date());
                return (
                  <button
                    key={t.id}
                    onClick={() => { setSelectedId(t.id); setError(null); }}
                    className={`w-full text-left rounded-md border p-3 transition-colors ${
                      selectedId === t.id ? "border-primary bg-surface-tint" : "border-border-default bg-surface hover:bg-surface-muted"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-foreground-muted">#{t.ticketNumber}</span>
                      <div className="flex items-center gap-1">
                        {t.isSpamFlagged && <Badge tone="danger">Spam</Badge>}
                        {breach && <Badge tone="danger">Overdue</Badge>}
                        <Badge tone={displayPlatformTicketStatusTone(t.status)}>{displayPlatformTicketStatus(t.status)}</Badge>
                      </div>
                    </div>
                    <div className="mt-1 font-medium text-sm text-foreground line-clamp-2">{t.subject}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-foreground-muted">
                      <span>{displayPlatformTicketCategory(t.category)}</span>
                      <span aria-hidden>·</span>
                      <Badge tone={displayTicketPriorityTone(t.priority)}>{displayTicketPriority(t.priority)}</Badge>
                      <span aria-hidden>·</span>
                      <span className="truncate">ws {t.workspaceId.slice(0, 12)}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Detail */}
            <div className="lg:col-span-3" ref={detailRef}>
              {!selected ? (
                <Card title="Ticket details" icon={MessageSquare}>
                  <p className="text-sm text-foreground-muted">Select a ticket on the left.</p>
                </Card>
              ) : (
                <Card title={`Ticket #${selected.ticketNumber}`} icon={MessageSquare}>
                  <div className="space-y-3">
                    <div>
                      <div className="text-base font-semibold text-foreground">{selected.subject}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <Badge tone={displayPlatformTicketStatusTone(selected.status)}>{displayPlatformTicketStatus(selected.status)}</Badge>
                        <Badge tone="neutral">{displayPlatformTicketCategory(selected.category)}</Badge>
                        <Badge tone={displayTicketPriorityTone(selected.priority)}>{displayTicketPriority(selected.priority)}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-foreground-muted space-y-0.5">
                        <div>From user <span className="font-mono">{selected.raisedByUserId}</span> in workspace <span className="font-mono">{selected.workspaceId}</span></div>
                        <div>Opened {formatDate(selected.createdAt)} · First response {formatDate(selected.firstResponseAt)}</div>
                        <div>SLA due {formatDate(selected.slaDueAt)}{computeLivePlatformBreach(selected, new Date()) && <span className="text-danger-fg font-medium"> (overdue)</span>}</div>
                        {selected.isSpamFlagged && <div className="text-danger-fg">Flagged spam: {selected.spamReason}</div>}
                      </div>
                    </div>

                    <div className="rounded-md bg-surface-muted p-3 text-sm text-foreground whitespace-pre-wrap">
                      {selected.description}
                    </div>

                    {/* Status changer */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">Set status:</span>
                      {ALL_STATUSES.map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={selected.status === s ? "primary" : "secondary"}
                          onClick={() => changeStatus(s)}
                          disabled={busy !== "" || selected.status === s}
                        >
                          {displayPlatformTicketStatus(s)}
                        </Button>
                      ))}
                    </div>

                    {/* Thread */}
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-2">Conversation</h4>
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
                                      {isComment ? (isUser ? "User" : ev.actorAdminId ? `Support (${ev.actorAdminId.slice(0, 8)})` : "Support") : displayPlatformTicketEvent(ev.eventType)}
                                    </span>
                                    <span className="text-xs text-foreground-muted">{formatDate(ev.createdAt)}</span>
                                  </div>
                                  {ev.note ? (
                                    <p className="mt-0.5 text-sm text-foreground whitespace-pre-wrap break-words">{ev.note}</p>
                                  ) : (
                                    <p className="mt-0.5 text-xs text-foreground-muted italic">
                                      {displayPlatformTicketEvent(ev.eventType)}{ev.toStatus ? ` → ${displayPlatformTicketStatus(ev.toStatus)}` : ""}
                                    </p>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </div>

                    {/* Reply */}
                    <div className="border-t border-border-default pt-3">
                      <label htmlFor="admin-comment" className="block text-xs font-semibold uppercase tracking-wide text-foreground-muted mb-1">Reply to user</label>
                      <textarea
                        id="admin-comment" rows={3} value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="Your reply. The first reply stamps the SLA first-response time."
                        className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                      />
                      <div className="mt-2 flex justify-end">
                        <Button onClick={submitComment} loading={busy === "Sending reply..."} disabled={!comment.trim() || busy !== ""}>
                          Send reply
                        </Button>
                      </div>
                    </div>

                    {/* Operator-only abuse actions */}
                    {isOperator && (
                      <div className="border-t border-border-default pt-3 flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" icon={Flag} onClick={() => setSpamOpen(true)} disabled={selected.isSpamFlagged || busy !== ""}>
                          Flag as spam
                        </Button>
                        <Button variant="secondary" size="sm" icon={Ban} onClick={() => setBlockOpen(true)} disabled={busy !== ""}>
                          Block this user
                        </Button>
                      </div>
                    )}
                    {!isOperator && (
                      <p className="text-xs text-foreground-muted italic border-t border-border-default pt-3">
                        Spam flagging and user blocking require the operator role.
                      </p>
                    )}
                  </div>
                </Card>
              )}
            </div>
          </div>
        )}

      {/* Spam modal */}
      <Modal open={spamOpen} onClose={() => setSpamOpen(false)} title="Flag ticket as spam">
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">
            Flagging hides this ticket from the default inbox. The record is kept (not deleted) for audit. A reason is required.
          </p>
          <textarea
            rows={3} value={spamReason} onChange={(e) => setSpamReason(e.target.value)}
            placeholder="Why is this spam or abuse?"
            className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSpamOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={submitSpam} loading={busy === "Flagging..."} disabled={spamReason.trim().length < 3 || busy !== ""}>Flag as spam</Button>
          </div>
        </div>
      </Modal>

      {/* Block modal */}
      <Modal open={blockOpen} onClose={() => setBlockOpen(false)} title="Block user from support">
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">
            The user <span className="font-mono">{selected?.raisedByUserId}</span> will not be able to open NEW tickets. Their EXISTING open tickets are NOT auto-closed.
          </p>
          <textarea
            rows={3} value={blockReason} onChange={(e) => setBlockReason(e.target.value)}
            placeholder="Reason (optional, for the audit log)"
            className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBlockOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={submitBlock} loading={busy === "Blocking user..."} disabled={busy !== ""}>Block user</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
