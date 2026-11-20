/**
 * Stage 5 / WP1 (2026-07-28) — Invite acceptance page (/invite).
 *
 * The invite email links here with ?token=<rawToken>. This page shows a "set
 * up your account" form (name + password), then calls the accept-invite API.
 * On success → session cookie is set → redirect to the workspace.
 *
 * Build-right UX: one primary action (the accept form). Clear error for
 * expired/revoked invites with a "ask for a new invite" hint.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, Button } from "@/components/ui";

export default function InviteAcceptPage() {
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("No invite token found. Click the link in your invite email again.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data?.error?.message || "Couldn't accept the invite.");
      }
      setSuccess(true);
      setTimeout(() => { window.location.href = "/"; }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept the invite.");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="text-xl font-semibold text-danger-fg mb-2">No invite token</div>
          <p className="text-muted">
            We couldn&apos;t find an invite token. Please click the link in your invite email.
          </p>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="text-2xl font-semibold text-success-fg mb-2">Welcome to the team!</div>
          <p className="text-muted mb-4">Your account is set up. Taking you to your workspace…</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full p-8">
        <h1 className="text-2xl font-semibold text-foreground mb-1">Accept your invite</h1>
        <p className="text-muted mb-6 text-sm">
          Set up your account to join the workspace.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 2026-08-05 (audit F-9): label association + autoComplete. */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="invite-name">Your name</label>
            <input
              id="invite-name" name="name" autoComplete="name"
              type="text" required minLength={1} maxLength={100}
              value={name} onChange={(e) => setName(e.target.value)}
              className="input"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1" htmlFor="invite-password">Choose a password</label>
            <input
              id="invite-password" name="password" autoComplete="new-password"
              type="password" required minLength={8}
              value={password} onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="At least 8 characters"
            />
          </div>
          {error && (
            <div className="rounded-lg bg-danger-bg border border-danger-bg px-3 py-2 text-sm text-danger-fg" role="alert">
              {error}
            </div>
          )}
          <Button type="submit" loading={loading} className="w-full">
            {loading ? "Setting up…" : "Accept invite & set up account"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
