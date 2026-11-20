/**
 * Stage 5 re-audit fix (F-P0-4, 2026-07-28) — Password reset landing page
 * (/reset-password).
 *
 * The operator-issued reset email links here with ?token=<rawToken>. This page
 * lets the user set a NEW password (the token proves email control; the user
 * chooses the new password). On submit, POST /api/auth/reset-password sets the
 * new password + consumes the token. The user is then redirected to sign in
 * with the new password (NOT auto-logged-in — defense-in-depth).
 *
 * Build-right Empty-State Honesty: every state is explained. Expired/used →
 * offers "request a new link" hint. Invalid token → clear error.
 *
 * Build-right Fat-Finger + Mental-Load: large inputs + button, password
 * requirements shown inline, confirm-password field to prevent typos.
 */
"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"form" | "success" | "error">("form");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [requestUnconfirmed, setRequestUnconfirmed] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    void Promise.resolve().then(() => {
      if (!t) {
        setStatus("error");
        setMessage("No reset token found. Click the link in your reset email again.");
      } else setToken(t);
    });
  }, []);

  const passwordsMatch = password.length > 0 && password === confirm;
  const longEnough = password.length >= 8;
  const canSubmit = !!token && longEnough && passwordsMatch && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !token) return;
    setSubmitting(true);
    setMessage("");
    setRequestUnconfirmed(false);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setStatus("success");
        setMessage("Your password has been reset. Sign in with your new password.");
        setPassword(""); setConfirm("");
      } else {
        const uncertain = res.status >= 500;
        setRequestUnconfirmed(uncertain);
        setStatus(res.status === 400 || res.status === 410 ? "error" : "form");
        setMessage(uncertain
          ? "We could not confirm whether your password changed. Try signing in with the new password before submitting again. Your link may already have been used."
          : data?.error?.message || "The request could not be completed. Please try again.");
      }
    } catch {
      setStatus("form");
      setRequestUnconfirmed(true);
      setMessage("We could not confirm whether your password changed. Try signing in with the new password before submitting again. Your link may already have been used.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full p-8">
        {status === "form" && (
          <form onSubmit={handleSubmit}>
            <h1 className="text-2xl font-semibold text-foreground mb-2">Set a new password</h1>
            <p className="text-sm text-muted mb-6">
              Enter your new password below. This signs you out on every device; then sign in with the new password.
            </p>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="password">
              New password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className="input mb-1"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
            <p className="text-xs text-muted mb-4">Must be at least 8 characters.</p>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="confirm">
              Confirm new password
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              className="input mb-1"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter your new password"
            />
            {confirm.length > 0 && !passwordsMatch && (
              <p className="text-xs text-danger-fg mb-4">Passwords don&apos;t match.</p>
            )}
            {confirm.length > 0 && passwordsMatch && <div className="mb-4" />}
            {message && <p className="mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg" role="alert">{message}</p>}
            {requestUnconfirmed && <p className="mb-4 text-sm text-muted"><Link href="/" className="text-primary hover:underline">Try signing in</Link>. If the new password does not work, you may retry this request; an already-used link will be refused.</p>}
            <Button type="submit" loading={submitting} disabled={!canSubmit} className="w-full">
              {submitting ? "Resetting…" : requestUnconfirmed ? "Retry password reset" : "Reset password"}
            </Button>
          </form>
        )}
        {status === "success" && (
          <div className="text-center">
            <div className="text-2xl font-semibold text-success-fg mb-2">✓ Password reset</div>
            <p className="text-muted mb-6">{message}</p>
            <Button onClick={() => { window.location.href = "/"; }}>Sign in</Button>
          </div>
        )}
        {status === "error" && (
          <div className="text-center">
            <div className="text-2xl font-semibold text-danger-fg mb-2">Couldn&apos;t reset</div>
            <p className="text-muted mb-6">{message}</p>
            <p className="text-sm text-muted mb-4">
              If your link expired or was already used, <Link href="/forgot-password" className="text-primary hover:underline">ask for a new link</Link>.
            </p>
            <Button variant="secondary" onClick={() => { window.location.href = "/"; }}>
              Back to sign in
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
