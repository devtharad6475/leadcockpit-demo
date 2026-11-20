/**
 * 2026-09-28 — "Forgot password?" (/forgot-password).
 *
 * The person types their email; the server answers the same thing whether or
 * not the email has an account (so this page cannot be used to find out who
 * is registered) and emails a one-time link to /reset-password when it does.
 */
"use client";
import React, { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error?.message || "Something went wrong. Please try again.");
      setSent(data.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full p-8">
        {sent ? (
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-foreground mb-2">Request received</h1>
            <p className="text-muted mb-6">{sent}</p>
            <Button variant="secondary" onClick={() => { window.location.href = "/"; }}>Back to sign in</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h1 className="text-2xl font-semibold text-foreground mb-2">Forgot your password?</h1>
            <p className="text-sm text-muted mb-6">Enter the email you sign in with. If account email is available, an eligible account can receive a link to set a new password.</p>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="forgot-email">Email</label>
            <input id="forgot-email" type="email" autoComplete="email" required className="input mb-4" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            {error && <p className="mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg" role="alert">{error}</p>}
            <Button type="submit" loading={sending} disabled={!email} className="w-full">{sending ? "Sending…" : "Send me a link"}</Button>
            <p className="text-xs text-muted mt-4 text-center"><Link href="/" className="text-primary hover:underline">Back to sign in</Link></p>
          </form>
        )}
      </Card>
    </div>
  );
}
