/**
 * 2026-07-21 (M10) — Compliance screen (Consent + DPDPA Erasure).
 *
 * Per docs/LOGIC.md 2026-07-21:
 *   - Outreach consent defaults to "none" for new prospects. Owner must
 *     explicitly upgrade to legitimate_interest/consent/inbound.
 *   - DPDPA right-to-erasure: owner-only, two-step name confirmation,
 *     cascade-deletes (anonymizes in demo mode), preserves audit log.
 *
 * Uses the new design system + displayLabel.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, Modal } from "@/components/ui";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui";
import { ShieldCheck, Trash2, AlertCircle, ShieldOff } from "lucide-react";
// Stage A+ / Cluster 10a (P2-3): shared api() chokepoint.
import { api } from "@/lib/api-client";

type ConsentRow = {
  leadId: string;
  contactName: string;
  whatsappNumber?: string;
  email?: string;
  consentStatus: string;
  doNotContact?: boolean;
};

type ErasurePreview = {
  leadId: string;
  contactName?: string;
  counts: { replies: number; tickets: number; orders: number; quotes: number };
  confirmName: string;
};

// (Stage A+ / Cluster 10a) local api() removed — imported from @/lib/api-client.

function basisLabel(basis: string): string {
  switch (basis) {
    case "inbound": return "Inbound (they contacted us)";
    case "consent": return "Explicit consent";
    case "legitimate_interest": return "Legitimate interest";
    case "none": return "No basis set — outreach blocked";
    default: return basis;
  }
}

export function Compliance() {
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 2026-08-05 E-P1-1: separate action errors from load errors. Previously a
  // single consent-change failure wiped the whole table to "Couldn't load."
  // Now action errors show as an inline banner and the list stays visible.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [erasureTarget, setErasureTarget] = useState<ErasurePreview | null>(null);
  const [erasureError, setErasureError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<ConsentRow[]>("/api/consent");
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function changeBasis(leadId: string, basis: string) {
    setBusy(`Updating ${leadId}...`);
    try {
      const evidence = basis === "none"
        ? "Reset to none"
        : `Owner set basis to ${basis} on the Compliance screen.`;
      await api(`/api/consent/${leadId}`, {
        method: "POST",
        body: { basis, evidence },
      });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy("");
    }
  }

  // Cluster 7: owner-only "Remove from DNC" action. The backend endpoint
  // (POST /api/consent/:leadId/remove-dnc, added in Cluster 2 / D-2026-07-26-2)
  // is owner-only, requires a reason, clears the lead flag + removes the
  // permanent DNC registry entry, and audit-logs the action. The UI asks for
  // a reason via a prompt modal so the operator explicitly justifies it.
  const [dncRemoveTarget, setDncRemoveTarget] = useState<{ leadId: string; contactName: string } | null>(null);
  const [dncRemoveReason, setDncRemoveReason] = useState("");
  const [dncRemoveError, setDncRemoveError] = useState<string | null>(null);

  async function confirmRemoveDnc() {
    if (!dncRemoveTarget || busy) return;
    setDncRemoveError(null);
    if (!dncRemoveReason.trim()) {
      setDncRemoveError("A reason is required to remove a contact from the do-not-contact list.");
      return;
    }
    setBusy(`Removing ${dncRemoveTarget.contactName} from DNC...`);
    try {
      await api(`/api/consent/${dncRemoveTarget.leadId}/remove-dnc`, {
        method: "POST",
        body: { reason: dncRemoveReason.trim() },
      });
      setDncRemoveTarget(null);
      setDncRemoveReason("");
      await load();
    } catch (e) {
      setDncRemoveError(e instanceof Error ? e.message : "Remove-from-DNC failed");
    } finally {
      setBusy("");
    }
  }

  async function previewErasure(leadId: string) {
    setBusy("Loading preview...");
    try {
      const result = await api<ErasurePreview>(`/api/erasure/preview?leadId=${leadId}`);
      setErasureTarget(result);
      setErasureError(null);
      setConfirmName("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy("");
    }
  }

  async function confirmErasure() {
    if (!erasureTarget || busy) return;
    setErasureError(null);
    setBusy("Erasing...");
    try {
      await api(`/api/erasure/${erasureTarget.leadId}`, {
        method: "POST",
        body: { confirmName },
      });
      setErasureTarget(null);
      setConfirmName("");
      await load();
    } catch (e) {
      setErasureError(e instanceof Error ? e.message : "Erasure failed");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <Card title="Compliance" icon={ShieldCheck}>
        <div className="flex items-center gap-2 justify-center py-8 text-muted">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Compliance" icon={AlertCircle}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={error}
          action={<Button onClick={load}>Try again</Button>}
        />
      </Card>
    );
  }
  // 2026-08-05 E-P1-1: action errors show inline (list stays visible), not as
  // a full-screen wipe.
  const actionBanner = actionError ? (
    <div role="alert" className="mb-3 flex items-start justify-between gap-3 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg">
      <span>{actionError}</span>
      <button className="text-xs font-semibold underline" onClick={() => setActionError(null)}>Dismiss</button>
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      {actionBanner}
      <Card title="Outreach consent" icon={ShieldCheck}>
        <p className="mb-3 text-sm text-muted">
          Every prospect defaults to "No basis" until you explicitly set a lawful
          basis to contact them. Without a basis, automatic outreach is blocked.
          Choose the basis that matches how you came to contact this prospect.
        </p>
        {rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No prospects yet"
            description="Once you discover leads, they'll appear here so you can set their outreach consent basis."
          />
        ) : (
          <Table caption="Prospect consent">
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Contact</TableHead>
                {/* 2026-09-04 N-UX-38 — "Current basis" printed the value that
                    the "Change basis" dropdown beside it was already showing,
                    for every row. One column, which both states the value and
                    changes it. And "DPDPA erase" named the statute rather than
                    the act; the confirmation dialog still spells out the legal
                    basis, where it belongs. */}
                <TableHead>Allowed to contact because</TableHead>
                <TableHead>Do-not-contact</TableHead>
                <TableHead>Delete their data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.leadId}>
                  <TableCell><span className="font-semibold text-foreground">{r.contactName}</span></TableCell>
                  <TableCell className="text-xs text-muted">
                    {r.whatsappNumber && <div>{r.whatsappNumber}</div>}
                    {r.email && <div>{r.email}</div>}
                  </TableCell>
                  <TableCell>
                    <select
                      className="input input-sm"
                      value={r.consentStatus}
                      onChange={(e) => changeBasis(r.leadId, e.target.value)}
                      aria-label={`Change consent basis for ${r.contactName}`}
                    >
                      {/* 2026-09-04 — the option wording comes from basisLabel,
                          which is what the removed "Current basis" column used
                          to print. Keeping one source means the dropdown cannot
                          drift from the words used anywhere else, and it keeps
                          the "(default)" marker that told an operator this row
                          had never been set deliberately. */}
                      {(["none", "legitimate_interest", "consent", "inbound"] as const).map((basis) => (
                        <option key={basis} value={basis}>{basisLabel(basis)}</option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell>
                    {r.doNotContact ? (
                      <div className="flex flex-col gap-1">
                        <Badge tone="danger">Blocked</Badge>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={ShieldOff}
                          onClick={() => {
                            setDncRemoveTarget({ leadId: r.leadId, contactName: r.contactName });
                            setDncRemoveError(null);
                            setDncRemoveReason("");
                          }}
                          aria-label={`Remove ${r.contactName} from the do-not-contact list`}
                        >
                          Remove from DNC
                        </Button>
                      </div>
                    ) : (
                      <Badge tone="neutral">Not blocked</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* 2026-09-04 N-UX-39 — this was a filled red button, once
                        per row. Fifteen of them made the single most
                        destructive action on the product the loudest thing on
                        the screen, and drowned out the actual daily job here
                        (setting a lawful basis). Quiet control, red text, same
                        two-step confirmation behind it. */}
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-danger-fg"
                      icon={Trash2}
                      onClick={() => previewErasure(r.leadId)}
                      aria-label={`Erase customer data for ${r.contactName}`}
                    >
                      Erase
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {busy && <p className="mt-3 text-sm text-muted">{busy}</p>}
      </Card>

      {/* Erasure confirmation modal — two-step name confirmation */}
      <Modal
        open={erasureTarget !== null}
        onClose={() => { if (!busy) setErasureTarget(null); }}
        title="Erase customer data — DPDPA right to erasure"
        size="md"
        disableDismiss={Boolean(busy)}
      >
        {erasureTarget && (
          <fieldset disabled={Boolean(busy)} className="space-y-3">
            {erasureError && <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger-fg">{erasureError}</p>}
            <div className="rounded-md border border-danger-fg bg-danger-bg p-3 text-sm">
              <p className="font-semibold text-danger-fg">⚠ This action cannot be undone.</p>
              <p className="mt-1 text-danger-fg">
                The customer's personal data will be permanently removed. Their
                orders, quotes, tickets, and replies will be disassociated from
                their identity. The audit log entry is preserved (anonymized) for
                compliance.
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-surface-muted p-3 text-sm">
              <p className="font-semibold text-foreground">{erasureTarget.contactName}</p>
              <ul className="mt-2 space-y-1 text-muted">
                <li>{erasureTarget.counts.replies} message(s)</li>
                <li>{erasureTarget.counts.tickets} ticket(s)</li>
                <li>{erasureTarget.counts.orders} order(s)</li>
                <li>{erasureTarget.counts.quotes} quote(s)</li>
              </ul>
            </div>
            <div>
              <p className="label">Type the customer's name to confirm</p>
              <input
                className="input"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={erasureTarget.confirmName}
                aria-label="Type the customer name to confirm erasure"
              />
              <p className="mt-1 text-xs text-muted">
                Expected: <span className="font-mono">{erasureTarget.confirmName}</span>
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setErasureTarget(null)}>Cancel</Button>
              <Button
                variant="danger"
                loading={busy === "Erasing..."}
                disabled={Boolean(busy) || confirmName.trim() !== erasureTarget.confirmName}
                onClick={confirmErasure}
              >
                Permanently erase
              </Button>
            </div>
          </fieldset>
        )}
      </Modal>

      {/* Cluster 7: Remove-from-DNC confirmation modal — owner-only, requires a reason. */}
      <Modal
        open={dncRemoveTarget !== null}
        onClose={() => { if (!busy) setDncRemoveTarget(null); }}
        title="Remove from do-not-contact list"
        size="md"
        disableDismiss={Boolean(busy)}
      >
        {dncRemoveTarget && (
          <fieldset disabled={Boolean(busy)} className="space-y-3">
            {dncRemoveError && <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger-fg">{dncRemoveError}</p>}
            <div className="rounded-md border border-warning-fg bg-warning-bg p-3 text-sm">
              <p className="font-semibold text-warning-fg">⚠ This re-enables outreach to {dncRemoveTarget.contactName}.</p>
              <p className="mt-1 text-warning-fg">
                The customer was on the permanent do-not-contact list. Removing them
                re-enables WhatsApp/email outreach. Per policy, you must provide a reason
                (e.g. "customer explicitly asked us to contact them again on 2026-07-26").
                The action is audit-logged.
              </p>
            </div>
            <div>
              <label htmlFor="dnc-reason" className="label">Reason for removal <span className="text-danger-fg">*</span></label>
              <textarea
                id="dnc-reason"
                className="input mt-1 min-h-[80px]"
                value={dncRemoveReason}
                onChange={(e) => setDncRemoveReason(e.target.value)}
                placeholder="e.g. Customer replied on WhatsApp asking us to send the catalogue again."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setDncRemoveTarget(null)}>Cancel</Button>
              <Button
                variant="primary"
                loading={busy.startsWith("Removing ")}
                disabled={Boolean(busy) || !dncRemoveReason.trim()}
                onClick={confirmRemoveDnc}
              >
                Remove from DNC
              </Button>
            </div>
          </fieldset>
        )}
      </Modal>
    </div>
  );
}
