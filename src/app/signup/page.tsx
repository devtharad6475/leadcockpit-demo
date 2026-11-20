/**
 * Stage 5 / WP1 (2026-07-28) — Public self-serve signup page (/signup).
 *
 * Production-only (the service refuses in demo mode). Gated by the
 * `new_signup_enabled` feature flag at the service layer — when the operator
 * flips it OFF (during the pilot), signup returns 403 and this page shows a
 * "signups are currently closed" notice.
 *
 * UX (build-right Human-Centric rules):
 *   - One primary action per page (the signup form).
 *   - Empty-state honesty: shows the flag-closed notice, not a broken form.
 *   - Clear error messages (no technical jargon).
 *   - After success → "Check your email" + Go to sign in. Since 2026-09-28 (S7)
 *     sign-up answers the same for a taken email and signs nobody in.
 */
"use client";
import React, { useState } from "react";
import { Card, Button } from "@/components/ui";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password, businessName: businessName || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data?.error?.message || "Signup failed. Please try again.");
      }
      // 2026-09-28 (S7): the answer is the same whether or not the email
      // already had an account, so this page never says which. Nobody is
      // signed in here: a new owner signs in with the password they chose.
      setSuccess(data.message || "Check your email to finish setting up.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed.");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="text-2xl font-semibold text-foreground mb-2">Request processed</div>
          <p className="text-muted mb-4">{success}</p>
          <p className="text-sm text-muted mb-6">
            Sign in with <strong>{email}</strong>. For an existing account, use your existing password or request a password reset.
          </p>
          <Button onClick={() => { window.location.assign("/"); }}>Go to sign in</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full p-8">
        <h1 className="text-2xl font-semibold text-foreground mb-1">Create your workspace</h1>
        <p className="text-muted mb-6 text-sm">
          Sign up to start managing your leads, conversations, and outreach.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 2026-08-05 (audit F-9): htmlFor/id on every field. These labels sat
              as siblings of their inputs with no association, so a screen reader
              announced four unlabelled boxes on the FIRST screen a new customer
              sees. autoComplete added at the same time — it costs nothing and
              makes the form usable with a password manager. */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="signup-name">Your name</label>
            <input
              id="signup-name" name="name" autoComplete="name"
              type="text" required minLength={1} maxLength={100}
              value={name} onChange={(e) => setName(e.target.value)}
              className="input"
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="signup-email">Email</label>
            <input
              id="signup-email" name="email" autoComplete="email"
              type="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="jane@business.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="signup-password">Password</label>
            <input
              id="signup-password" name="password" autoComplete="new-password"
              type="password" required minLength={8}
              value={password} onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="signup-business">Business name (optional)</label>
            <input
              id="signup-business" name="organization" autoComplete="organization"
              type="text" maxLength={200}
              value={businessName} onChange={(e) => setBusinessName(e.target.value)}
              className="input"
              placeholder="Acme Textiles"
            />
          </div>
          {error && (
            <div className="rounded-lg bg-danger-bg border border-danger-bg px-3 py-2 text-sm text-danger-fg" role="alert">
              {error}
            </div>
          )}
          <Button type="submit" loading={loading} className="w-full">
            {loading ? "Creating workspace…" : "Create workspace"}
          </Button>
        </form>
        <p className="text-xs text-muted mt-4 text-center">
          Already have an account?{" "}
          <a href="/" className="text-primary hover:underline">Sign in</a>
        </p>
      </Card>
    </div>
  );
}
