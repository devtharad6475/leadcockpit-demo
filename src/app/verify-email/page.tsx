/**
 * Stage 5 / WP1 (2026-07-28) — Email verification landing page (/verify-email).
 *
 * The signup email links here with ?token=<rawToken>. This page calls the
 * verify API, then shows the result (success / already-verified / expired /
 * invalid). Idempotent: re-clicking the same link shows "verified" (no error).
 *
 * Build-right Empty-State Honesty: every state is explained (not just
 * "success" / blank screen). Expired → offers "request a new link" hint.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, Button } from "@/components/ui";

export default function VerifyEmailPage() {
  const [status, setStatus] = useState<"loading" | "verified" | "error">("loading");
  const [message, setMessage] = useState<string>("");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);

  async function resend() {
    if (resending || unconfirmed) return;
    setResending(true);
    setResendMessage(null);
    setResendError(null);
    try {
      const response = await fetch("/api/auth/resend-verification", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setUnconfirmed(data?.error?.code === "EMAIL_UNCONFIRMED");
        throw new Error(data?.error?.message || "The verification request failed. Please try again.");
      }
      setResendMessage("The email provider accepted your verification email for sending. Check your inbox and spam folder; delivery is not yet confirmed.");
    } catch (error) {
      setResendError(error instanceof Error ? error.message : "The verification request failed. Please try again.");
    } finally { setResending(false); }
  }

  useEffect(() => {
    fetch("/api/auth/status").then((res) => res.json()).then((data) => setSignedIn(data.authenticated === true && data.user?.isTour !== true)).catch(() => setSignedIn(null));
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      void Promise.resolve().then(() => {
        setStatus("error");
        setMessage("No verification token found. Click the link in your email again.");
      });
      return;
    }
    fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          setStatus("verified");
          setMessage("Your email address is verified. Your company role still determines which features you can use.");
        } else {
          setStatus("error");
          setMessage(data?.error?.message || "Verification failed.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Something went wrong. Please try again.");
      });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full p-8 text-center">
        {status === "loading" && (
          <>
            <div className="text-lg font-medium text-foreground mb-2">Verifying your email…</div>
            <p className="text-sm text-muted">One moment.</p>
          </>
        )}
        {status === "verified" && (
          <>
            <div className="text-2xl font-semibold text-success-fg mb-2">✓ Email verified</div>
            <p className="text-muted mb-6">{message}</p>
            <Button onClick={() => { window.location.href = "/"; }}>Go to my workspace</Button>
          </>
        )}
        {status === "error" && (
          <>
            <div className="text-2xl font-semibold text-danger-fg mb-2">Couldn&apos;t verify</div>
            <p className="text-muted mb-4">{message}</p>
            <div className="rounded-lg border border-border-default bg-surface p-3 text-left mb-4">
              <p className="text-sm font-medium text-foreground mb-2">Need a new link?</p>
              <p className="text-xs text-muted mb-2">
                {signedIn === true ? "Request a new verification link for the account you are signed in to. You can keep using your workspace before verifying." : "Sign in with your email and password, then return to this page to request a new link. You can sign in before verifying."}
              </p>
              {signedIn === true && <Button variant="secondary" loading={resending} disabled={unconfirmed} onClick={() => void resend()}>Resend verification</Button>}
              {signedIn === null && <p className="text-xs text-muted">Account status could not be confirmed. Sign in before requesting another link.</p>}
              {resendMessage && <p className="mt-3 text-sm text-success-fg" role="status">{resendMessage}</p>}
              {resendError && <p className="mt-3 text-sm text-danger-fg" role="alert">{resendError}</p>}
              {unconfirmed && <p className="mt-2 text-xs text-muted">Check your inbox or ask your administrator to check the email provider before requesting another link.</p>}
            </div>
            <Button variant="secondary" onClick={() => { window.location.href = "/"; }}>
              Back to sign in
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
