/**
 * Stage 5 / WP2 (2026-07-28) — Operator console: System Health + Feature Flags.
 *
 * Health: read-only snapshot of persistence/email/rate-limit provider + counts.
 *   Honest status everywhere (persistence=json|prisma, email=resend|mock,
 *   rateLimit=memory|redis). No fake "healthy".
 *
 * Stage 5 / WP5 (2026-07-29) — Operability 5-card status page added BELOW the
 *   provider snapshot. Reads /api/admin/system-health, renders 5 cards
 *   (Database / Scheduler / LLM providers / Error rate / Rate limits) + a
 *   green/yellow/red banner computed by the client-safe computeHealthBanner
 *   chokepoint (src/lib/health-status.ts). Operator-only (the route enforces
 *   role=operator; support_agent gets 403).
 *
 * Flags: the 4 global kill-switches (new_signup_enabled, billing_enabled,
 *   whatsapp_send_enabled, ai_usage_enabled). Operator toggles on/off. Every
 *   toggle is audit-logged (config_changed). Default = on (system "on").
 *
 * Per docs/LOGIC.md 2026-07-28 + §WP5.5 (2026-07-29).
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useEffect, useState } from "react";
import { Card, Badge, Button, Spinner, ConfirmModal } from "@/components/ui";
import { Activity, Flag, RefreshCw, AlertCircle as AlertIcon } from "lucide-react";
// Stage 5 / WP5 (2026-07-29): the client-safe banner reducer. Same pattern
// as computeLivePlatformBreach (extracted to src/lib so "use client" can import).
import { computeHealthBanner } from "@/lib/health-status";

type HealthSnapshot = {
  persistence: string;
  emailProvider: string;
  accountEmail?: { ready: boolean; senderConfigured: boolean; reason?: string };
  rateLimitBackend: string;
  adminCount: number;
  workspaceCount: number;
  suspendedWorkspaceCount: number;
  timestamp: string;
};

/** Pure card: account setup and actual delivery are deliberately separate. */
export function AccountEmailStatusCard({ configuration }: {
  configuration?: HealthSnapshot["accountEmail"];
}) {
  const configured = configuration?.ready === true && configuration.senderConfigured === true;
  return (
    <Card title="Account email" icon={Activity}>
      <div className="flex items-center gap-2">
        <Badge tone={configured ? "success" : "warning"}>{configured ? "Configured" : "Needs setup"}</Badge>
        <span className="text-xs text-foreground-muted">{configured
          ? "Delivery not yet verified. Check a joining or password-reset email."
          : configuration?.reason || "Account email configuration has not been verified."}</span>
      </div>
    </Card>
  );
}

/**
 * Stage 5 / WP5 (2026-07-29) — the 5-card operability probe shape. Mirrors
 * src/services/SystemHealthProbe.ts SystemHealth. Duplicated here (not
 * imported from the service) because the service module is server-only
 * (it imports the edge-rate-limit + monitoring modules); the UI only needs
 * the JSON shape.
 */
type SystemHealthProbe = {
  database: { up: boolean; latencyMs: number; timedOut?: boolean };
  scheduler: { lastRunAt: string | null; status: "ok" | "error" | "never" };
  llm: { slots: Array<{ slotId: string; provider: string; status: "real" | "fallback" | "mock" }> };
  errorRate: { last1h: number; threshold: number; observed?: boolean };
  rateLimits: { blockedIps: number; blockedWorkspaces: number };
};
type SystemHealthResponse = { probe: SystemHealthProbe; timestamp: string };

type FlagRow = { key: string; enabled: boolean; lastToggledByAdminId?: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) {
    const b = body as { error?: { message?: string } } | string | null;
    const msg = typeof b === "string" ? b : (b?.error?.message || `Request failed (${res.status})`);
    throw new Error(msg);
  }
  return body as T;
}

const FLAG_LABELS: Record<string, string> = {
  new_signup_enabled: "New signups",
  billing_enabled: "Billing",
  whatsapp_send_enabled: "WhatsApp send",
  ai_usage_enabled: "AI usage",
};

// F-UI-2 (2026-08-04): a human-readable consequence for each kill-switch, so
// the ConfirmModal can tell the operator the BLAST RADIUS of disabling it
// (instead of relying on a red button + the flag's internal name). This is the
// "no destructive action without an explicit confirm + a stated consequence"
// pattern every other admin/workspace destructive action already follows
// (suspend workspace, spam/block, erasure). Enabling a switch is non-destructive
// (it restores capability) so it stays a bare click.
const FLAG_DISABLE_CONSEQUENCE: Record<string, string> = {
  new_signup_enabled: "New customers will no longer be able to sign up. Any signup form in progress will fail. Existing workspaces are unaffected.",
  billing_enabled: "Billing collection will stop. This does not affect existing customers' access today (billing enforcement is not yet live — see the warning on the card).",
  whatsapp_send_enabled: "WhatsApp message sending will be blocked for EVERY workspace, including approved replies. Inbound messages still arrive.",
  ai_usage_enabled: "All AI features (lead scoring, reply drafting, the Copilot, extraction) will stop working for every workspace.",
};

/**
 * Stage 5 re-audit fix (F-P1-3, 2026-07-28) — flags that are NOT YET ENFORCED
 * downstream. The toggle still writes the row (so the operator's intent is
 * captured + audit-logged), but the UI must honestly label it so the operator
 * doesn't believe flipping it has an effect. billing_enabled becomes enforced
 * when WP4 (billing) ships; until then it's write-only.
 */
const NOT_YET_ENFORCED_FLAGS = new Set<string>([
  "billing_enabled", // WP4 not built — toggle is captured but not yet enforced
]);

function isFlagEnforced(key: string): boolean {
  return !NOT_YET_ENFORCED_FLAGS.has(key);
}

export function AdminHealth() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [probe, setProbe] = useState<SystemHealthProbe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setProbeError(null);
    try {
      // Load both in parallel — the snapshot is fast (counts); the probe
      // may take up to 2s (DB ping timeout). Don't block the snapshot on
      // the probe.
      const snapshotPromise = api<HealthSnapshot>("/api/admin/health")
        .then(setHealth)
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load health"));
      // The operability probe is operator-only; a support_agent gets 403
      // here (expected — they don't see this section). Render the snapshot
      // regardless + show a note if the probe is forbidden.
      const probePromise = api<SystemHealthResponse>("/api/admin/system-health")
        .then((r) => setProbe(r.probe))
        .catch((e) => {
          const msg = e instanceof Error ? e.message : "Failed to load operability probe";
          // 403 = support_agent viewing (expected; don't alarm). Anything
          // else = real error.
          if (!/forbidden|operator access/i.test(msg)) setProbeError(msg);
        });
      await Promise.all([snapshotPromise, probePromise]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (error || !health) {
    // F8 (2026-08-04 CONTINUOUS-2 audit): add a Try-again escape hatch. The
    // early return previously rendered only the error message — the Refresh
    // button below was unreachable, leaving the operator stuck (violates the
    // build-right stuck-user check). Mirrors the error-card pattern every
    // sections/*.tsx already uses.
    return (
      <div className="rounded-md border border-danger-border bg-danger-subtle p-4 text-sm text-danger-fg space-y-3">
        <div className="flex items-start gap-2">
          <AlertIcon className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error || "No health data."}</span>
        </div>
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={load}>Try again</Button>
      </div>
    );
  }

  // Stage 5 / WP5: compute the banner from the probe (client-side, same
  // chokepoint the golden tests). Falls back to a neutral state when the
  // probe is unavailable (support_agent or transient error).
  const banner = probe ? computeHealthBanner(probe) : null;
  const bannerTone = banner?.status === "green" ? "success" : banner?.status === "yellow" ? "warning" : banner?.status === "red" ? "danger" : "neutral";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-foreground-muted">Live system status. Honest provider status everywhere — no fake "healthy".</p>
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={load}>Refresh</Button>
      </div>

      {/* ---- Provider snapshot (WP2) ---- */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Card title="Persistence" icon={Activity}>
          <div className="flex items-center gap-2">
            <Badge tone={health.persistence === "prisma" ? "success" : "warning"}>{health.persistence}</Badge>
            <span className="text-xs text-foreground-muted">{health.persistence === "prisma" ? "PostgreSQL (production)" : "JSON file (demo/dev)"}</span>
          </div>
        </Card>
        <AccountEmailStatusCard configuration={health.accountEmail} />
        <Card title="Rate-limit backend" icon={Activity}>
          <div className="flex items-center gap-2">
            <Badge tone={health.rateLimitBackend === "redis" ? "success" : "warning"}>{health.rateLimitBackend}</Badge>
            <span className="text-xs text-foreground-muted">{health.rateLimitBackend === "redis" ? "Redis (shared)" : "Memory (per-process)"}</span>
          </div>
        </Card>
        <Card title="Admins" icon={Activity}>
          <div className="text-2xl font-bold text-foreground">{health.adminCount}</div>
          <div className="text-xs text-foreground-muted">platform admins</div>
        </Card>
        <Card title="Workspaces" icon={Activity}>
          <div className="text-2xl font-bold text-foreground">{health.workspaceCount}</div>
          <div className="text-xs text-foreground-muted">total tenants</div>
        </Card>
        <Card title="Suspended" icon={Activity}>
          <div className="text-2xl font-bold text-foreground">{health.suspendedWorkspaceCount}</div>
          <div className="text-xs text-foreground-muted">kill-switched tenants</div>
        </Card>
      </div>

      <div className="text-xs text-foreground-muted">Snapshot taken {formatDateTime(health.timestamp)}</div>

      {/* ---- Operability 5-card status page (WP5, 2026-07-29) ---- */}
      <div className="border-t border-border-default pt-4">
        <h3 className="text-sm font-semibold text-foreground mb-1">Operability (5-card status)</h3>
        <p className="text-xs text-foreground-muted mb-3">
          Real-time health of the 5 systems that matter most. The banner is computed client-side by the same
          {" "}<code className="text-[11px]">computeHealthBanner</code> chokepoint the golden test pins.
        </p>

        {probeError && (
          <div className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg flex items-start gap-2 mb-3">
            <AlertIcon className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{probeError}</span>
          </div>
        )}

        {banner && (
          <div className={`rounded-md border p-3 mb-3 flex items-start gap-2 ${
            bannerTone === "success" ? "border-success-border bg-success-subtle text-success-fg"
            : bannerTone === "warning" ? "border-warning-border bg-warning-subtle text-warning-fg"
            : bannerTone === "danger" ? "border-danger-border bg-danger-subtle text-danger-fg"
            : "border-border-default bg-surface text-foreground"
          }`}>
            <Badge tone={bannerTone === "neutral" ? undefined : bannerTone as "success" | "warning" | "danger"}>
              {banner.status.toUpperCase()}
            </Badge>
            <span className="text-sm">{banner.message}</span>
          </div>
        )}

        {probe && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Card 1: Database */}
            <Card title="Database" icon={Activity}>
              <div className="flex items-center gap-2">
                <Badge tone={probe.database.up ? "success" : "danger"}>
                  {probe.database.up ? "UP" : "DOWN"}
                </Badge>
                <span className="text-xs text-foreground-muted">{probe.database.latencyMs}ms</span>
              </div>
              {probe.database.timedOut && (
                <div className="text-xs text-danger-fg mt-1">Probe timed out at 2s.</div>
              )}
            </Card>

            {/* Card 2: Scheduler */}
            <Card title="Scheduler" icon={Activity}>
              <div className="flex items-center gap-2">
                <Badge tone={probe.scheduler.status === "ok" ? "success" : probe.scheduler.status === "error" ? "danger" : "warning"}>
                  {probe.scheduler.status.toUpperCase()}
                </Badge>
              </div>
              <div className="text-xs text-foreground-muted mt-1">
                {probe.scheduler.lastRunAt ? `Last run ${formatDateTime(probe.scheduler.lastRunAt)}` : "Never run"}
              </div>
            </Card>

            {/* Card 3: LLM providers */}
            <Card title="LLM providers" icon={Activity}>
              <div className="flex items-center gap-2">
                <Badge tone={probe.llm.slots.length > 0 ? "success" : "warning"}>
                  {probe.llm.slots.length} slot{probe.llm.slots.length === 1 ? "" : "s"}
                </Badge>
              </div>
              <div className="text-xs text-foreground-muted mt-1">
                {probe.llm.slots.length === 0
                  ? "No slots configured"
                  : probe.llm.slots.map((s) => `${s.slotId}:${s.status}`).join(", ")}
              </div>
            </Card>

            {/* Card 4: Error rate */}
            <Card title="Error rate (last 1h)" icon={Activity}>
              <div className="flex items-center gap-2">
                <Badge tone={probe.errorRate.observed === false ? "warning" : probe.errorRate.last1h > probe.errorRate.threshold ? "danger" : "success"}>
                  {probe.errorRate.observed === false ? "Not measured" : `${probe.errorRate.last1h} errors`}
                </Badge>
                <span className="text-xs text-foreground-muted">threshold {probe.errorRate.threshold}</span>
              </div>
            </Card>

            {/* Card 5: Rate limits */}
            <Card title="Rate limits (blocked)" icon={Activity}>
              <div className="text-sm text-foreground">
                {probe.rateLimits.blockedIps} IP{probe.rateLimits.blockedIps === 1 ? "" : "s"}
                {" · "}
                {probe.rateLimits.blockedWorkspaces} workspace{probe.rateLimits.blockedWorkspaces === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-foreground-muted mt-1">front-door guard (300/IP, 600/workspace per 5min)</div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

export function AdminFlags() {
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState("");
  // F-UI-2 (2026-08-04): pending-disable confirmation state. Disabling a
  // global kill-switch destroys platform-wide capability in one click, so the
  // operator must confirm with the blast-radius stated.
  const [pendingDisable, setPendingDisable] = useState<FlagRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setFlags(await api<FlagRow[]>("/api/admin/feature-flags"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load flags");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function toggle(key: string, nextEnabled: boolean) {
    setBusyKey(key);
    setError(null);
    try {
      await api(`/api/admin/feature-flags`, { method: "POST", body: JSON.stringify({ key, enabled: nextEnabled }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not toggle the flag.");
    } finally { setBusyKey(""); }
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner /></div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg flex items-start gap-2">
          <AlertIcon className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <p className="text-sm text-foreground-muted">
        Global kill-switches. Default is ON (the system runs). Flip a switch OFF to kill that capability platform-wide in an emergency. Every toggle is audit-logged.
      </p>
      <Card title="Kill-switches" icon={Flag}>
        <div className="space-y-2">
          {flags.map((f) => {
            const enforced = isFlagEnforced(f.key);
            return (
            <div key={f.key} className="flex items-center justify-between gap-3 rounded-md border border-border-default bg-surface px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{FLAG_LABELS[f.key] || f.key}</div>
                <div className="text-xs text-foreground-muted font-mono">{f.key}</div>
                {!enforced && (
                  <div className="text-xs text-warning-fg mt-0.5">
                    Not yet enforced — toggle is captured for when this capability ships.
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge tone={f.enabled ? "success" : "danger"}>{f.enabled ? "ON" : "OFF"}</Badge>
                <Button
                  variant={f.enabled ? "danger" : "primary"}
                  size="sm"
                  loading={busyKey === f.key}
                  disabled={busyKey !== ""}
                  // F-UI-2 (2026-08-04): disabling a global kill-switch is a
                  // destructive platform-wide action — require a ConfirmModal
                  // (with the blast radius stated) before it fires. Enabling is
                  // non-destructive (restores capability) so it stays direct.
                  onClick={() => (f.enabled ? setPendingDisable(f) : toggle(f.key, true))}
                >
                  {f.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
            );
          })}
        </div>
      </Card>

      {/* F-UI-2 (2026-08-04): confirm before disabling a global kill-switch. */}
      <ConfirmModal
        open={pendingDisable !== null}
        title={pendingDisable ? `Disable ${FLAG_LABELS[pendingDisable.key] || pendingDisable.key}?` : ""}
        confirmLabel="Disable platform-wide"
        tone="danger"
        onConfirm={() => {
          const target = pendingDisable;
          setPendingDisable(null);
          if (target) void toggle(target.key, false);
        }}
        onClose={() => setPendingDisable(null)}
      >
        {pendingDisable ? (FLAG_DISABLE_CONSEQUENCE[pendingDisable.key] || "This will disable the capability for every workspace. The action is audit-logged and reversible by clicking Enable again.") : ""}
      </ConfirmModal>
    </div>
  );
}
