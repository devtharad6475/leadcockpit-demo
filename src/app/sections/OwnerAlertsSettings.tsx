/**
 * 2026-09-28 — "Messages to your WhatsApp": the owner's morning summary and
 * urgent alerts. Owner-only on the server (rbac-map "owner-alerts"). These go
 * to the owner's OWN number, never to a customer. Rules: docs/LOGIC.md
 * OWNER-WHATSAPP.
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useEffect, useState } from "react";
import { Badge, Button, Card, Checkbox, Select } from "@/components/ui";
import { BellRing } from "lucide-react";
import { api } from "@/lib/api-client";

type View = {
  settings: {
    morningSummary: boolean;
    urgentAlerts: boolean;
    bigAmountInr?: number;
    maxAlertsPerDay: number;
    summaryTemplateId?: string;
    alertTemplateId?: string;
  };
  ownerWhatsappNumber?: string;
  templates: Array<{ id: string; name: string; status: string; language: string }>;
  whatsappConnected: boolean;
  recent: Array<{ at: string; kind: string; status: string; reason: string; text: string }>;
};

export function OwnerAlertsSettings() {
  const [view, setView] = useState<View | null>(null);
  const [hidden, setHidden] = useState(false);
  const [number, setNumber] = useState("");
  const [summary, setSummary] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const [bigAmount, setBigAmount] = useState("");
  const [maxPerDay, setMaxPerDay] = useState("5");
  const [summaryTemplate, setSummaryTemplate] = useState("");
  const [alertTemplate, setAlertTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  function fill(v: View) {
    setView(v);
    setNumber(v.ownerWhatsappNumber || "");
    setSummary(v.settings.morningSummary);
    setAlerts(v.settings.urgentAlerts);
    setBigAmount(v.settings.bigAmountInr ? String(v.settings.bigAmountInr) : "");
    setMaxPerDay(String(v.settings.maxAlertsPerDay));
    setSummaryTemplate(v.settings.summaryTemplateId || "");
    setAlertTemplate(v.settings.alertTemplateId || "");
  }

  useEffect(() => {
    // Only the owner can read this; anyone else simply does not see the card.
    api<View>("/api/owner-alerts/settings").then(fill).catch(() => setHidden(true));
  }, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api<View>("/api/owner-alerts/settings", {
        method: "POST",
        body: {
          ownerWhatsappNumber: number,
          morningSummary: summary,
          urgentAlerts: alerts,
          bigAmountInr: bigAmount.trim() ? Number(bigAmount.replace(/[,\s₹]/g, "")) : null,
          maxAlertsPerDay: Number(maxPerDay),
          summaryTemplateId: summaryTemplate,
          alertTemplateId: alertTemplate,
        },
      });
      fill(next);
      setMessage({ tone: "success", text: "Saved." });
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  if (hidden || !view) return null;
  const templateOptions = view.templates.map((t) => ({
    value: t.id,
    label: `${t.name} (${t.status === "approved" ? "approved by Meta" : `not approved yet — ${t.status}`})`,
  }));
  const chosen = (id: string) => view.templates.find((t) => t.id === id);
  const needsTemplate = (on: boolean, id: string) => on && chosen(id)?.status !== "approved";

  return (
    <Card title="Messages to your WhatsApp" icon={BellRing}>
      <div className="space-y-4 text-sm">
        <p className="text-muted-2">
          A short morning summary and a few urgent alerts, sent to <strong>your own</strong> WhatsApp number — never to a
          customer. Alerts only tell you something happened; they never reply to anyone.
        </p>

        <div className="rounded-lg border border-warning-fg bg-surface-muted p-3 text-xs leading-relaxed text-muted-2">
          <strong className="text-foreground">Before anything can be sent:</strong> WhatsApp only lets a business send you
          these messages using a <strong>message format WhatsApp has approved</strong>. Add one under WhatsApp templates
          (a short &ldquo;update&rdquo; message is enough), wait a day or two for WhatsApp to approve it, then choose it below.
          Until then everything stays here in the app — nothing is ever shown as sent when it was not.
          {!view.whatsappConnected ? <span className="mt-1 block text-danger-fg">Your WhatsApp is not connected yet, so messages stay in the app.</span> : null}
        </div>

        <div>
          <label className="label" htmlFor="owner-whatsapp-number">Your WhatsApp number</label>
          <input
            id="owner-whatsapp-number"
            className="input"
            inputMode="tel"
            placeholder="+91 98250 33333"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">Numbers without a country code are taken as Indian (+91). It cannot be a customer&apos;s number.</p>
        </div>

        <div className="space-y-2 rounded-lg border border-border-default p-3">
          <Checkbox label="Send me a morning summary on WhatsApp" checked={summary} onChange={setSummary} />
          <p className="text-xs text-muted">After the daily routine: customers waiting, late tickets, quotes waiting with totals, orders to ship, reminders due, new buyers found — and one link.</p>
          {summary && <Select label="Template for the summary" value={summaryTemplate} onChange={setSummaryTemplate} options={templateOptions} placeholder="Choose an approved template" />}
          {needsTemplate(summary, summaryTemplate) ? <Badge tone="warning">Needs a Meta-approved template — stays in the app until then</Badge> : null}
        </div>

        <div className="space-y-2 rounded-lg border border-border-default p-3">
          <Checkbox label="Send me urgent alerts" checked={alerts} onChange={setAlerts} />
          <p className="text-xs text-muted">
            A complaint or abusive message, a customer waiting more than 2 working hours, an urgent ticket 30 minutes before
            its deadline, and an order or quote above your amount. None between 9 pm and 8 am — those wait for the morning summary.
          </p>
          {alerts && <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label" htmlFor="owner-big-amount">Alert me for an order or quote of at least (₹)</label>
              <input id="owner-big-amount" className="input" inputMode="numeric" placeholder="For example 100000 — empty for none" value={bigAmount} onChange={(e) => setBigAmount(e.target.value)} />
            </div>
            <Select
              label="Most alerts in one day"
              value={maxPerDay}
              onChange={setMaxPerDay}
              options={[1, 2, 3, 5, 8, 10, 15, 20].map((n) => ({ value: String(n), label: String(n) }))}
              hint="The rest go into the next morning summary."
            />
          </div>}
          {alerts && <Select label="Template for alerts" value={alertTemplate} onChange={setAlertTemplate} options={templateOptions} placeholder="Choose an approved template" />}
          {needsTemplate(alerts, alertTemplate) ? <Badge tone="warning">Needs a Meta-approved template — stays in the app until then</Badge> : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          {message ? <span className={message.tone === "success" ? "text-success-fg" : "text-danger-fg"}>{message.text}</span> : null}
        </div>

        {view.recent.length > 0 ? (
          <div>
            <p className="label">Last messages</p>
            <ul className="divide-y divide-border-subtle">
              {view.recent.slice(0, 5).map((r) => (
                <li key={`${r.at}-${r.kind}`} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={r.status === "sent" ? "success" : "neutral"}>{r.kind === "summary" ? "Morning summary" : "Alert"}</Badge>
                    <span className="text-xs text-muted">{formatDateTime(r.at)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-2">{r.reason}</p>
                  <p className="mt-1 whitespace-pre-line text-xs text-foreground">{r.text}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
