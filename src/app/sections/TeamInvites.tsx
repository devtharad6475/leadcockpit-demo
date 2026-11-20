/**
 * Stage 5 / WP1 (2026-07-28) — Team & Invites panel.
 *
 * Shown inside the Workspace settings screen. Lets the owner/admin:
 *   - See active members of the workspace.
 *   - See pending invites (+ their status: pending/revoked/expired).
 *   - Invite a new member by email (role: admin/sales_member/viewer — never owner).
 *   - Revoke a pending invite.
 *
 * Build-right UX:
 *   - Empty-state honesty: explains WHY a list is empty.
 *   - Side-effect check: revoking removes the "invited" member row (no orphan),
 *     enforced by the service + pinned by golden:signup-invite CASE I.
 *   - One primary action (the invite form).
 *
 * No-auto-outreach: the invite email is TRANSACTIONAL (sent to an email the
 * inviter typed). Pinned by golden:signup-invite CASE O.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, Badge, Button, Spinner, ConfirmModal, Dropdown, DropdownItem, DropdownSeparator, DropdownLabel } from "@/components/ui";
import { MoreHorizontal, UserMinus, UserPlus, Users, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Ticket } from "@/lib/types";

type Member = {
  id: string;
  userId?: string | null;
  email: string;
  name?: string;
  role: string;
  status: string;
};

type Invite = {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string;
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  sales_member: "Sales Member",
  viewer: "Viewer",
};

export function TeamInvites({ onHandoverTickets }: { onHandoverTickets?: (userId: string) => void } = {}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [unfinishedByUser, setUnfinishedByUser] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  // F10 (2026-08-04 CONTINUOUS-2 audit): Revoke is destructive (invalidates the
  // invitee's link + removes the member row). Every other destructive action in
  // the workspace is confirmed; this was the exception. Track the candidate to
  // confirm before the POST fires.
  const [revokeCandidate, setRevokeCandidate] = useState<Invite | null>(null);

  // 2026-09-28 (S3): remove a member / change a role. Who is looking decides
  // which choices are offered; the server enforces the same rules.
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<Member | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteDeliveryFailed, setInviteDeliveryFailed] = useState(false);

  // Invite form state.
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "sales_member" | "viewer">("sales_member");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [mems, invs, status, tickets] = await Promise.all([
        api<Member[]>("/api/workspace-members"),
        api<Invite[]>("/api/invites"),
        api<{ user?: { id: string; role: string } | null }>("/api/auth/status"),
        api<Ticket[]>("/api/tickets"),
      ]);
      setMembers(mems);
      setInvites(invs);
      setMe(status.user ? { id: status.user.id, role: status.user.role } : null);
      setUnfinishedByUser(tickets.reduce<Record<string, number>>((counts, ticket) => {
        if (ticket.assignedTo && !["resolved", "closed"].includes(ticket.status)) counts[ticket.assignedTo] = (counts[ticket.assignedTo] || 0) + 1;
        return counts;
      }, {}));
      setLoadFailed(false);
    } catch (e) {
      setLoadFailed(true);
      setError(e instanceof Error ? e.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function invite() {
    if (!email) return;
    setBusy("Sending invite...");
    setError(null);
    setNotice(null);
    setInviteDeliveryFailed(false);
    try {
      const result = await api<{ emailSent: boolean; emailUnconfirmed?: boolean }>("/api/invites", { method: "POST", body: JSON.stringify({ email, role }) });
      setInviteDeliveryFailed(result.emailSent !== true);
      setNotice(result.emailSent === true
        ? `Invitation email accepted for sending to ${email}. Ask them to check their inbox and spam folder for the join link.`
        : result.emailUnconfirmed
          ? `The invite for ${email} was saved, but email acceptance is unconfirmed. Check their inbox or the email provider before revoking or sending a fresh invite.`
          : `The invite for ${email} was saved, but the email was not sent. They cannot join from an email yet. Check email delivery, then revoke this pending invite and send a fresh one.`);
      setEmail("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the invite.");
    } finally { setBusy(""); }
  }

  async function revoke(inviteId: string) {
    setBusy("Revoking...");
    setError(null);
    try {
      await api(`/api/invites/${inviteId}/revoke`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke the invite.");
    } finally { setBusy(""); }
  }

  async function changeRole(member: Member, nextRole: string) {
    setBusy("Saving...");
    setError(null);
    setNotice(null);
    setInviteDeliveryFailed(false);
    try {
      await api(`/api/team/members/${member.id}/role`, { method: "POST", body: JSON.stringify({ role: nextRole }) });
      setNotice(`${member.name || member.email} is now ${ROLE_LABELS[nextRole] || nextRole}. They were signed out and will see the change when they sign in again.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the role.");
    } finally { setBusy(""); }
  }

  async function removeMember(member: Member) {
    setBusy("Removing...");
    setError(null);
    setNotice(null);
    setInviteDeliveryFailed(false);
    try {
      await api(`/api/team/members/${member.id}/remove`, { method: "POST", body: JSON.stringify({}) });
      setNotice(`${member.name || member.email} was removed and signed out. You can invite them again later.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove this person.");
    } finally { setBusy(""); }
  }

  /** What the person looking may do to this member (the server checks again). */
  function choicesFor(member: Member): string[] {
    if (!me || (me.role !== "owner" && me.role !== "admin")) return [];
    if (member.userId && member.userId === me.id) return [];
    if (me.role === "admin" && member.role === "owner") return [];
    const roles = me.role === "owner" ? ["owner", "admin", "sales_member", "viewer"] : ["admin", "sales_member", "viewer"];
    return roles.filter((r) => r !== member.role);
  }

  if (loading) {
    return (
      <Card title="Team & Invites" icon={Users}>
        <div className="flex justify-center py-8"><Spinner /></div>
      </Card>
    );
  }

  if (loadFailed) {
    return (
      <Card title="Team & Invites" icon={Users}>
        {notice && <p className="mb-3 text-sm text-foreground" role="status">{notice}</p>}
        <p className="mb-3 text-sm text-danger-fg" role="alert">Could not load your team. {error} Refresh the list before changing anyone&apos;s access.</p>
        <Button size="sm" onClick={load}>Try again</Button>
      </Card>
    );
  }

  const pendingInvites = invites.filter((i) => i.status === "pending");

  return (
    <Card title="Team & Invites" icon={Users}>
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-danger-border bg-danger-subtle p-2 text-sm text-danger-fg">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className={`mb-3 rounded-md border p-2 text-sm ${inviteDeliveryFailed ? "border-warning-border bg-warning-subtle text-warning-fg" : "border-success-border bg-success-subtle text-success-fg"}`}>
          {notice}
        </div>
      )}

      {/* Invite form */}
      <div className="mb-4 rounded-md border border-border-subtle bg-surface-muted p-3">
        <div className="flex items-center gap-2 mb-2">
          <UserPlus className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Invite a team member</span>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {/* 2026-08-05 (audit F-9): label association. */}
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-foreground-muted mb-1" htmlFor="team-invite-email">Email</label>
            <input
              id="team-invite-email" autoComplete="email"
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@business.com"
              className="w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-foreground-muted mb-1" htmlFor="team-invite-role">Role</label>
            <select
              id="team-invite-role"
              value={role} onChange={(e) => setRole(e.target.value as typeof role)}
              className="rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            >
              <option value="sales_member">Sales Member</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <Button size="sm" onClick={invite} loading={!!busy} disabled={!email}>
            {busy || "Send invite"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-foreground-muted">
          Joining requires a delivered invite email. The invitee sets their own password when they accept.
        </p>
      </div>

      {/* Members */}
      <div className="mb-4">
        <h4 className="text-sm font-medium text-foreground mb-2">Members ({members.filter((m) => m.status === "active").length})</h4>
        <p className="mb-2 text-xs text-muted">Hand over unfinished tickets before removing someone or changing them to a Viewer. You choose the new person for each ticket.</p>
        {members.filter((m) => m.status === "active").length === 0 ? (
          // F-UI-6 (2026-08-04 build-right audit): dead-end "No X" copy → add a
          // one-line hint pointing to the invite form below (Empty-State Honesty).
          <p className="text-sm text-foreground-muted py-2">No active members yet. Invite your first teammate using the form above.</p>
        ) : (
          <ul className="space-y-1">
            {members.filter((m) => m.status === "active").map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-sm">
                <span className="text-foreground">{m.name || m.email} <span className="text-foreground-muted">· {m.email}</span></span>
                <span className="flex items-center gap-2">
                  {m.userId && unfinishedByUser[m.userId] > 0 && <>{onHandoverTickets ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => onHandoverTickets(m.userId!)}>Hand over {unfinishedByUser[m.userId]} {unfinishedByUser[m.userId] === 1 ? "ticket" : "tickets"}</Button> : <Badge tone="warning">{unfinishedByUser[m.userId]} unfinished tickets</Badge>}</>}
                  <Badge tone={m.role === "owner" ? "info" : "neutral"}>{ROLE_LABELS[m.role] || m.role}</Badge>
                  {choicesFor(m).length > 0 && (
                    <Dropdown trigger={<Button variant="ghost" size="sm" icon={MoreHorizontal} aria-label={`Change access for ${m.name || m.email}`} disabled={!!busy} />}>
                      <DropdownLabel>Change role to</DropdownLabel>
                      {choicesFor(m).map((r) => (
                        <DropdownItem key={r} onSelect={() => changeRole(m, r)}>{ROLE_LABELS[r]}</DropdownItem>
                      ))}
                      <DropdownSeparator />
                      <DropdownItem icon={UserMinus} tone="danger" onSelect={() => setRemoveCandidate(m)}>Remove from team</DropdownItem>
                    </Dropdown>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pending invites */}
      <div>
        <h4 className="text-sm font-medium text-foreground mb-2">Pending invites ({pendingInvites.length})</h4>
        {pendingInvites.length === 0 ? (
          <p className="text-sm text-foreground-muted py-2">No pending invites. Use the form above to invite a teammate by email.</p>
        ) : (
          <ul className="space-y-1">
            {pendingInvites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between rounded-md border border-border-subtle px-3 py-1.5 text-sm">
                <span className="text-foreground">{inv.email} <span className="text-foreground-muted">· {ROLE_LABELS[inv.role] || inv.role}</span></span>
                <Button variant="ghost" size="sm" icon={X} onClick={() => setRevokeCandidate(inv)} loading={!!busy}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* F10 (2026-08-04 CONTINUOUS-2 audit): confirm before revoking — the
          invitee's link stops working immediately and the member row is removed. */}
      <ConfirmModal
        open={revokeCandidate !== null}
        onClose={() => setRevokeCandidate(null)}
        title="Revoke this invite?"
        confirmLabel="Revoke invite"
        tone="danger"
        onConfirm={() => { const c = revokeCandidate; setRevokeCandidate(null); if (c) revoke(c.id); }}
      >
        {revokeCandidate ? (
          <>{revokeCandidate.email}&apos;s link will stop working immediately. They will need a fresh invite to join your workspace.</>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={removeCandidate !== null}
        onClose={() => setRemoveCandidate(null)}
        title="Remove from your team?"
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => { const c = removeCandidate; setRemoveCandidate(null); if (c) removeMember(c); }}
      >
        {removeCandidate ? (
          <>{removeCandidate.name || removeCandidate.email} will be signed out right away and can no longer open this company. Their past work stays. You can invite them again later.{removeCandidate.userId && unfinishedByUser[removeCandidate.userId] > 0 ? <p className="mt-2 font-medium text-warning-fg">They still have {unfinishedByUser[removeCandidate.userId]} unfinished tickets. Hand those tickets over before removing access.</p> : null}</>
        ) : null}
      </ConfirmModal>
    </Card>
  );
}
