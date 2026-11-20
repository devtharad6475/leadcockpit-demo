/**
 * Structured Settings panel — sales/products/policy/communication settings
 * tabs + conflict resolution.
 *
 * Extracted from src/app/page.tsx (chokepoint-rule cleanup, F-5) — pure
 * mechanical move, no behavior change. See src/app/sections/Compliance.tsx
 * for the extraction pattern this file follows.
 *
 * `TextAreaField` and `mergeProducts` are exported because they are also
 * used by QuestionsFromAI.tsx (the "review a settings draft created from an
 * answer" flow reuses the same textarea field + product-merge logic).
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, EmptyState, Button, PromptModal } from "@/components/ui";
import { Panel, Field } from "@/components/ui/primitives";
import {
  Settings, AlertCircle, Check, BarChart3, Gavel, MessageCircle,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { joinList, splitList } from "@/lib/settings-field-shapes";
import type { SalesSettings, PolicySettings, CommunicationSettings, SettingsConflict, ProductSetting } from "@/lib/types";
import { workspaceId } from "@/app/page";

// 2026-09-30 (page guide, redesign round 2): Products moved to the Catalogue
// screen (src/app/sections/ProductEditor.tsx). The tabs are named for what the
// owner decides in them, and "Conflicts" says what it is: decisions waiting.
type SettingsTab = "sales" | "policy" | "communication" | "conflicts";

const settingsTabs: Array<{ key: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "sales", label: "Selling rules", icon: BarChart3 },
  { key: "policy", label: "Policies", icon: Gavel },
  { key: "communication", label: "How the AI talks", icon: MessageCircle },
  { key: "conflicts", label: "Needs your decision", icon: AlertCircle },
];

/** Plain names for the settings a conflict can be about. */
const FIELD_LABELS: Record<string, string> = {
  defaultMOQ: "Default minimum order", standardCreditPeriod: "Standard credit period", quotationValidity: "How long a quote is valid",
  advancePaymentRule: "Advance payment", sampleAvailability: "Samples", bulkOrderRule: "Bulk orders",
  leadQualificationThresholds: "When a buyer counts as a good fit", humanReviewTriggers: "When a person must check",
  priceDiscussionRule: "Talking about price", discountNegotiationRules: "Discounts and negotiation",
  paymentPolicy: "Payment policy", creditPolicy: "Credit policy", shippingDeliveryPolicy: "Shipping and delivery",
  returnReplacementPolicy: "Returns and replacements", cancellationPolicy: "Cancellations", customizationPolicy: "Custom orders",
  samplePolicy: "Samples and catalogue", tone: "Tone", defaultFallbackReply: "Reply when the AI does not know",
  unknownAnswerBehavior: "What to do when the answer is unknown", stopUnsubscribeBehavior: "When someone says stop",
  priceReplyRule: "Replies about price", creditPaymentReplyRule: "Replies about credit and payment",
  complaintReplyRule: "Replies to complaints", abusiveMessageRule: "Abusive messages",
  allowedAutoReplyTopics: "Topics the AI may answer alone", humanReviewRequiredTopics: "Topics a person must check",
  moq: "Minimum order", price: "Price", priceUnit: "Price per", material: "Material", packaging: "Packaging",
};
const AREA_LABELS: Record<string, string> = { sales: "Selling rules", products: "Products", policy: "Policies", communication: "How the AI talks" };

/** "defaultMOQ" becomes "Default MOQ" when no plain name is known. */
export function plainFieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function StructuredSettingsPanel() {
  const [tab, setTab] = useState<SettingsTab>("sales");
  const [sales, setSales] = useState<Partial<SalesSettings>>({});
  const [policy, setPolicy] = useState<Partial<PolicySettings>>({});
  const [communication, setCommunication] = useState<Partial<CommunicationSettings>>({});
  const [conflicts, setConflicts] = useState<SettingsConflict[]>([]);
  const [message, setMessage] = useState("");
  // 2026-08-05 E-P1-4: was a single `message` for both success + error, both
  // rendered in success-green. Now tracks tone so a failed Save shows red.
  const [messageTone, setMessageTone] = useState<"success" | "danger">("success");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  // Cluster 5 P1-10: load-error state.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Stage A+ / Cluster 10b (P2-16): replace window.prompt for custom-conflict-
  // value with an accessible PromptModal. Tracks which conflict is being
  // custom-resolved (null when modal closed). One modal serves the whole list.
  const [customConflict, setCustomConflict] = useState<SettingsConflict | null>(null);
  const [pendingReconcile, setPendingReconcile] = useState<SettingsConflict | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      // Missing records are already returned as {} by the API. A failed read
      // must block editing rather than present blank rules as saved truth.
      const [s, po, c, co] = await Promise.all([
        api<SalesSettings>("/api/settings/sales"),
        api<PolicySettings>("/api/settings/policy"),
        api<CommunicationSettings>("/api/settings/communication"),
        api<SettingsConflict[]>("/api/settings/conflicts?status=open"),
      ]);
      if (s) setSales(s);
      if (po) setPolicy(po);
      if (c) setCommunication(c);
      setConflicts(co || []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load settings"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function saveSettings(label: string, action: () => Promise<void>) {
    setSaving(label);
    setMessage("");
    try {
      await action();
      setMessage(`${label} saved. The AI follows them from now on.`);
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not save ${label.toLowerCase()}.`);
      setMessageTone("danger");
    } finally {
      setSaving("");
    }
  }

  async function saveSales() {
    if (pendingReconcile?.settingsArea === "sales") return;
    await saveSettings("Selling rules", async () => {
      const saved = await api<SalesSettings>("/api/settings/sales", { method: "PUT", body: { workspaceId, ...sales } });
      setSales(saved);
    });
  }

  async function savePolicy() {
    if (pendingReconcile?.settingsArea === "policy") return;
    await saveSettings("Policies", async () => {
      const saved = await api<PolicySettings>("/api/settings/policy", { method: "PUT", body: { workspaceId, ...policy } });
      setPolicy(saved);
    });
  }

  async function saveCommunication() {
    if (pendingReconcile?.settingsArea === "communication") return;
    await saveSettings("How the AI talks", async () => {
      const saved = await api<CommunicationSettings>("/api/settings/communication", { method: "PUT", body: { workspaceId, ...communication } });
      setCommunication(saved);
    });
  }

  async function reconcileDecision(conflict: SettingsConflict) {
    if (!["sales", "policy", "communication"].includes(conflict.settingsArea)) return;
    setPendingReconcile(conflict);
    const saved = await api<Record<string, unknown>>(`/api/settings/${conflict.settingsArea}`);
    const merge = (current: Record<string, unknown>) => ({ ...current, [conflict.fieldKey]: saved[conflict.fieldKey] });
    if (conflict.settingsArea === "sales") setSales(merge);
    if (conflict.settingsArea === "policy") setPolicy(merge);
    if (conflict.settingsArea === "communication") setCommunication(merge);
    setPendingReconcile(null);
  }
  async function resolveConflict(conflictId: string, resolution: SettingsConflict["resolution"], customValue?: string) {
    if (saving || pendingReconcile) return;
    const conflict = conflicts.find(item => item.id === conflictId);
    await saveSettings("Decision", async () => {
      await api(`/api/settings/conflicts/${conflictId}/resolve`, { method: "POST", body: { workspaceId, resolution, customValue } });
      setConflicts((prev) => prev.filter((c) => c.id !== conflictId));
      // Read the actual saved value, merging only the decided field. A full
      // reload here would wipe unrelated drafts in the other sections.
      if (conflict) {
        try { await reconcileDecision(conflict); }
        catch { throw new Error("Your decision was saved, but its updated value could not be loaded. Retry the saved decision before saving this section. Other unfinished settings are kept."); }
      }
    });
  }

  async function ignoreConflict(conflictId: string) {
    if (saving) return;
    await saveSettings("Decision", async () => {
      await api(`/api/settings/conflicts/${conflictId}/ignore`, { method: "POST", body: { workspaceId } });
      setConflicts((prev) => prev.filter((c) => c.id !== conflictId));
    });
  }

  if (loadError) {
    return (
      <Card title="Business settings" icon={Settings}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={loadError}
          action={<Button onClick={() => load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load settings"))}>Try again</Button>}
        />
      </Card>
    );
  }

  return (
    <Panel title="Your business rules" icon={Settings}>
      <p className="text-sm text-muted-2">When your documents or website say something different from what you saved here, it waits under &ldquo;Needs your decision&rdquo;. Products and prices are on the Catalogue page.</p>
      <div className="mt-3 flex flex-wrap gap-2 border-b border-border-default pb-2">
        {settingsTabs.map(({ key, label, icon: Icon }) => (
          // N-A11Y-14 — which of these five is selected was carried ONLY by a
          // background colour. A screen reader announced five identical plain
          // buttons, and so did anyone using high-contrast mode, where the
          // colour difference can vanish entirely. `aria-pressed` states it.
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${tab === key ? "bg-primary text-white" : "bg-surface-tint text-muted-2 hover:bg-surface-tint"}`}
            onClick={() => setTab(key)}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
            {key === "conflicts" && conflicts.length > 0 ? (
              <span className="ml-1 rounded-full bg-danger-fg px-1.5 py-0 text-xs text-white">{conflicts.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {loading ? <p className="py-6 text-sm text-muted">Loading settings...</p> : (
        <fieldset disabled={Boolean(saving)} className="mt-4">
          {tab === "sales" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <SettingsGroup title="Minimum order and payment">
                <Field label="Default minimum order" value={sales.defaultMOQ || ""} onChange={(v) => setSales((p) => ({ ...p, defaultMOQ: v }))} />
                <Field label="Standard credit period" value={sales.standardCreditPeriod || ""} onChange={(v) => setSales((p) => ({ ...p, standardCreditPeriod: v }))} />
                <Field label="How long a quote is valid" value={sales.quotationValidity || ""} onChange={(v) => setSales((p) => ({ ...p, quotationValidity: v }))} />
                <Field label="Advance payment rule" value={sales.advancePaymentRule || ""} onChange={(v) => setSales((p) => ({ ...p, advancePaymentRule: v }))} />
              </SettingsGroup>
              <SettingsGroup title="Orders and samples">
                <Field label="Sample availability" value={sales.sampleAvailability || ""} onChange={(v) => setSales((p) => ({ ...p, sampleAvailability: v }))} />
                <Field label="Bulk order rule" value={sales.bulkOrderRule || ""} onChange={(v) => setSales((p) => ({ ...p, bulkOrderRule: v }))} />
                <Field label="When a buyer counts as a good fit" value={sales.leadQualificationThresholds || ""} onChange={(v) => setSales((p) => ({ ...p, leadQualificationThresholds: v }))} />
                <Field label="When a person must check first" value={sales.humanReviewTriggers || ""} onChange={(v) => setSales((p) => ({ ...p, humanReviewTriggers: v }))} />
              </SettingsGroup>
              <SettingsGroup title="Negotiation">
                <Field label="Price discussion rule" value={sales.priceDiscussionRule || ""} onChange={(v) => setSales((p) => ({ ...p, priceDiscussionRule: v }))} />
                <Field label="Discounts and negotiation" value={sales.discountNegotiationRules || ""} onChange={(v) => setSales((p) => ({ ...p, discountNegotiationRules: v }))} />
              </SettingsGroup>
            </div>
          )}

          {tab === "policy" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <SettingsGroup title="Payment and credit">
                <TextAreaField label="Payment policy" value={policy.paymentPolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, paymentPolicy: v }))} />
                <TextAreaField label="Credit policy" value={policy.creditPolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, creditPolicy: v }))} />
              </SettingsGroup>
              <SettingsGroup title="Shipping and returns">
                <TextAreaField label="Shipping / delivery policy" value={policy.shippingDeliveryPolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, shippingDeliveryPolicy: v }))} />
                <TextAreaField label="Return / replacement policy" value={policy.returnReplacementPolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, returnReplacementPolicy: v }))} />
              </SettingsGroup>
              <SettingsGroup title="Other policies">
                <TextAreaField label="Cancellation policy" value={policy.cancellationPolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, cancellationPolicy: v }))} />
                <TextAreaField label="Customization policy" value={policy.customizationPolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, customizationPolicy: v }))} />
                <TextAreaField label="Sample / catalogue policy" value={policy.samplePolicy || ""} onChange={(v) => setPolicy((p) => ({ ...p, samplePolicy: v }))} />
              </SettingsGroup>
            </div>
          )}

          {tab === "communication" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <SettingsGroup title="Tone and style">
                <Field label="Tone" value={communication.tone || ""} onChange={(v) => setCommunication((p) => ({ ...p, tone: v }))} />
                <Field label="Reply to use when unsure" value={communication.defaultFallbackReply || ""} onChange={(v) => setCommunication((p) => ({ ...p, defaultFallbackReply: v }))} />
                <Field label="When the AI does not know the answer" value={communication.unknownAnswerBehavior || ""} onChange={(v) => setCommunication((p) => ({ ...p, unknownAnswerBehavior: v }))} />
                <Field label="When someone says stop" value={communication.stopUnsubscribeBehavior || ""} onChange={(v) => setCommunication((p) => ({ ...p, stopUnsubscribeBehavior: v }))} />
              </SettingsGroup>
              <SettingsGroup title="Rules for replies">
                <Field label="Price reply rule" value={communication.priceReplyRule || ""} onChange={(v) => setCommunication((p) => ({ ...p, priceReplyRule: v }))} />
                <Field label="Credit / payment reply rule" value={communication.creditPaymentReplyRule || ""} onChange={(v) => setCommunication((p) => ({ ...p, creditPaymentReplyRule: v }))} />
                <Field label="Complaint reply rule" value={communication.complaintReplyRule || ""} onChange={(v) => setCommunication((p) => ({ ...p, complaintReplyRule: v }))} />
                <Field label="Abusive message rule" value={communication.abusiveMessageRule || ""} onChange={(v) => setCommunication((p) => ({ ...p, abusiveMessageRule: v }))} />
                <Field label="Topics the AI may answer alone (comma-separated)" value={joinList(communication.allowedAutoReplyTopics)} onChange={(v) => setCommunication((p) => ({ ...p, allowedAutoReplyTopics: splitList(v) }))} />
                <Field label="Topics a person must check (comma-separated)" value={joinList(communication.humanReviewRequiredTopics)} onChange={(v) => setCommunication((p) => ({ ...p, humanReviewRequiredTopics: splitList(v) }))} />
              </SettingsGroup>
            </div>
          )}

          {tab === "conflicts" && (
            <div className="space-y-3">
              {conflicts.length === 0 ? (
                <p className="text-sm text-muted">Nothing to decide. When your documents or website say something different from what you saved, it shows up here.</p>
              ) : (
                conflicts.map((conflict) => (
                  <div key={conflict.id} className="rounded-md border border-border-default bg-surface p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{plainFieldLabel(conflict.fieldKey)}</span>
                      <span className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-muted-2">{AREA_LABELS[conflict.settingsArea] || plainFieldLabel(conflict.settingsArea)}</span>
                    </div>
                    <div className="grid gap-2 text-sm md:grid-cols-2">
                      <div className="rounded bg-surface p-2">
                        <p className="text-xs text-muted">What you saved</p>
                        <p className="text-foreground">{conflict.existingValue || "(empty)"}</p>
                      </div>
                      <div className="rounded bg-surface p-2">
                        <p className="text-xs text-muted">What your documents or website say</p>
                        <p className="text-foreground">{conflict.extractedValue || "(empty)"}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn text-xs" disabled={Boolean(pendingReconcile)} onClick={() => resolveConflict(conflict.id, "keep_existing")}>Keep mine</button>
                      <button className="btn secondary text-xs" disabled={Boolean(pendingReconcile)} onClick={() => resolveConflict(conflict.id, "use_extracted")}>Use theirs</button>
                      <button className="btn secondary text-xs" disabled={Boolean(pendingReconcile)} onClick={() => setCustomConflict(conflict)}>Write my own</button>
                      <button className="btn secondary text-xs" disabled={Boolean(pendingReconcile)} onClick={() => resolveConflict(conflict.id, "keep_both")}>Keep both</button>
                      <button className="btn secondary text-xs" onClick={() => ignoreConflict(conflict.id)}>Decide later</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </fieldset>
      )}

      {tab !== "conflicts" && (
        <button
          className="btn mt-4"
          disabled={Boolean(saving) || loading || pendingReconcile?.settingsArea === tab}
          onClick={() => {
            const save = async () => {
              if (tab === "sales") await saveSales();
              if (tab === "policy") await savePolicy();
              if (tab === "communication") await saveCommunication();
            };
            save().catch((error) => setMessage(error instanceof Error ? error.message : "Could not save settings."));
          }}
        >
          <Check className="h-4 w-4" /> {saving ? "Saving…" : `Save ${(settingsTabs.find((t) => t.key === tab)?.label || "").toLowerCase()}`}
        </button>
      )}

      {message ? <p className={`mt-3 rounded-md border p-2 text-sm ${messageTone === "danger" ? "border-danger-border bg-danger-subtle text-danger-fg" : "border-success-bg bg-surface-tint text-success-fg"}`}>{message}</p> : null}
      {pendingReconcile ? <Button variant="secondary" disabled={Boolean(saving)} onClick={() => saveSettings("Saved decision", () => reconcileDecision(pendingReconcile))}>Retry saved decision</Button> : null}

      {/* Stage A+ / Cluster 10b (P2-16): custom-conflict-value modal. Replaces
          the window.prompt() call. Pre-fills with the existing value. */}
      <PromptModal
        open={customConflict !== null}
        onClose={() => setCustomConflict(null)}
        title={customConflict ? `Your own wording: ${plainFieldLabel(customConflict.fieldKey)}` : "Your own wording"}
        label="What should it say?"
        defaultValue={customConflict?.existingValue || ""}
        okLabel="Save"
        onSubmit={(value) => {
          const c = customConflict;
          setCustomConflict(null);
          if (c) resolveConflict(c.id, "custom", value);
        }}
      />
    </Panel>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border-default bg-surface p-3">
      <p className="mb-3 font-semibold text-foreground">{title}</p>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

export function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span className="label">{label}</span><textarea className="input min-h-20" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function mergeProducts(existing: ProductSetting[], drafts: ProductSetting[]) {
  const byName = new Map(existing.map((product) => [product.name.trim().toLowerCase(), product]));
  const merged = [...existing];
  for (const draft of drafts) {
    const key = draft.name.trim().toLowerCase();
    const current = byName.get(key);
    if (current) {
      Object.assign(current, {
        ...draft,
        id: current.id,
        notes: [current.notes, draft.notes].filter(Boolean).join(" "),
      });
    } else {
      merged.push(draft);
      byName.set(key, draft);
    }
  }
  return merged;
}
