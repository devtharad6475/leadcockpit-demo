/**
 * Stage 5 / WP2 (2026-07-28) — Operator console: Workspaces section.
 *
 * Renders the cross-tenant workspace list (with suspend/activate kill-switch +
 * user count) and a detail drawer (users + impersonate + reset-password). All
 * actions route through /api/admin/workspaces/* (operator-only, RBAC at the
 * route). The parent /admin page renders this when the "Workspaces" tab is
 * active.
 *
 * Per docs/LOGIC.md 2026-07-28: suspend is reversible, data-preserving,
 * operator-only. Impersonation is operator-only, 15-min, one-at-a-time,
 * owner-blocked, audited.
 *
 * SACRED no-auto-outreach: the reset-password button emails a TRANSACTIONAL
 * reset link to a known workspace user (the operator-confirmed exception).
 * Nothing here sends prospecting outreach.
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, Modal } from "@/components/ui";
import type { PlatformAdmin, User, Workspace } from "@/lib/types";
import {
  Building2, RefreshCw, AlertCircle, Ban, Play, UserCog,
  KeyRound, Eye, Search,
} from "lucide-react";

type WorkspaceSummary = Workspace & { userCount: number };

type Props = {
  admin: { id: string; email: string; name: string; role: PlatformAdmin["role"] };
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) {
    const b = body as { error?: { message?: string; code?: string } } | string | null;
    const msg = typeof b === "string" ? b : (b?.error?.message || `Request failed (${res.status})`);
    throw Object.assign(new Error(msg), { code: typeof b === "object" ? b?.error?.code : undefined });
  }
  return body as T;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateTime(d);
}

export function AdminWorkspaces({ admin }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [unconfirmedResetUserId, setUnconfirmedResetUserId] = useState<string | null>(null);
  const [includeSuspended, setIncludeSuspended] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const listRequest = useRef(0);

  const isOperator = admin.role === "operator";
  const detailRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api<WorkspaceSummary[]>(`/api/admin/workspaces?includeSuspended=${includeSuspended ? "true" : "false"}`);
      if (request === listRequest.current) setWorkspaces(list);
    } catch (e) {
      if (request === listRequest.current) setError(e instanceof Error ? e.message : "Failed to load workspaces");
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [includeSuspended]);

  const invalidateList = useCallback(() => { ++listRequest.current; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); invalidateList(); };
  }, [load, invalidateList]);

  useEffect(() => {
    if (!selectedId) return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId]);

  const filtered = query.trim()
    ? workspaces.filter((w) =>
        w.name.toLowerCase().includes(query.toLowerCase()) ||
        w.id.toLowerCase().includes(query.toLowerCase()) ||
        (w.businessName || "").toLowerCase().includes(query.toLowerCase()))
    : workspaces;

  const selected = workspaces.find((w) => w.id === selectedId) || null;

  async function suspend(wsId: string, reason: string) {
    setBusy("Suspending...");
    setError(null);
    try {
      await api(`/api/admin/workspaces/${wsId}/suspend`, { method: "POST", body: JSON.stringify({ reason }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not suspend the workspace.");
    } finally { setBusy(""); }
  }

  async function activate(wsId: string) {
    setBusy("Activating...");
    setError(null);
    try {
      await api(`/api/admin/workspaces/${wsId}/activate`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not activate the workspace.");
    } finally { setBusy(""); }
  }

  async function impersonate(wsId: string, userId: string, reason: string) {
    setBusy("Starting impersonation...");
    setError(null);
    try {
      await api(`/api/admin/workspaces/${wsId}/impersonate`, {
        method: "POST", body: JSON.stringify({ targetUserId: userId, targetWorkspaceId: wsId, reason }),
      });
      // The full impersonation cookie set + redirect is a UI polish step; for
      // WP2 we surface the audit-confirmed start. (The session marker wiring
      // is exercised by smoke:stage5-admin.)
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start impersonation.");
    } finally { setBusy(""); }
  }

  async function resetPassword(wsId: string, userId: string) {
    setBusy("Issuing password reset...");
    setError(null);
    setResetNotice(null);
    try {
      const result = await api<{ ok: boolean; emailProvider: string; emailOk: boolean }>(
        `/api/admin/users/${userId}/reset-password`,
        { method: "POST", body: JSON.stringify({ workspaceId: wsId }) },
      );
      if (result.emailProvider === "mock") {
        setError(`Reset link generated. NOTE: email provider is "mock" (no RESEND_API_KEY) — the link was NOT actually emailed. Configure Resend to deliver reset emails. (Audit logged.)`);
      } else if (!result.emailOk) {
        setError("Reset link generated, but the email failed to send. Check the provider credentials.");
      }
      else setResetNotice("The email provider accepted the reset link for sending. Check the user's inbox; delivery is not confirmed. Existing sessions ended, but the existing password still works until the link is used.");
    } catch (e) {
      if ((e as { code?: string }).code === "RESET_EMAIL_UNCONFIRMED") setUnconfirmedResetUserId(userId);
      setError(e instanceof Error ? e.message : "Could not issue the password reset.");
    } finally { setBusy(""); }
  }

  // Stage 5 / WP1 (2026-07-28) — operator hand-provision a pilot workspace.
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provEmail, setProvEmail] = useState("");
  const [provName, setProvName] = useState("");
  const [provBusiness, setProvBusiness] = useState("");
  async function provision() {
    setBusy("Provisioning workspace...");
    setError(null);
    try {
      await api(`/api/admin/workspaces/provision`, {
        method: "POST",
        body: JSON.stringify({ ownerEmail: provEmail, ownerName: provName, businessName: provBusiness || undefined }),
      });
      setProvisionOpen(false);
      setProvEmail(""); setProvName(""); setProvBusiness("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not provision the workspace.");
    } finally { setBusy(""); }
  }

  return (
    <div className="space-y-4">
      {resetNotice && <p className="rounded-lg border border-border-default bg-surface p-3 text-sm text-success-fg" role="status">{resetNotice}</p>}
      {error && (
        <div className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-muted" />
          <input
            type="text" placeholder="Search workspaces..." value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-border-default bg-surface pl-8 pr-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-foreground-muted cursor-pointer">
          <input type="checkbox" checked={includeSuspended} onChange={(e) => setIncludeSuspended(e.target.checked)} />
          Show suspended
        </label>
        <div className="ml-auto flex items-center gap-2">
          {isOperator && (
            <Button variant="secondary" size="sm" icon={Building2} onClick={() => setProvisionOpen(true)}>
              Provision workspace
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={load}>Refresh</Button>
        </div>
      </div>

      {/* Stage 5 / WP1 — operator hand-provision modal (pilot customers).
          F-UI-5 (2026-08-04 build-right audit): migrated from a bespoke overlay
          (no role/aria-modal/Escape/focus-trap) to the <Modal> primitive so it
          gets the full a11y contract for free. The sibling suspend/impersonate
          modals below already used <Modal>; this one was missed. */}
      <Modal
        open={provisionOpen}
        onClose={() => setProvisionOpen(false)}
        title="Provision a pilot workspace"
        size="md"
      >
        <p className="text-sm text-muted mb-4">
          Creates a workspace + owner for a friendly pilot customer. No verification email is sent —
          use the &quot;Reset password&quot; action to let the owner set their own password.
        </p>
        <div className="space-y-3">
          {/* 2026-08-05 (audit F-9): label association. */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="provision-owner-email">Owner email</label>
            <input id="provision-owner-email" type="email" value={provEmail} onChange={(e) => setProvEmail(e.target.value)}
              className="input" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="provision-owner-name">Owner name</label>
            <input id="provision-owner-name" type="text" value={provName} onChange={(e) => setProvName(e.target.value)}
              className="input" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="provision-business-name">Business name (optional)</label>
            <input id="provision-business-name" type="text" value={provBusiness} onChange={(e) => setProvBusiness(e.target.value)}
              className="input" />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setProvisionOpen(false)}>Cancel</Button>
          <Button size="sm" loading={!!busy} onClick={provision} disabled={!provEmail || !provName}>
            {busy || "Provision workspace"}
          </Button>
        </div>
      </Modal>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Building2} title="No workspaces" description={includeSuspended ? "No workspaces match the current filter." : "No active workspaces. Toggle 'Show suspended' to see kill-switched tenants."} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* List */}
          <div className="lg:col-span-2 space-y-2">
            {filtered.map((w) => (
              <button
                key={w.id}
                onClick={() => { setSelectedId(w.id); setError(null); }}
                className={`w-full text-left rounded-md border p-3 transition-colors ${
                  selectedId === w.id ? "border-primary bg-surface-tint" : "border-border-default bg-surface hover:bg-surface-muted"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm text-foreground truncate">{w.businessName || w.name}</span>
                  <Badge tone={w.status === "suspended" ? "danger" : w.status === "active" ? "success" : "neutral"}>{w.status}</Badge>
                </div>
                <div className="mt-1 text-xs text-foreground-muted truncate font-mono">{w.id}</div>
                <div className="mt-1 flex items-center gap-3 text-xs text-foreground-muted">
                  <span>{w.userCount} user{w.userCount === 1 ? "" : "s"}</span>
                  <span aria-hidden>·</span>
                  <span>Created {formatDate(w.createdAt)}</span>
                </div>
                {w.suspendedAt && <div className="mt-1 text-xs text-danger-fg">Suspended {formatDate(w.suspendedAt)}</div>}
              </button>
            ))}
          </div>

          {/* Detail */}
          <div className="lg:col-span-3" ref={detailRef}>
            {!selected ? (
              <Card title="Workspace details" icon={Building2}>
                <p className="text-sm text-foreground-muted">Select a workspace on the left to see its users and operator actions.</p>
              </Card>
            ) : (
              <WorkspaceDetail
                workspace={selected}
                isOperator={isOperator}
                busy={busy}
                onSuspend={suspend}
                onActivate={activate}
                onImpersonate={impersonate}
                onResetPassword={resetPassword}
                unconfirmedResetUserId={unconfirmedResetUserId}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Workspace detail drawer ────────────────────────────────────────────────

function WorkspaceDetail(props: {
  workspace: WorkspaceSummary;
  isOperator: boolean;
  busy: string;
  onSuspend: (wsId: string, reason: string) => Promise<void>;
  onActivate: (wsId: string) => Promise<void>;
  onImpersonate: (wsId: string, userId: string, reason: string) => Promise<void>;
  onResetPassword: (wsId: string, userId: string) => Promise<void>;
  unconfirmedResetUserId: string | null;
}) {
  const { workspace: ws, isOperator, busy } = props;
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersWorkspaceId, setUsersWorkspaceId] = useState<string | null>(null);
  const [usersRetry, setUsersRetry] = useState(0);

  // Suspend modal
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  // Impersonate modal
  const [impOpen, setImpOpen] = useState(false);
  const [impUserId, setImpUserId] = useState("");
  const [impReason, setImpReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoadingUsers(true);
      setUsersWorkspaceId(ws.id);
      setUsersError(null);
      setUsers([]);
      api<User[]>(`/api/admin/workspaces/${ws.id}/users`)
        .then((u) => { if (!cancelled) setUsers(u); })
        .catch((e) => { if (!cancelled) setUsersError(e instanceof Error ? e.message : "Couldn't load this company's team."); })
        .finally(() => { if (!cancelled) setLoadingUsers(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [ws.id, usersRetry]);

  return (
    <Card title={ws.businessName || ws.name} icon={Building2}>
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={ws.status === "suspended" ? "danger" : ws.status === "active" ? "success" : "neutral"}>{ws.status}</Badge>
            <span className="text-xs text-foreground-muted font-mono">{ws.id}</span>
          </div>
          <div className="mt-1 text-xs text-foreground-muted space-y-0.5">
            <div>{ws.userCount} user{ws.userCount === 1 ? "" : "s"} · Created {formatDate(ws.createdAt)}</div>
            {ws.suspendedAt && <div className="text-danger-fg">Suspended {formatDate(ws.suspendedAt)}{ws.suspendedByAdminId ? ` by ${ws.suspendedByAdminId.slice(0, 12)}` : ""}</div>}
          </div>
        </div>

        {/* Operator actions */}
        {isOperator ? (
          <div className="flex flex-wrap gap-2 border-t border-border-default pt-3">
            {ws.status !== "suspended" ? (
              <Button variant="danger" size="sm" icon={Ban} onClick={() => setSuspendOpen(true)} disabled={busy !== ""}>
                Suspend workspace
              </Button>
            ) : (
              <Button variant="primary" size="sm" icon={Play} onClick={() => props.onActivate(ws.id)} disabled={busy !== ""}>
                Activate workspace
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-foreground-muted italic border-t border-border-default pt-3">
            Suspend/activate require the operator role.
          </p>
        )}

        {/* Users table */}
        <div className="border-t border-border-default pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted flex items-center gap-1.5">
              <UserCog className="h-3.5 w-3.5" /> Users{usersWorkspaceId === ws.id && !loadingUsers && !usersError ? ` (${users.length})` : ""}
            </h4>
          </div>
          {usersWorkspaceId !== ws.id || loadingUsers ? (
            <Spinner />
          ) : usersError ? (
            <div className="space-y-2"><p role="alert" className="text-sm text-danger-fg">{usersError}</p><Button variant="secondary" onClick={() => setUsersRetry(value => value + 1)}>Try team list again</Button></div>
          ) : users.length === 0 ? (
            <p className="text-sm text-foreground-muted">No users in this workspace.</p>
          ) : (
            <div className="space-y-1">
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 rounded-md border border-border-default bg-surface px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{u.name}</div>
                    <div className="text-xs text-foreground-muted truncate">{u.email} · <span className="font-mono">{u.id.slice(0, 12)}</span></div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone={u.role === "owner" ? "info" : "neutral"}>{u.role}</Badge>
                    {isOperator && (
                      <div className="flex gap-1">
                        <Button
                          variant="secondary" size="sm" icon={Eye}
                          onClick={() => { setImpUserId(u.id); setImpOpen(true); }}
                          disabled={true}
                          title="Impersonation is not yet available — the session-marker cookie wiring is a planned follow-up (F-P1-4). The operator audit log + 5 hard limits are proven; the in-SPA impersonation UX is not yet wired."
                        >
                          Impersonate (soon)
                        </Button>
                        <Button
                          variant="ghost" size="sm" icon={KeyRound}
                          onClick={() => props.onResetPassword(ws.id, u.id)}
                          disabled={busy !== "" || props.unconfirmedResetUserId === u.id}
                          title={props.unconfirmedResetUserId === u.id ? "Check the user's inbox or provider records before requesting another reset" : "Request a password reset email"}
                        >
                          Reset password
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Suspend modal */}
      <Modal open={suspendOpen} onClose={() => setSuspendOpen(false)} title="Suspend workspace">
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">
            Suspending <strong>{ws.businessName || ws.name}</strong> blocks all logins for its users. All data is PRESERVED — the workspace can be reactivated instantly. A reason is required (recorded in the audit log).
          </p>
          <textarea
            rows={3} value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)}
            placeholder="Why is this workspace being suspended? (e.g. non-payment, abuse, security incident)"
            className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSuspendOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={busy === "Suspending..."} disabled={suspendReason.trim().length < 3 || busy !== ""}
              // F-UI-26 (2026-08-05): await the action before closing so the
              // in-modal loading spinner is actually visible during the
              // request (previously the modal closed instantly + the busy
              // state only mattered inside the now-hidden modal).
              onClick={async () => { await props.onSuspend(ws.id, suspendReason.trim()); setSuspendOpen(false); setSuspendReason(""); }}>
              Suspend workspace
            </Button>
          </div>
        </div>
      </Modal>

      {/* Impersonate modal */}
      <Modal open={impOpen} onClose={() => setImpOpen(false)} title="Impersonate user">
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">
            You will act as this user for up to <strong>15 minutes</strong>. Every action you take is audit-logged with BOTH your operator identity AND the impersonated user. A reason is required.
          </p>
          <textarea
            rows={3} value={impReason} onChange={(e) => setImpReason(e.target.value)}
            placeholder="Why are you impersonating this user? (e.g. reproducing a reported bug)"
            className="w-full rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setImpOpen(false)}>Cancel</Button>
            <Button loading={busy === "Starting impersonation..."} disabled={impReason.trim().length < 3 || busy !== ""}
              onClick={async () => { await props.onImpersonate(ws.id, impUserId, impReason.trim()); setImpOpen(false); setImpReason(""); }}>
              Start impersonation
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
