/**
 * 2026-09-28 — "Your sign-in" panel in Workspace settings: change password and
 * sign out everywhere (S4). Rules live in AccountSecurityService; this only
 * asks and shows the answer. Hidden in demo mode and on the public tour, where
 * there is no password to change.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, Button, ConfirmModal } from "@/components/ui";
import { KeyRound, LogOut } from "lucide-react";
import { api } from "@/lib/api-client";

export function AccountSecurity() {
  const [show, setShow] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [askEverywhere, setAskEverywhere] = useState(false);

  useEffect(() => {
    api<{ authMode?: string; user?: { isTour?: boolean } | null }>("/api/auth/status")
      .then((s) => setShow(s.authMode === "production" && Boolean(s.user) && !s.user?.isTour))
      .catch(() => setShow(false));
  }, []);

  if (!show) return null;

  const matches = next.length > 0 && next === confirm;
  const canSave = current.length > 0 && next.length >= 8 && next.trim().length > 0 && matches && !busy;

  async function changePassword() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setCurrent(""); setNext(""); setConfirm("");
      setDone("Password changed. You stay signed in here; every other device was signed out.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the password.");
    } finally { setBusy(false); }
  }

  async function signOutEverywhere() {
    setBusy(true);
    try {
      await api("/api/auth/logout-everywhere", { method: "POST", body: JSON.stringify({}) });
    } catch { /* signed out either way below */ }
    window.location.href = "/";
  }

  return (
    <Card title="Your sign-in" icon={KeyRound}>
      {error && <div className="mb-3 rounded-md border border-danger-border bg-danger-subtle p-2 text-sm text-danger-fg">{error}</div>}
      {done && <div className="mb-3 rounded-md border border-success-border bg-success-subtle p-2 text-sm text-success-fg">{done}</div>}
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-xs text-foreground-muted" htmlFor="acct-current">Current password
          <input id="acct-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm focus:border-primary focus:outline-none" />
        </label>
        <label className="block text-xs text-foreground-muted" htmlFor="acct-new">New password
          <input id="acct-new" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={next} onChange={(e) => setNext(e.target.value)} className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm focus:border-primary focus:outline-none" />
        </label>
        <label className="block text-xs text-foreground-muted" htmlFor="acct-confirm">Type it again
          <input id="acct-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1 w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm focus:border-primary focus:outline-none" />
        </label>
      </div>
      {confirm.length > 0 && !matches && <p className="mt-1 text-xs text-danger-fg">The two new passwords don&apos;t match.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={changePassword} loading={busy} disabled={!canSave}>Change password</Button>
        <Button size="sm" variant="ghost" icon={LogOut} onClick={() => setAskEverywhere(true)} disabled={busy}>Sign out everywhere</Button>
      </div>
      <p className="mt-2 text-xs text-foreground-muted">Signing out — here or with the button above — signs you out on every phone and computer at once.</p>
      <ConfirmModal
        open={askEverywhere}
        onClose={() => setAskEverywhere(false)}
        title="Sign out everywhere?"
        confirmLabel="Sign out everywhere"
        tone="danger"
        onConfirm={() => { setAskEverywhere(false); signOutEverywhere(); }}
      >
        You will be signed out on this and every other device. Use this if you think someone else has your password or a device you no longer have.
      </ConfirmModal>
    </Card>
  );
}
