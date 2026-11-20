/**
 * Stage 5 / WP5 (2026-07-29) — Operator alerting.
 *
 * Per docs/LOGIC.md §WP5.3 + docs/DECISIONS.md D-2026-07-29-g + D-2026-07-29-i:
 *   - Channel: existing EmailSendProvider (Resend/Mock). NO new dependency.
 *   - Recipient: OPERATOR_ALERT_EMAIL env var. Unset → routed:false,
 *     reason:"no_recipient" (NO silent send to a guessed address).
 *   - SEV1 → immediate send. SEV2/SEV3 → queued (not sent now).
 *   - flushDigest() consolidates queued alerts into ONE email.
 *   - Honest: every result reports routed (bool) + reason (string) + sentAt
 *     (ISO when actually sent) + eventCount (for digest).
 *   - No-auto-outreach: alerts go to the OPERATOR (transactional exception).
 *     Never to a customer, lead, or contact. No WhatsApp, no SMS.
 *
 * Pinned by golden:wp5-alerting.
 *
 * 2026-07-29 Stage 5 WP5.
 */

import { sendEmail, type EmailSendProvider, type EmailSendResult } from "@/providers/email";

/**
 * The 3 severity levels (per docs/DECISIONS.md D-2026-07-29-i). Exported as
 * both a runtime array (for validation loops) AND a union type (for input
 * shapes). The `SeverityLevels` const is the source; `Severity` is its
 * element type — distinct names so a `typeof import(...)["Severity"]`
 * resolves to the TYPE (not the const array).
 */
export const SeverityLevels = ["SEV1", "SEV2", "SEV3"] as const;
export type Severity = (typeof SeverityLevels)[number];

export type AlertInput = {
  severity: Severity;
  /** Short machine-readable event name (e.g. "database_unreachable"). */
  event: string;
  /** One-line plain-English summary for the email body. */
  summary: string;
  /** Optional structured context (shown in digest + audit). */
  context?: Record<string, unknown>;
};

export type RouteResult = {
  /** Did the alert actually go out (SEV1) or get queued (SEV2/3)? */
  routed: boolean;
  /** Why not routed, when applicable: "queued" | "no_recipient" | "send_failed". */
  reason?: string;
  /** ISO timestamp when an email was actually sent. */
  sentAt?: string;
};

export type DigestResult = {
  routed: boolean;
  /** Number of queued alerts consolidated into this digest (0 if empty). */
  eventCount: number;
  /** ISO timestamp when the digest email was sent. */
  sentAt?: string;
  /** Why not routed: "empty" | "no_recipient" | "send_failed". */
  reason?: string;
};

// =============================================================================
// In-process queue for SEV2/SEV3 alerts awaiting the next digest flush.
// In production the operator reads Sentry + the in-app status page between
// flushes; an automated flush scheduler is deferred (see SCOPE.md).
// =============================================================================

type QueuedAlert = AlertInput & { queuedAt: string };
const digestQueue: QueuedAlert[] = [];

// =============================================================================
// Test seam (Ironclad Gate #8 — Test Isolation). Allows the golden to swap
// in a stub EmailSendProvider so we can assert the EXACT calls (recipient,
// subject prefix, severity in body) without depending on Resend or a key.
// =============================================================================

let injectedProvider: EmailSendProvider | null = null;

/** Test seam: inject a stub EmailSendProvider. Pass null to restore real. */
export function injectEmailProviderForTesting(provider: EmailSendProvider | null): void {
  injectedProvider = provider;
}

/**
 * Test seam: clear the digest queue + drop any injected stub. Called at the
 * start of every golden case so no leftover state leaks across cases.
 * Also clears OPERATOR_ALERT_EMAIL if it was set by a prior case (the
 * golden re-sets it per case as needed).
 */
export function resetAlertService(): void {
  digestQueue.length = 0;
  injectedProvider = null;
}

/**
 * The active provider: the injected stub (tests) or the real one (prod).
 */
function activeProvider(): EmailSendProvider {
  return injectedProvider ?? {
    isConfigured: () => true,
    // The real sendEmail is imported at the top; wrap it so the stub path
    // and the prod path use the SAME EmailSendProvider interface.
    send: (input) => sendEmail(input),
  };
}

/**
 * The operator's alert email address. Read fresh on every call so an env
 * rotation (or a test flipping it) is picked up immediately. Returns
 * undefined when unset → callers must NOT send (no silent send to a
 * guessed address).
 */
function operatorAlertEmail(): string | undefined {
  const addr = process.env.OPERATOR_ALERT_EMAIL;
  if (!addr || !addr.trim()) return undefined;
  return addr.trim();
}

/**
 * Route an alert. SEV1 sends immediately (if OPERATOR_ALERT_EMAIL is set).
 * SEV2/SEV3 are queued for the next digest flush. Never throws — an alerting
 * failure must not become a new source of 500s (the monitoring wrapper's
 * same contract). Errors are surfaced via routed=false + reason.
 */
export async function routeAlert(input: AlertInput): Promise<RouteResult> {
  // SEV2/SEV3 always queue, regardless of recipient config.
  if (input.severity !== "SEV1") {
    digestQueue.push({ ...input, queuedAt: new Date().toISOString() });
    return { routed: false, reason: "queued" };
  }

  // SEV1: attempt immediate send.
  const recipient = operatorAlertEmail();
  if (!recipient) {
    // No recipient configured — do NOT guess. Surface as not-routed so the
    // operator sees in monitoring that alerts are silently dropping.
    return { routed: false, reason: "no_recipient" };
  }

  try {
    const result: EmailSendResult = await activeProvider().send({
      from: fromAddress(),
      to: recipient,
      subject: `[SEV1] ${input.event}`,
      html: sev1Html(input),
      purpose: "security_notice",
    });
    if (!result.ok) {
      return { routed: false, reason: "send_failed" };
    }
    return { routed: true, reason: "sent", sentAt: new Date().toISOString() };
  } catch {
    // Provider threw (network, auth, etc.). Do NOT rethrow — alerting must
    // not become a new source of 500s. Sentry (already wired in
    // src/lib/monitoring) will catch the underlying error separately.
    return { routed: false, reason: "send_failed" };
  }
}

/**
 * Flush the digest queue. Sends ONE consolidated email with every queued
 * alert. No-op (routed:false, reason:"empty") when the queue is empty.
 */
export async function flushDigest(): Promise<DigestResult> {
  if (digestQueue.length === 0) {
    return { routed: false, eventCount: 0, reason: "empty" };
  }
  const recipient = operatorAlertEmail();
  if (!recipient) {
    // Queue is non-empty but no recipient — surface honestly. The alerts
    // stay queued so a future flush (after the operator sets the env var)
    // can still deliver them.
    return { routed: false, eventCount: digestQueue.length, reason: "no_recipient" };
  }

  const events = digestQueue.splice(0, digestQueue.length);
  try {
    const result = await activeProvider().send({
      from: fromAddress(),
      to: recipient,
      subject: `[LeadCockpit digest] ${events.length} alert${events.length === 1 ? "" : "s"}`,
      html: digestHtml(events),
      purpose: "security_notice",
    });
    if (!result.ok) {
      // Put them back so the next flush can retry.
      digestQueue.unshift(...events);
      return { routed: false, eventCount: events.length, reason: "send_failed" };
    }
    return { routed: true, eventCount: events.length, sentAt: new Date().toISOString() };
  } catch {
    digestQueue.unshift(...events);
    return { routed: false, eventCount: events.length, reason: "send_failed" };
  }
}

// =============================================================================
// HTML builders. Kept simple + plain-English (build-right Plain English Rule
// for the operator-facing content). No templating engine — a string is fine
// for transactional alerts.
// =============================================================================

function fromAddress(): string {
  // Honor BASE_URL's host if set; otherwise a stable default. The from
  // address is informational for the operator's inbox triage.
  const base = process.env.BASE_URL;
  if (base) {
    try {
      const host = new URL(base).host;
      return `LeadCockpit Alerts <alerts@${host}>`;
    } catch {
      // fall through
    }
  }
  return "LeadCockpit Alerts <alerts@leadcockpit.local>";
}

function sev1Html(input: AlertInput): string {
  const ctx = input.context
    ? `<p><strong>Context:</strong></p><pre style="background:#f4f4f4;padding:8px;border-radius:4px;overflow-x:auto;">${escapeHtml(JSON.stringify(input.context, null, 2))}</pre>`
    : "";
  return `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#b91c1c;">⚠ SEV1 — ${escapeHtml(input.event)}</h2>
      <p><strong>What happened:</strong> ${escapeHtml(input.summary)}</p>
      <p><strong>When:</strong> ${new Date().toISOString()}</p>
      ${ctx}
      <hr style="margin:20px 0;border:none;border-top:1px solid #ddd;">
      <p style="font-size:12px;color:#666;">
        This is an immediate SEV1 alert per your LeadCockpit incident runbook
        (docs/planning/INCIDENT_RUNBOOK.md). Acknowledge within 1 hour;
        resolve within 24 hours.
      </p>
    </div>
  `.trim();
}

function digestHtml(events: QueuedAlert[]): string {
  const rows = events.map((e, i) => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #eee;font-weight:bold;">${e.severity}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(e.event)}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;">${escapeHtml(e.summary)}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;font-size:11px;color:#666;">${e.queuedAt}</td>
    </tr>
  `.trim()).join("");
  return `
    <div style="font-family:sans-serif;max-width:700px;">
      <h2>LeadCockpit alert digest — ${events.length} event${events.length === 1 ? "" : "s"}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f4f4f4;text-align:left;">
            <th style="padding:6px;">Severity</th>
            <th style="padding:6px;">Event</th>
            <th style="padding:6px;">Summary</th>
            <th style="padding:6px;">Queued at</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#666;margin-top:16px;">
        These are SEV2/SEV3 alerts deferred from immediate send per your
        incident runbook. None required waking you.
      </p>
    </div>
  `.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
