/**
 * 2026-07-21 (M9) — Workspace settings screen.
 *
 * Includes:
 *   - Kill-switch toggle (panic button). When ON, all auto-outreach is
 *     blocked across the workspace immediately. Owner-only.
 *   - Insights notebook — owner's free-text notes that surface as
 *     reminders on campaign setup. The system NEVER auto-modifies
 *     campaigns based on insights (per docs/LOGIC.md 2026-07-21).
 *
 * Uses the new design system + displayLabel.
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useEffect, useRef, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, ConfirmModal, Tabs, TabPanel } from "@/components/ui";
import { AlertTriangle, Zap, Plus, Lightbulb, BarChart3, Clock } from "lucide-react";
// Stage A+ / Cluster 10a (P2-3): shared api() chokepoint.
import { api } from "@/lib/api-client";
// Stage 5 / WP1 (2026-07-28) — Team & Invites panel.
import { TeamInvites } from "@/app/sections/TeamInvites";
// 2026-09-28 — the owner's own WhatsApp morning summary + urgent alerts.
import { OwnerAlertsSettings } from "@/app/sections/OwnerAlertsSettings";
import { AccountSecurity } from "@/app/sections/AccountSecurity";
// 2026-09-28 (M10) — closed days (holidays) for the reply-deadline clock.
import { ClosedDatesEditor, type ClosedDate } from "@/app/sections/ClosedDatesEditor";
import { FestivalRules } from "@/app/sections/FestivalRules";

type InsightEntry = {
  id: string;
  payload?: { note?: string };
  createdAt: string;
};

type KillSwitchState = { autonomyKillSwitch: boolean; autoSendToggle: boolean };

type DigestPayload = {
  day?: string;
  totalCampaignsRun?: number;
  totalLeadsDiscovered?: number;
  totalDraftsGenerated?: number;
  totalErrors?: number;
};

type DigestEntry = {
  id: string;
  eventType: string;
  payload?: DigestPayload;
  createdAt: string;
} | null;

/**
 * One row of the auto-rule editor. `match` fields are optional on the wire —
 * "Any" is sent as an absent key, because `ruleMatchesTicket` skips a field
 * that is undefined and would compare against the literal string otherwise.
 */
type AssignmentRuleDraft = {
  priority: string;
  type: string;
  sourceChannel: string;
  assignToUserId: string;
};

type SlaSettingsView = {
  clockMode?: "business_hours" | "always_24_7" | "mixed";
  businessHoursStart?: string;
  businessHoursEnd?: string;
  businessDays?: number[];
  closedDates?: ClosedDate[];
  urgentSlaMinutes?: number;
  highSlaMinutes?: number;
  mediumSlaMinutes?: number;
  lowSlaMinutes?: number;
  assignmentMode?: "manual" | "auto_rule" | "round_robin";
  assignmentRules?: { match?: { priority?: string; type?: string; sourceChannel?: string }; assignToUserId: string }[];
};

/**
 * WorkspaceMember.userId is null until an invite is accepted, and
 * TicketService drops those before round-robin. A pending invitee must not be
 * offerable as an assignee here either.
 */
type WorkspaceMemberView = { userId?: string | null; name?: string; email?: string; status?: string; role?: string };

const TICKET_PRIORITIES = ["urgent", "high", "medium", "low"];
const TICKET_TYPES = ["problem", "complaint", "question", "request", "refund", "return", "delivery", "quality"];
// Ticket.sourceChannel is a free string; these are the values the product
// actually writes (see the comment on Ticket.sourceChannel in lib/types.ts).
const TICKET_CHANNELS = ["whatsapp", "email", "manual"];

// (Stage A+ / Cluster 10a) local api() removed — imported from @/lib/api-client.

/**
 * 2026-09-28 (M9): a deadline in minutes of working time, said the way the
 * owner thinks of it — "4 working hours", "3 working days" — using this
 * company's own day length.
 */
function describeWorkingTime(minutes: number | undefined, start: string, end: string): string {
  if (!minutes) return "not set";
  const toMin = (t: string) => { const [h, m] = t.split(":").map((p) => parseInt(p, 10)); return (h || 0) * 60 + (m || 0); };
  const dayLength = Math.max(0, toMin(end) - toMin(start));
  if (dayLength > 0 && minutes >= dayLength) {
    const days = Math.round((minutes / dayLength) * 10) / 10;
    return `${days} working day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} working hour${hours === 1 ? "" : "s"}`;
}

export function WorkspaceSettings({ onHandoverTickets, role = 'owner', initialSection = 'workspace-messages' }: { onHandoverTickets?: (userId: string) => void; role?: string; initialSection?: string } = {}) {
  const [activeSection, setActiveSection] = useState(initialSection);
  const [ks, setKs] = useState<KillSwitchState | null>(null);
  const [insights, setInsights] = useState<InsightEntry[]>([]);
  const [digest, setDigest] = useState<DigestEntry>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
    // 2026-08-05 E-P1-1: action errors show inline (list stays visible), not full-screen wipe.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [newNote, setNewNote] = useState("");
  // 2026-07-26 Session 4 (P2-DESIGN-1): business-hours editor state. Operator
  // directive: "the business hours will be actually set by the user." Default
  // values match src/lib/ticket-sla.ts DEFAULT_*; load() fetches the per-
  // workspace overrides (if any).
  const [slaClockMode, setSlaClockMode] = useState<"business_hours" | "always_24_7" | "mixed">("business_hours");
  const [slaStart, setSlaStart] = useState("09:00");
  const [slaEnd, setSlaEnd] = useState("18:00");
  const [slaDays, setSlaDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [slaDirty, setSlaDirtyState] = useState(false);
  const slaDirtyRef = useRef(false);
  function setSlaDirty(value: boolean) {
    slaDirtyRef.current = value;
    setSlaDirtyState(value);
  }
  const [slaError, setSlaError] = useState<string | null>(null);
  const [slaClosedDates, setSlaClosedDates] = useState<ClosedDate[]>([]);
  const [slaDeadlines, setSlaDeadlines] = useState<{ urgent?: number; high?: number; medium?: number; low?: number }>({});

  // Session 55 — who a newly raised ticket goes to. `assignTicket` has
  // implemented all three modes since 2026-07-21 and runs on every ticket
  // create, but nothing could move the workspace off "manual", so a complaint
  // that raised a ticket always landed unassigned.
  const [assignMode, setAssignMode] = useState<"manual" | "auto_rule" | "round_robin">("manual");
  const [assignRules, setAssignRules] = useState<AssignmentRuleDraft[]>([]);
  const [staff, setStaff] = useState<{ userId: string; name: string }[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [ksData, ins, dig, sla, members] = await Promise.all([
        api<KillSwitchState>("/api/workspace/kill-switch"),
        api<InsightEntry[]>("/api/workspace/insights").catch(() => [] as InsightEntry[]),
        api<DigestEntry>("/api/workspace/digest/latest").catch(() => null),
        // SLA settings — fall back to defaults if the route 404s (older deploy).
        api<SlaSettingsView>("/api/tickets/sla-settings").catch(() => ({}) as SlaSettingsView),
        api<WorkspaceMemberView[]>("/api/workspace-members").catch(() => [] as WorkspaceMemberView[]),
      ]);
      setKs(ksData);
      setInsights(ins);
      setDigest(dig);
      // Refreshing notes or holidays must not replace a ticket-handling draft.
      if (!slaDirtyRef.current) {
        if (sla.clockMode) setSlaClockMode(sla.clockMode);
        if (sla.businessHoursStart) setSlaStart(sla.businessHoursStart);
        if (sla.businessHoursEnd) setSlaEnd(sla.businessHoursEnd);
        if (sla.businessDays) setSlaDays(sla.businessDays);
        setSlaClosedDates(Array.isArray(sla.closedDates) ? sla.closedDates : []);
        setSlaDeadlines({ urgent: sla.urgentSlaMinutes, high: sla.highSlaMinutes, medium: sla.mediumSlaMinutes, low: sla.lowSlaMinutes });
        if (sla.assignmentMode) setAssignMode(sla.assignmentMode);
        setAssignRules(
          (sla.assignmentRules || []).map((rule) => ({
            priority: rule.match?.priority || "",
            type: rule.match?.type || "",
            sourceChannel: rule.match?.sourceChannel || "",
            assignToUserId: rule.assignToUserId,
          })),
        );
        setSlaDirty(false);
      }
      setStaff(
        members
          .filter((member) => member.userId && member.status === "active" && member.role !== "viewer")
          .map((member) => ({ userId: member.userId as string, name: member.name || member.email || (member.userId as string) })),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load";
      if (ks) setActionError(message);
      else setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // S6 U-3: confirm-dialog state for the two destructive workspace toggles.
  const [pendingToggle, setPendingToggle] = useState<null | "killSwitch" | "autoSend">(null);

  async function toggleKillSwitch() {
    if (!ks) return;
    const next = !ks.autonomyKillSwitch;
    // S6 U-3: was window.confirm() — replaced with an accessible ConfirmModal.
    if (next) { setPendingToggle("killSwitch"); return; }
    await doToggleKillSwitch();
  }
  async function doToggleKillSwitch() {
    if (!ks) return;
    const next = !ks.autonomyKillSwitch;
    setBusy("Updating...");
    try {
      const result = await api<{ autonomyKillSwitch: boolean; autoSendToggle: boolean }>("/api/workspace/kill-switch", {
        method: "POST",
        body: { autonomyKillSwitch: next },
      });
      setKs({ ...(ks || { autoSendToggle: false }), autonomyKillSwitch: result.autonomyKillSwitch });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy("");
    }
  }

  /**
   * R4 2026-07-21 — Toggle the per-customer auto-send opt-in.
   * Per docs/LOGIC.md 2026-07-21 (Q13): the toggle is SEPARATE from the
   * kill-switch. Turning the toggle ON does nothing while the kill-switch
   * is engaged (AutoSendGate checks kill-switch first). Default OFF.
   */
  async function toggleAutoSend() {
    if (!ks) return;
    const next = !ks.autoSendToggle;
    // S6 U-3: was window.confirm() — replaced with an accessible ConfirmModal.
    if (next) { setPendingToggle("autoSend"); return; }
    await doToggleAutoSend();
  }
  async function doToggleAutoSend() {
    if (!ks) return;
    const next = !ks.autoSendToggle;
    setBusy("Updating...");
    try {
      const result = await api<{ autoSendToggle: boolean }>("/api/workspace/kill-switch", {
        method: "POST",
        body: { autoSendToggle: next },
      });
      setKs({ ...ks, autoSendToggle: result.autoSendToggle });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy("");
    }
  }

  async function saveInsight() {
    if (!newNote.trim()) return;
    setBusy("Saving...");
    try {
      await api("/api/workspace/insights", {
        method: "POST",
        body: { note: newNote.trim() },
      });
      setNewNote("");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy("");
    }
  }

  // 2026-07-26 Session 4 (P2-DESIGN-1) — save the per-workspace SLA business
  // hours. Owner-only at the API; the form posts whatever fields are dirty.
  async function saveSla() {
    setBusy("Saving ticket handling...");
    setSlaError(null);
    try {
      await api("/api/tickets/sla-settings", {
        method: "POST",
        body: {
          clockMode: slaClockMode,
          businessHoursStart: slaStart,
          businessHoursEnd: slaEnd,
          businessDays: slaDays,
          closedDates: slaClosedDates,
          assignmentMode: assignMode,
          // Only auto_rule consults rules; sending them in the other modes
          // would persist half-filled rows the operator abandoned.
          ...(assignMode === "auto_rule"
            ? {
              assignmentRules: assignRules
                .filter((rule) => rule.assignToUserId)
                .map((rule) => ({
                  // "Any" is an absent key, not an empty string —
                  // ruleMatchesTicket compares a present field literally.
                  match: {
                    ...(rule.priority ? { priority: rule.priority } : {}),
                    ...(rule.type ? { type: rule.type } : {}),
                    ...(rule.sourceChannel ? { sourceChannel: rule.sourceChannel } : {}),
                  },
                  assignToUserId: rule.assignToUserId,
                })),
            }
            : {}),
        },
      });
      setSlaDirty(false);
    } catch (e) {
      setSlaError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy("");
    }
  }

  if (loading && !ks) {
    return (
      <Card title="Workspace" icon={Zap}>
        <div className="flex items-center gap-2 justify-center py-8 text-muted">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Workspace" icon={AlertTriangle}>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load"
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

  return (
    <div className="space-y-4">
      {actionBanner}
      <div className="rounded-lg border border-border-subtle bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Workspace settings</h2>
            <p className="mt-1 text-sm text-muted">Choose a section to manage your company and team.</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Current message safety">
            <Badge tone={ks?.autonomyKillSwitch ? "warning" : "neutral"}>
              {ks?.autonomyKillSwitch ? "Automatic messages paused" : "Automatic messages not paused"}
            </Badge>
            <Badge tone={ks?.autoSendToggle ? "warning" : "neutral"}>
              {ks?.autoSendToggle ? "First messages: automatic checks" : "First messages: drafts only"}
            </Badge>
          </div>
        </div>
        {(slaDirty || newNote.trim()) && (
          <p role="status" className="mt-3 text-sm text-warning-fg">
            {slaDirty && "Ticket handling has unsaved changes. "}
            {newNote.trim() && "Your new note has not been added yet. "}
            Switching sections keeps your edits; save them before leaving Workspace.
          </p>
        )}
      </div>
      <Tabs
        tabs={[
          { id: "workspace-messages", label: "Message controls" },
          { id: "workspace-tickets", label: "Ticket handling" },
          { id: "workspace-team", label: "Team" },
          ...(role === "owner" ? [{ id: "workspace-notifications", label: "Notifications" }] : []),
          { id: "workspace-notes", label: "Notes and activity" },
          { id: "workspace-security", label: "Sign-in" },
        ]}
        activeTab={activeSection}
        onSelect={setActiveSection}
      />
      {/* Keep panels mounted so navigating tabs never discards a child's draft. */}
      <TabPanel tabId="workspace-messages" hidden={activeSection !== "workspace-messages"}>
        <div className="space-y-4">
      {/* Kill-switch — the panic button */}
      {/* 2026-09-29 (owner walk-through W1): same switches, owner words —
          "kill-switch", "audit log", "11-condition safety gate", "scheduler",
          "SLA clock" and "round robin" meant nothing to an owner. */}
      <Card title="Stop all automatic messages" icon={AlertTriangle}>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Your emergency stop. While it is on, nothing is sent to any customer
            by itself — no automatic replies, no first messages, no price-change
            messages. Finding new buyers and drafting still carry on; everything
            waits for you.
          </p>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-surface-muted p-3">
            <div>
              <p className="label">Current state</p>
              <Badge tone={ks?.autonomyKillSwitch ? "danger" : "success"}>
                {ks?.autonomyKillSwitch ? "On — nothing goes out by itself" : "Off — automatic messages allowed"}
              </Badge>
            </div>
            <div className="ml-auto">
              <Button
                variant={ks?.autonomyKillSwitch ? "primary" : "danger"}
                loading={busy === "Updating..."}
                onClick={toggleKillSwitch}
              >
                {ks?.autonomyKillSwitch ? "Let messages go out again" : "Stop all automatic messages"}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted">
            Every change is recorded in &quot;Who did what&quot;, with who did it and when.
          </p>
        </div>
      </Card>

      {/* R4 — Auto-send toggle (per-customer opt-in for auto-first-message) */}
      <Card title="First message to new buyers" icon={Zap}>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            When on, the morning routine may send the first WhatsApp message to
            a good new buyer by itself — only if every safety check passes (they
            agreed to be contacted, it is daytime, the daily limit is not
            reached, and the message uses a template WhatsApp approved). When
            off (recommended), the first message is <strong>drafted</strong> and
            waits for you to approve it.
          </p>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-surface-muted p-3">
            <div>
              <p className="label">Current state</p>
              <Badge tone={ks?.autoSendToggle ? "warning" : "neutral"}>
                {ks?.autoSendToggle ? "On — may send by itself when every check passes" : "Off — drafts only (recommended)"}
              </Badge>
            </div>
            <div className="ml-auto">
              <Button
                variant={ks?.autoSendToggle ? "secondary" : "primary"}
                loading={busy === "Updating..."}
                onClick={toggleAutoSend}
              >
                {ks?.autoSendToggle ? "Turn off" : "Turn on"}
              </Button>
            </div>
          </div>
          {ks?.autonomyKillSwitch && (
            <p className="rounded-md bg-warning-bg p-2 text-xs text-warning-fg">
              ⚠ &quot;Stop all automatic messages&quot; is on. Nothing will go out by
              itself until you turn that off.
            </p>
          )}
          <p className="text-xs text-muted">
            Every message sent this way is recorded in &quot;Who did what&quot;.
          </p>
        </div>
      </Card>

        </div>
      </TabPanel>
      <TabPanel tabId="workspace-tickets" hidden={activeSection !== "workspace-tickets"}>
      {/* 2026-07-26 Session 4 (P2-DESIGN-1) — Business hours editor.
          Operator directive: "the business hours will be actually set by
          the user. As the customer wants to put seven days, it will be seven
          days. If a customer wants six days, it will be six days." */}
      <Card title="Working hours, holidays and who handles problems" icon={Clock}>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Your working days and hours. Reply deadlines for customer problems
            only count working time — a problem that comes in at night waits
            until your next working hour (unless you choose &quot;always on&quot; below).
          </p>
          <div className="space-y-3 rounded-md border border-border-subtle bg-surface-muted p-3">
            <div>
              <label htmlFor="sla-clock-mode" className="label">When deadlines count</label>
              <select
                id="sla-clock-mode"
                className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
                value={slaClockMode}
                onChange={(e) => { setSlaClockMode(e.target.value as typeof slaClockMode); setSlaDirty(true); }}
              >
                <option value="business_hours">Only in working hours</option>
                <option value="always_24_7">Always on, day and night</option>
                <option value="mixed">Urgent problems always; the rest in working hours</option>
              </select>
            </div>

            {slaClockMode !== "always_24_7" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="sla-start" className="label">Day starts at</label>
                    <input
                      id="sla-start"
                      type="time"
                      className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
                      value={slaStart}
                      onChange={(e) => { setSlaStart(e.target.value); setSlaDirty(true); }}
                    />
                  </div>
                  <div>
                    <label htmlFor="sla-end" className="label">Day ends at</label>
                    <input
                      id="sla-end"
                      type="time"
                      className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
                      value={slaEnd}
                      onChange={(e) => { setSlaEnd(e.target.value); setSlaDirty(true); }}
                    />
                  </div>
                </div>

                <div>
                  <p className="label">Working days</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {[
                      { num: 1, label: "Mon" },
                      { num: 2, label: "Tue" },
                      { num: 3, label: "Wed" },
                      { num: 4, label: "Thu" },
                      { num: 5, label: "Fri" },
                      { num: 6, label: "Sat" },
                      { num: 7, label: "Sun" },
                    ].map((day) => {
                      const active = slaDays.includes(day.num);
                      return (
                        <button
                          key={day.num}
                          type="button"
                          onClick={() => {
                            setSlaDays(active ? slaDays.filter((d) => d !== day.num) : [...slaDays, day.num].sort());
                            setSlaDirty(true);
                          }}
                          className={`rounded-md border px-3 py-1.5 text-sm transition ${
                            active
                              ? "border-primary bg-primary-tint text-primary-strong"
                              : "border-border-default bg-surface text-muted hover:text-foreground"
                          }`}
                          aria-pressed={active}
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Currently set: {slaDays.length === 0 ? "no working days — pick at least one before saving" : `${slaDays.length} day${slaDays.length === 1 ? "" : "s"}`}.
                  </p>
                </div>

                {slaDeadlines.low ? (
                  <p className="text-xs text-muted">
                    Reply deadlines count working time only: urgent {describeWorkingTime(slaDeadlines.urgent, slaStart, slaEnd)},
                    high {describeWorkingTime(slaDeadlines.high, slaStart, slaEnd)},
                    medium {describeWorkingTime(slaDeadlines.medium, slaStart, slaEnd)},
                    low {describeWorkingTime(slaDeadlines.low, slaStart, slaEnd)}.
                  </p>
                ) : null}

                <details className="rounded-md border border-border-subtle bg-surface p-3">
                  <summary className="cursor-pointer text-sm font-medium text-foreground">Holidays and closed dates</summary>
                  <div className="mt-3 space-y-3">
                <FestivalRules onSaved={() => void load()} />
                <ClosedDatesEditor
                  value={slaClosedDates}
                  onChange={(next) => { setSlaClosedDates(next); setSlaDirty(true); }}
                />
                  </div>
                </details>
              </>
            )}

            <div className="border-t border-border-subtle pt-3">
              <label htmlFor="ticket-assignment-mode" className="label">Who a new ticket goes to</label>
              <select
                id="ticket-assignment-mode"
                className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
                value={assignMode}
                onChange={(e) => { setAssignMode(e.target.value as typeof assignMode); setSlaDirty(true); }}
              >
                <option value="manual">Nobody — you pick a person on each ticket</option>
                <option value="round_robin">Take turns across your team</option>
                <option value="auto_rule">By rule (route on priority, type or channel)</option>
              </select>
              <p className="mt-1 text-xs text-muted">
                Applies when a ticket is raised, including the ones the AI raises
                from a customer complaint. Only people who have accepted their
                invite can be assigned.
              </p>

              {assignMode === "round_robin" && staff.length === 0 && (
                <p className="mt-2 rounded-md bg-warning-bg p-2 text-xs text-warning-fg">
                  Nobody has accepted an invite yet, so round robin has no one to
                  hand a ticket to and every ticket will stay unassigned.
                </p>
              )}

              {assignMode === "auto_rule" && (
                <div className="mt-3 space-y-2">
                  {assignRules.length === 0 && (
                    <p className="text-xs text-muted">
                      No rules yet. Until you add one, no ticket will be assigned
                      to anybody.
                    </p>
                  )}
                  {assignRules.map((rule, index) => (
                    <div key={index} className="flex flex-wrap items-end gap-2 rounded-md border border-border-subtle bg-surface p-2">
                      {([
                        { key: "priority" as const, label: "Priority", options: TICKET_PRIORITIES },
                        { key: "type" as const, label: "Type", options: TICKET_TYPES },
                        { key: "sourceChannel" as const, label: "Channel", options: TICKET_CHANNELS },
                      ]).map((field) => (
                        <div key={field.key}>
                          <label htmlFor={`rule-${index}-${field.key}`} className="label text-xs">{field.label}</label>
                          <select
                            id={`rule-${index}-${field.key}`}
                            className="mt-1 rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
                            value={rule[field.key]}
                            onChange={(e) => {
                              setAssignRules(assignRules.map((r, i) => (i === index ? { ...r, [field.key]: e.target.value } : r)));
                              setSlaDirty(true);
                            }}
                          >
                            <option value="">Any</option>
                            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </div>
                      ))}
                      <div className="min-w-40 flex-1">
                        <label htmlFor={`rule-${index}-assignee`} className="label text-xs">Goes to</label>
                        <select
                          id={`rule-${index}-assignee`}
                          className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
                          value={rule.assignToUserId}
                          onChange={(e) => {
                            setAssignRules(assignRules.map((r, i) => (i === index ? { ...r, assignToUserId: e.target.value } : r)));
                            setSlaDirty(true);
                          }}
                        >
                          <option value="">Pick a person</option>
                          {staff.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
                        </select>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => { setAssignRules(assignRules.filter((_, i) => i !== index)); setSlaDirty(true); }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setAssignRules([...assignRules, { priority: "", type: "", sourceChannel: "", assignToUserId: "" }]);
                      setSlaDirty(true);
                    }}
                  >
                    <Plus className="h-4 w-4" /> Add a rule
                  </Button>
                  <p className="text-xs text-muted">
                    Checked from the top down; the first rule that matches wins. A
                    rule with everything set to Any matches every ticket, so keep
                    that one last.
                  </p>
                </div>
              )}
            </div>

            {slaError && (
              <p role="alert" className="rounded-md bg-danger-bg p-2 text-sm text-danger-fg">
                {slaError}
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button
                onClick={saveSla}
                disabled={!slaDirty || busy !== ""}
                loading={busy === "Saving ticket handling..."}
              >
                Save ticket handling
              </Button>
              {slaDirty && <span className="text-xs text-muted">Unsaved changes</span>}
              {!slaDirty && <span className="text-xs text-muted">All changes saved</span>}
            </div>
          </div>
          <p className="text-xs text-muted">
            Owner-only. Changes affect every ticket&apos;s due-date calculation from
            this point forward (existing due-dates are not recomputed).
          </p>
        </div>
      </Card>

      </TabPanel>
      <TabPanel tabId="workspace-team" hidden={activeSection !== "workspace-team"}>
        <TeamInvites onHandoverTickets={onHandoverTickets} />
      </TabPanel>
      {role === "owner" && (
        <TabPanel tabId="workspace-notifications" hidden={activeSection !== "workspace-notifications"}>
          <OwnerAlertsSettings />
        </TabPanel>
      )}
      <TabPanel tabId="workspace-notes" hidden={activeSection !== "workspace-notes"}>
        <div className="space-y-4">
      {/* Insights notebook */}
      <Card title="Your notes" icon={Lightbulb}>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Write down what you are learning about your customers. These notes
            come back to you when you plan a new search for buyers. The system
            never changes anything because of them — that is always your call.
          </p>

          <div className="flex gap-2">
            <textarea
              className="input flex-1"
              rows={2}
              aria-label="New workspace note"
              placeholder="e.g. Surat leads reply much faster than Mumbai. Focus more on Surat."
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
            <Button
              icon={Plus}
              loading={busy === "Saving..."}
              onClick={saveInsight}
              disabled={!newNote.trim()}
            >
              Add
            </Button>
          </div>

          {insights.length === 0 ? (
            <p className="text-sm text-muted">No insights yet. Add your first note above.</p>
          ) : (
            <ul className="space-y-2">
              {insights.map((i) => (
                <li key={i.id} className="rounded-md border border-border-subtle bg-surface-muted p-2 text-sm">
                  <p className="text-foreground">{i.payload?.note || "(no text)"}</p>
                  <p className="mt-1 text-xs text-muted">{formatDateTime(i.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* Latest daily digest (from the scheduler) */}
      {digest && digest.payload && (
        <Card title={`Daily digest — ${digest.payload.day || "latest"}`} icon={BarChart3}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <p className="label">Searches run</p>
              <p className="text-xl font-semibold text-foreground">{digest.payload.totalCampaignsRun ?? 0}</p>
            </div>
            <div>
              <p className="label">New buyers found</p>
              <p className="text-xl font-semibold text-foreground">{digest.payload.totalLeadsDiscovered ?? 0}</p>
            </div>
            <div>
              <p className="label">Messages drafted</p>
              <p className="text-xl font-semibold text-foreground">{digest.payload.totalDraftsGenerated ?? 0}</p>
            </div>
            <div>
              <p className="label">Problems</p>
              <p className={`text-xl font-semibold ${(digest.payload.totalErrors ?? 0) > 0 ? "text-danger-fg" : "text-foreground"}`}>
                {digest.payload.totalErrors ?? 0}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            Generated {formatDateTime(digest.createdAt)}.
            The morning routine runs Monday to Saturday at 9:00.
          </p>
        </Card>
      )}


        </div>
      </TabPanel>
      <TabPanel tabId="workspace-security" hidden={activeSection !== "workspace-security"}>
        <AccountSecurity />
      </TabPanel>
      {/* S6 U-3: accessible confirmation for the kill-switch + auto-send toggles (was window.confirm). */}
      <ConfirmModal
        open={pendingToggle !== null}
        title={pendingToggle === "killSwitch" ? "Stop all automatic messages?" : "Let the first message go out by itself?"}
        confirmLabel={pendingToggle === "killSwitch" ? "Stop them" : "Turn on"}
        tone="danger"
        onConfirm={() => {
          const t = pendingToggle;
          setPendingToggle(null);
          if (t === "killSwitch") void doToggleKillSwitch();
          else if (t === "autoSend") void doToggleAutoSend();
        }}
        onClose={() => setPendingToggle(null)}
      >
        {pendingToggle === "killSwitch"
          ? "Nothing will be sent to any customer by itself until you turn this off again. Drafts still wait for you."
          : "The first WhatsApp message to a good new buyer may go out by itself, only when every safety check passes. It is still drafted either way, and you can turn this off at any time."}
      </ConfirmModal>

    </div>
  );
}
