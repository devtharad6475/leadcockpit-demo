/**
 * AI Settings screen.
 *
 * 2026-09-25 redesign (CEO: "AI settings is the one thing making me so much
 * confused ... everything is the same colour"). The screen was nine equal
 * white boxes, 3,700px tall, listing the six AI jobs twice and using system
 * words (slot, tokens, fallback, Ollama base URL, tier guide).
 *
 * It is now:
 *   1. Three coloured status tiles — is the AI working, what runs without
 *      you, what it has cost. The answers an owner comes here for.
 *   2. Three tabs: What the AI may do · Which AI does each job · Spending limits.
 *   3. The technical choices for one job (service, model, key, backup) live in
 *      a side panel that opens only when the owner presses "Change".
 * Nothing was removed: every control that existed is still reachable.
 *
 * Extracted from src/app/page.tsx (chokepoint-rule cleanup, F-5). See
 * src/app/sections/Compliance.tsx for the extraction pattern this file follows.
 */
"use client";
import { formatDateTime } from "@/lib/format-date";
import React, { useEffect, useState } from "react";
import { Card, EmptyState, Button, Badge, Tabs, Drawer, DrawerBody, DrawerFooter, StatusTile } from "@/components/ui";
import { Field, SecretField, Chips, Row } from "@/components/ui/primitives";
import {
  Settings, AlertCircle, Check, Sparkles, AlertTriangle, Activity, Wallet, Pencil,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { displayLabel } from "@/lib/display-labels";
import type { Runner } from "@/app/page";
import { workspaceId } from "@/app/page";
// N-UI-6 - the four autonomy switches are named in ONE place, shared with
// the header status chip, so the same switch cannot have two names.
import { AUTONOMY_JOBS, AUTONOMY_CHOICES, AUTONOMY_CHANGED_EVENT, countAutomatic, notifyAutonomyChanged } from "@/lib/ai-autonomy-jobs";

/**
 * N-BUG (2026-09-08). The header chip can only fit two or three words, and it
 * links here. So this is where the sentence has to be — the owner who clicks
 * "AI out of credit" must land on the explanation and the fix, not on six
 * dropdowns that all look fine.
 */
/** The workspace's own caps, and what has been spent against them today. */
type AIUsageLimit = {
  id?: string;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  dailyCostLimit?: number;
  monthlyCostLimit?: number;
  currentDailyTokens?: number;
  currentMonthlyTokens?: number;
  currentDailyCost?: number;
  currentMonthlyCost?: number;
};

type CapField = { key: keyof AIUsageLimit; usedKey: keyof AIUsageLimit; label: string; isCost?: boolean };

const CAP_FIELDS: CapField[] = [
  { key: "dailyTokenLimit", usedKey: "currentDailyTokens", label: "Tokens per day" },
  { key: "monthlyTokenLimit", usedKey: "currentMonthlyTokens", label: "Tokens per month" },
  { key: "dailyCostLimit", usedKey: "currentDailyCost", label: "Most it may spend in a day (US$)", isCost: true },
  { key: "monthlyCostLimit", usedKey: "currentMonthlyCost", label: "Most it may spend in a month (US$)", isCost: true },
];

function formatUsed(usage: AIUsageLimit | null, key: keyof AIUsageLimit, isCost?: boolean) {
  const value = usage?.[key];
  if (typeof value !== "number") return isCost ? "$0.00" : "0";
  return isCost ? `$${value.toFixed(2)}` : value.toLocaleString();
}

type ProviderHealth = {
  status: "healthy" | "degraded" | "blocked" | "unknown";
  headline: string;
  action: string;
  reason: string;
  provider?: string;
  degradedCalls: number;
  lastRealSuccessAt?: string;
  since?: string;
};

export function AISettings({ run }: { run: Runner }) {
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [usageLimit, setUsageLimit] = useState<AIUsageLimit | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<Array<Record<string, unknown>>>([]);
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [slots, setSlots] = useState<Array<Record<string, unknown>>>([]);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [baseUrl] = useState("http://localhost:11434");
  const [tab, setTab] = useState("autonomy");
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [autoSettings, setAutoSettings] = useState<Record<string, unknown> | null>(null);
  // Cluster 5 P1-10: load-error state. Previously a 500 meant a blank panel.
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() {
    setLoadError(null);
    const [loadedProviders, loadedCatalog, loadedSlots, loadedAuto, loadedHealth, loadedUsage] = await Promise.all([
      api<Array<Record<string, unknown>>>("/api/ai/providers"),
      api<{ models: Array<Record<string, unknown>> }>("/api/ai/model-catalog"),
      api<Array<Record<string, unknown>>>("/api/ai/model-slots"),
      api<Record<string, unknown>>("/api/agent-autonomous/settings"),
      // Swallowed on failure on purpose: if the health read itself breaks, this
      // screen must still load. A missing answer here is not bad news about the
      // AI, and must not be rendered as any.
      api<ProviderHealth>("/api/ai/provider-health").catch(() => null),
      api<AIUsageLimit>("/api/ai/usage-limits").catch(() => null),
    ]);
    setHealth(loadedHealth);
    setUsageLimit(loadedUsage);
    // 0 is how "no cap" is stored — the health check only blocks on a cap above
    // zero — so it has to come back as an empty box, not as a cap of nothing.
    const capText = (value: number | undefined) => (typeof value === "number" && value > 0 ? String(value) : "");
    setCaps({
      dailyTokenLimit: capText(loadedUsage?.dailyTokenLimit),
      monthlyTokenLimit: capText(loadedUsage?.monthlyTokenLimit),
      dailyCostLimit: capText(loadedUsage?.dailyCostLimit),
      monthlyCostLimit: capText(loadedUsage?.monthlyCostLimit),
    });
    setProviders(loadedProviders);
    setModels(loadedCatalog.models);
    setSlots((prev) => {
      return loadedSlots.map((serverSlot: Record<string, unknown>) => {
        const local = prev.find((l: Record<string, unknown>) => String(l.slotId) === String(serverSlot.slotId));
        return {
          ...serverSlot,
          fetchedModels: (local?.fetchedModels as Array<Record<string, unknown>> | undefined) || serverSlot.fetchedModels,
          fallbackFetchedModels: (local?.fallbackFetchedModels as Array<Record<string, unknown>> | undefined) || serverSlot.fallbackFetchedModels,
        };
      });
    });
    setAutoSettings(loadedAuto);
  }
  useEffect(() => {
    const reload = () => { load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load AI settings")); };
    const timer = window.setTimeout(reload, 0);
    // Symmetric with the header chip: if the AI is paused from the header while
    // this screen is open, these dropdowns must not keep showing the old value.
    window.addEventListener(AUTONOMY_CHANGED_EVENT, reload);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(AUTONOMY_CHANGED_EVENT, reload);
    };
  }, []);
  if (loadError) {
    return (
      <Card title="AI Settings" icon={Settings}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={loadError}
          action={<Button onClick={() => load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load AI settings"))}>Try again</Button>}
        />
      </Card>
    );
  }
  const editing = slots.find((slot) => String(slot.slotId) === editingSlotId) || null;
  const saveSlots = async () => {
    setSlots(await api<Array<Record<string, unknown>>>("/api/ai/model-slots", { method: "PUT", body: { workspaceId, slots } }));
    await load();
  };
  const testSlot = (slotId: string) => run(`Check ${jobName(slotId)}`, async () => {
    try {
      setTestResult(await api<Record<string, unknown>>(`/api/ai/model-slots/${slotId}/test`, { method: "POST", body: { workspaceId, sample: "Hi, send catalogue" } }));
    } catch (error: unknown) {
      setTestResult({ success: false, error: { message: error instanceof Error ? error.message : "Check failed" } });
    }
  });

  return (
    <div className="space-y-5">
      {/* N-BUG (2026-09-08) — shown ONLY when something is actually wrong, and
          first, because nothing else on this screen matters while the model
          behind it is not answering. */}
      {health && (health.status === "blocked" || health.status === "degraded") ? (
        <div
          className={`rounded-xl border p-4 ${health.status === "blocked"
            ? "border-danger-border bg-danger-bg text-danger-fg"
            : "border-warning-border bg-warning-bg text-warning-fg"}`}
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{health.headline}</p>
              {health.action ? <p className="mt-1 text-sm">{health.action}</p> : null}
              <p className="mt-2 text-xs leading-relaxed opacity-90">
                While this lasts, the AI does not write real replies. Messages fall back to safe
                canned text, nothing is auto-sent for approval-free jobs, and message sorting drops
                to keyword matching. Nothing is invented and nothing is lost.
                {health.degradedCalls > 0 ? ` ${health.degradedCalls} recent AI ${health.degradedCalls === 1 ? "call has" : "calls have"} been affected.` : ""}
                {health.lastRealSuccessAt ? ` The real model last answered on ${formatDateTime(health.lastRealSuccessAt)}.` : ""}
              </p>
              <p className="mt-2 text-xs font-medium">
                There is nothing to switch back on. Every call still tries your real model first, so
                this clears itself the moment it works again.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* 2026-09-25 (CEO: "AI settings is making me confused") — the three
          answers an owner comes here for, readable in two seconds, each in its
          own colour. The detail sits behind the tabs below, not beside it. */}
      <div className="grid gap-3 md:grid-cols-3">
        <StatusTile
          tone={!health || health.status === "healthy" ? "success" : health.status === "blocked" ? "danger" : "warning"}
          icon={Activity}
          label="Is the AI working?"
          value={!health ? "Not checked yet" : health.status === "healthy" ? "Yes, answering normally" : health.status === "blocked" ? "No, it has stopped" : "Partly, using backups"}
          note={health?.lastRealSuccessAt ? `Last real answer ${formatDateTime(health.lastRealSuccessAt)}` : "Checked every time the AI is used"}
        />
        <StatusTile
          tone="info"
          icon={Sparkles}
          label="What runs without you"
          value={`${countAutomatic(autoSettings)} of ${AUTONOMY_JOBS.length} jobs`}
          note={countAutomatic(autoSettings) === 0 ? "You approve everything" : "The rest wait for your approval"}
          onClick={() => setTab("autonomy")}
        />
        <StatusTile
          tone={spendTone(usageLimit)}
          icon={Wallet}
          label="Spent on AI today"
          value={`${money(usageLimit?.currentDailyCost)}${usageLimit?.dailyCostLimit ? ` of ${money(usageLimit.dailyCostLimit)}` : ""}`}
          note={`This month ${money(usageLimit?.currentMonthlyCost)}${usageLimit?.monthlyCostLimit ? ` of ${money(usageLimit.monthlyCostLimit)}` : ""}`}
          onClick={() => setTab("spend")}
        />
      </div>

      <section className="rounded-xl border border-border-default bg-surface shadow-sm">
        <Tabs
          className="px-3 pt-2"
          activeTab={tab}
          onSelect={setTab}
          tabs={[
            { id: "autonomy", label: "What the AI may do" },
            { id: "jobs", label: "Which AI does each job" },
            { id: "spend", label: "Spending limits" },
          ]}
        />
        <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} className="p-5">
          {tab === "autonomy" ? (
            <>
              <p className="text-sm text-muted">
                Choose, job by job, whether the AI asks you first. Each choice saves the moment you change it.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {AUTONOMY_JOBS.map((job) => {
                  const automatic = String(autoSettings?.[job.field] || "manual") === "automatic";
                  return (
                    <label
                      key={job.field}
                      className={`flex flex-col rounded-lg border p-4 ${automatic ? "border-info-border bg-info-bg" : "border-border-default bg-surface-muted"}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{job.label}</span>
                        <Badge tone={automatic ? "info" : "neutral"}>{automatic ? "Runs on its own" : "Asks you first"}</Badge>
                      </span>
                      {/* flex-1 absorbs the slack so the dropdowns line up across the row. */}
                      <span className="mt-1 mb-3 block flex-1 text-xs leading-relaxed text-muted">{job.detail}</span>
                      <select
                        className="input"
                        value={automatic ? "automatic" : "manual"}
                        onChange={(e) => run(`Update ${job.label}`, async () => {
                          await api("/api/agent-autonomous/settings", { method: "POST", body: { workspaceId, [job.field]: e.target.value } });
                          await load();
                          notifyAutonomyChanged(); // keep the header chip honest
                        })}
                      >
                        {AUTONOMY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                      </select>
                    </label>
                  );
                })}
              </div>
            </>
          ) : null}

          {tab === "jobs" ? (
            <>
              <p className="text-sm text-muted">
                Each job can use a different AI service. A selected service still needs a working connection.
                Use Check to verify it; sample answers are labelled clearly.
              </p>
              <ul className="mt-4 divide-y divide-border-subtle rounded-lg border border-border-default">
                {slots.map((slot) => {
                  const slotId = String(slot.slotId);
                  const live = String(slot.provider || "mock") !== "mock";
                  const configured = live && (!providerRequiresApiKey(String(slot.provider)) || Boolean(slot.credentialId || slot.hasPlatformKey));
                  return (
                    <li key={slotId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                      <span className={`mt-1 h-2.5 w-2.5 shrink-0 self-start rounded-full sm:mt-0 sm:self-center ${configured ? "bg-info-fg" : "bg-warning-fg"}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground">{jobName(slotId)}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted">{jobMeaning(slotId)}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                        <Badge tone={configured ? "info" : "warning"}>
                          {live ? `${configured ? "Configured" : "Key needed"} · ${displayLabel(String(slot.provider))}` : "Sample answers only"}
                        </Badge>
                        {live ? <span className="text-xs text-muted">{String(slot.customModelName || slot.modelName || "")}</span> : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="secondary" onClick={() => testSlot(slotId)} aria-label={`Check ${jobName(slotId)}`}>Check</Button>
                        <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditingSlotId(slotId)} aria-label={`Change ${jobName(slotId)}`}>Change</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-muted">
                &quot;Check&quot; sends one harmless test question. Nothing goes to a customer.
              </p>
              {testResult ? <ReadableResult result={testResult} /> : null}
            </>
          ) : null}

          {tab === "spend" ? (
            <>
              <p className="text-sm text-muted">
                Your own limits. When one is reached, the AI stops and safe canned text is used instead.
                Leave a box empty for no limit.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {CAP_FIELDS.filter((field) => field.isCost).map((field) => (
                  <CapInput key={field.key} field={field} caps={caps} setCaps={setCaps} usage={usageLimit} />
                ))}
              </div>
              <details className="mt-4 rounded-lg border border-border-default bg-surface-muted p-4">
                <summary className="cursor-pointer text-sm font-semibold text-foreground">More limits: by amount of text</summary>
                <p className="mt-2 text-xs text-muted">
                  AI services count text in &quot;tokens&quot; (about ¾ of a word each). Most owners only need the money limits above.
                </p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {CAP_FIELDS.filter((field) => !field.isCost).map((field) => (
                    <CapInput key={field.key} field={field} caps={caps} setCaps={setCaps} usage={usageLimit} />
                  ))}
                </div>
              </details>
              <Button
                className="mt-4"
                icon={Check}
                onClick={() => run("Saving AI spend caps", async () => {
                  const payload: Record<string, number | null> = {};
                  for (const field of CAP_FIELDS) {
                    const raw = String(caps[field.key] ?? "").trim();
                    payload[field.key] = raw === "" ? null : Number(raw);
                  }
                  await api("/api/ai/usage-limits", { method: "PUT", body: { workspaceId, ...payload } });
                  await load();
                })}
              >
                Save limits
              </Button>
            </>
          ) : null}
        </div>
      </section>

      {/* The technical choices for ONE job, only when the owner asks to change
          it. Keys are entered inside the job that uses them, so different jobs
          can bill to different accounts; saved keys are masked and encrypted. */}
      <Drawer
        open={Boolean(editing)}
        onOpenChange={(open) => { if (!open) setEditingSlotId(null); }}
        title={editing ? `Change: ${jobName(String(editing.slotId))}` : "Change"}
        description={editing ? jobMeaning(String(editing.slotId)) : undefined}
        size="lg"
      >
        {editing ? (() => {
          const slot = editing;
          const slotId = String(slot.slotId);
          const provider = String(slot.provider || "mock");
          const fallbackProvider = String(slot.fallbackProvider || "mock");
          return (
            <>
              <DrawerBody className="space-y-4">
                <label className="block"><span className="label">AI service</span><select className="input" value={provider} onChange={(event) => {
                  const next = event.target.value;
                  const firstModel = models.find((m) => String(m.provider) === next);
                  updateSlot(slots, setSlots, slotId, { provider: next, modelName: firstModel?.modelName || "", modelTier: firstModel?.tier, baseUrl: next === "ollama" ? baseUrl : "", credentialId: undefined, apiKey: "", primaryKeyPreview: undefined, customModelName: "", fetchedModels: undefined, hasPlatformKey: false, warnings: [] });
                  setTestResult(null);
                }}>{providers.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.id) === "mock" ? "Sample answers (free, not real AI)" : displayLabel(String(p.id))}</option>)}</select></label>
                <div>
                  <label className="block"><span className="label">Model</span><select className="input" value={String(slot.modelName || "")} onChange={(event) => { updateSlot(slots, setSlots, slotId, { modelName: event.target.value }); setTestResult(null); }}>
                    {modelOptions(slot.fetchedModels, models, provider, slot.modelName)}
                  </select></label>
                  <button type="button" className="mt-1 text-xs font-semibold text-primary hover:underline" aria-label={`Fetch models for ${jobName(slotId)}`} onClick={() => run("Fetch provider models", async () => {
                    const response = await api<{ models: Array<Record<string, unknown>>; warning?: string }>("/api/ai/models/fetch", { method: "POST", body: { workspaceId, provider: slot.provider, apiKey: slot.apiKey, baseUrl: slot.baseUrl || (provider === "ollama" ? baseUrl : undefined) } });
                    updateSlot(slots, setSlots, slotId, { fetchedModels: response.models });
                    setTestResult({ warning: response.warning || "Model list refreshed." });
                  })}>Fetch models from this service</button>
                </div>
                {needsCustomModelName(slot.modelName) ? <Field label="Model name, exactly as the service spells it" value={String(slot.customModelName || "")} onChange={(value) => updateSlot(slots, setSlots, slotId, { customModelName: value })} /> : null}
                {providerRequiresApiKey(provider) ? (
                  <SecretField label={slot.primaryKeyPreview ? `API key (saved: ${String(slot.primaryKeyPreview)})` : slot.hasPlatformKey ? "API key (optional — the platform key is used if empty)" : "API key"} value={String(slot.apiKey || "")} onChange={(value) => updateSlot(slots, setSlots, slotId, { apiKey: value })} />
                ) : null}
                {providerNeedsBaseUrl(provider) ? <Field label={provider === "ollama" ? "Ollama address" : "Service address"} value={String(slot.baseUrl || (provider === "ollama" ? baseUrl : ""))} onChange={(value) => updateSlot(slots, setSlots, slotId, { baseUrl: value })} /> : null}
                {provider === "ollama" ? <p className="text-xs text-muted">Ollama runs on the computer running LeadCockpit. A cloud copy cannot reach a laptop.</p> : null}
                {((slot.warnings as string[] | undefined) || []).length ? <Chips items={(slot.warnings as string[]).slice(0, 3)} /> : null}

                <details className="rounded-lg border border-border-default bg-surface-muted p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">Backup AI (used only if the first one fails)</summary>
                  <div className="mt-3 space-y-3">
                    <label className="block"><span className="label">Backup AI service</span><select className="input" value={fallbackProvider} onChange={(event) => {
                      const next = event.target.value;
                      const firstModel = models.find((m) => String(m.provider) === next);
                      updateSlot(slots, setSlots, slotId, { fallbackProvider: next, fallbackModelName: firstModel?.modelName || "", fallbackBaseUrl: next === "ollama" ? baseUrl : "", fallbackCredentialId: undefined, fallbackApiKey: "", fallbackKeyPreview: undefined, fallbackCustomModelName: "", fallbackFetchedModels: undefined });
                      setTestResult(null);
                    }}>{providers.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.id) === "mock" ? "Sample answers (free, not real AI)" : displayLabel(String(p.id))}</option>)}</select></label>
                    <label className="block"><span className="label">Backup model</span><select className="input" value={String(slot.fallbackModelName || "")} onChange={(event) => { updateSlot(slots, setSlots, slotId, { fallbackModelName: event.target.value }); setTestResult(null); }}>
                      {modelOptions(slot.fallbackFetchedModels, models, fallbackProvider, slot.fallbackModelName)}
                    </select></label>
                    {needsCustomModelName(slot.fallbackModelName) ? <Field label="Backup model name" value={String(slot.fallbackCustomModelName || "")} onChange={(value) => updateSlot(slots, setSlots, slotId, { fallbackCustomModelName: value })} /> : null}
                    <button type="button" className="text-xs font-semibold text-primary hover:underline" aria-label={`Fetch fallback models for ${jobName(slotId)}`} onClick={() => run("Fetch fallback models", async () => {
                      const response = await api<{ models: Array<Record<string, unknown>>; warning?: string }>("/api/ai/models/fetch", { method: "POST", body: { workspaceId, provider: slot.fallbackProvider, apiKey: slot.fallbackApiKey, baseUrl: slot.fallbackBaseUrl || (fallbackProvider === "ollama" ? baseUrl : undefined) } });
                      updateSlot(slots, setSlots, slotId, { fallbackFetchedModels: response.models });
                      setTestResult({ warning: response.warning || "Backup model list refreshed." });
                    })}>Fetch backup models</button>
                    {providerRequiresApiKey(fallbackProvider) ? <SecretField label={slot.fallbackKeyPreview ? `Backup API key (saved: ${String(slot.fallbackKeyPreview)})` : "Backup API key (optional)"} value={String(slot.fallbackApiKey || "")} onChange={(value) => updateSlot(slots, setSlots, slotId, { fallbackApiKey: value })} /> : null}
                    {providerNeedsBaseUrl(fallbackProvider) ? <Field label={fallbackProvider === "ollama" ? "Backup Ollama address" : "Backup service address"} value={String(slot.fallbackBaseUrl || (fallbackProvider === "ollama" ? baseUrl : ""))} onChange={(value) => updateSlot(slots, setSlots, slotId, { fallbackBaseUrl: value })} /> : null}
                  </div>
                </details>
                <p className="text-xs text-muted">For a model missing from the list, fetch this service&apos;s models. A custom Ollama or compatible-service model lets you enter its exact name.</p>
                {testResult ? <ReadableResult result={testResult} /> : null}
              </DrawerBody>
              <DrawerFooter>
                <Button variant="secondary" onClick={() => run(`Check ${jobName(slotId)}`, async () => {
                  await saveSlots();
                  try {
                    setTestResult(await api<Record<string, unknown>>(`/api/ai/model-slots/${slotId}/test`, { method: "POST", body: { workspaceId, sample: "Hi, send catalogue" } }));
                  } catch (error: unknown) {
                    setTestResult({ success: false, error: { message: error instanceof Error ? error.message : "Check failed" } });
                  }
                })} aria-label={`Test ${jobName(slotId)}`}>Save and check</Button>
                <Button icon={Check} onClick={() => run("Save model slots", async () => { await saveSlots(); setEditingSlotId(null); })}>Save</Button>
              </DrawerFooter>
            </>
          );
        })() : null}
      </Drawer>
    </div>
  );
}

function CapInput({ field, caps, setCaps, usage }: {
  field: CapField;
  caps: Record<string, string>;
  setCaps: (caps: Record<string, string>) => void;
  usage: AIUsageLimit | null;
}) {
  const used = Number(usage?.[field.usedKey] || 0);
  const cap = Number(caps[field.key] || 0);
  const share = cap > 0 ? Math.min(1, used / cap) : 0;
  return (
    <label className="block">
      <span className="label">{field.label}</span>
      <input
        className="input"
        type="number"
        min={0}
        inputMode="numeric"
        placeholder="No limit"
        value={caps[field.key] ?? ""}
        onChange={(event) => setCaps({ ...caps, [field.key]: event.target.value })}
      />
      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-border-subtle" aria-hidden="true">
        <span
          className={`block h-full rounded-full ${share >= 0.9 ? "bg-danger-fg" : share >= 0.7 ? "bg-warning-fg" : "bg-success-fg"}`}
          style={{ width: `${Math.max(share * 100, used > 0 ? 2 : 0)}%` }}
        />
      </span>
      <span className="mt-1 block text-xs text-muted">
        Used so far: {formatUsed(usage, field.usedKey, field.isCost)}{cap > 0 ? ` (${Math.round(share * 100)}%)` : ""}
      </span>
    </label>
  );
}

function money(value: number | undefined) {
  return `$${(typeof value === "number" ? value : 0).toFixed(2)}`;
}

function spendTone(usage: AIUsageLimit | null): "success" | "warning" | "danger" {
  const shares = [
    usage?.dailyCostLimit ? (usage.currentDailyCost || 0) / usage.dailyCostLimit : 0,
    usage?.monthlyCostLimit ? (usage.currentMonthlyCost || 0) / usage.monthlyCostLimit : 0,
  ];
  const worst = Math.max(...shares);
  return worst >= 0.9 ? "danger" : worst >= 0.7 ? "warning" : "success";
}

function modelOptions(fetched: unknown, catalog: Array<Record<string, unknown>>, provider: string, current: unknown) {
  const source = (fetched as Array<Record<string, unknown>> | undefined) || catalog;
  let options = source.filter((model) => String(model.provider) === provider);
  if (options.length === 0) options = catalog.filter((model) => String(model.provider) === provider);
  // Keep the saved value selectable so the dropdown never silently reverts it.
  if (current && !options.some((o) => String(o.modelName) === String(current))) {
    options = [...options, { id: `virtual:${current}`, modelName: current, displayName: String(current) }];
  }
  if (options.length === 0) return <option value="">No models available</option>;
  return options.map((model) => <option key={String(model.id)} value={String(model.modelName)}>{String(model.displayName || model.modelName)}</option>);
}

/**
 * The six jobs, named for what they do for the business rather than by the
 * system's slot ids. `jobMeaning` is the one line that says what depends on it.
 * The embedding line keeps the honest "by meaning" claim the Knowledge Base
 * relies on; the image line says plainly that no pictures are made.
 */
const JOBS: Record<string, { name: string; meaning: string }> = {
  fast_customer_reply: { name: "Quick customer replies", meaning: "Writes short WhatsApp replies and sorts incoming messages." },
  daily_workhorse: { name: "Everyday work", meaning: "Reads your documents, scores leads, writes drafts and reviews leads." },
  deep_reasoning: { name: "Careful thinking", meaning: "Product research, ideal customers, campaign plans and quality checks." },
  research_search: { name: "Web research", meaning: "Market research. Searches the live web when a search key is set; otherwise uses sample results." },
  creative_image: { name: "Campaign ideas", meaning: "Writes campaign idea briefs as text. It does not make pictures — image generation is not wired." },
  embedding_advanced: { name: "Knowledge search", meaning: "Finds the right fact in your knowledge base by meaning (semantic search), not just matching words. Falls back to word matching without a key." },
};

function jobName(slotId: string) {
  return JOBS[slotId]?.name || slotId;
}

function jobMeaning(slotId: string) {
  return JOBS[slotId]?.meaning || "";
}

function updateSlot(slots: Array<Record<string, unknown>>, setSlots: (slots: Array<Record<string, unknown>>) => void, slotId: string, patch: Record<string, unknown>) {
  setSlots(slots.map((slot) => String(slot.slotId) === slotId ? { ...slot, ...patch } : slot));
}

function providerNeedsBaseUrl(provider: string) {
  return ["ollama", "openai_compatible", "anthropic_compatible", "gemini_compatible"].includes(provider);
}

function providerRequiresApiKey(provider: string) {
  return provider !== "mock" && provider !== "ollama";
}

// Matches ModelRouter.resolveEffectiveModelName: an exact-name field must
// appear only when the runtime will actually use it instead of the list value.
function needsCustomModelName(value: unknown) {
  const model = String(value || "");
  return model.endsWith("-custom") || model.includes("-compatible") || model === "custom-local-http";
}

function normalizeTestSlotResult(result: Record<string, unknown>) {
  if (result.success === false || result.error) {
    return { isError: true, error: (result.error as Record<string, unknown>) || result };
  }

  const data = (result.data as Record<string, unknown>) || result;
  const isMissingMetadata = !data.providerDisplayName || data.providerDisplayName === "Unknown Provider" || !data.effectiveModelName || data.effectiveModelName === "Unknown Model";

  const mode = String(data.mode || "unknown");
  const fallbackUsed = Boolean(data.fallbackUsed);
  const status = String(data.status || "ready");

  const modeLabel = fallbackUsed ? "Backup model used" : (mode === "mock" ? "Sample mode" : "Live AI");
  const fallbackText = fallbackUsed
    ? "Yes — fallback model was used because the selected model failed."
    : "No — selected model was used.";

  const statusLabel = status === "ready" ? "Ready to use" : (status === "fallback_used" ? "Backup used" : "Failed");

  const responsePreview = typeof data.testResponse === "string"
    ? (data.testResponse.length > 150 ? data.testResponse.substring(0, 150) + "..." : data.testResponse)
    : JSON.stringify(data.testResponse);

  return {
    isError: false,
    isMissingMetadata,
    slotDisplayName: String(data.slotDisplayName || "Unknown"),
    providerDisplayName: String(data.providerDisplayName || "Unknown"),
    modelTested: String(data.effectiveModelName || data.modelName || "Unknown"),
    modeLabel,
    fallbackText,
    statusLabel,
    responsePreview,
    advancedDetails: data,
    mode,
    fallbackUsed,
    fallbackReason: data.fallbackReason
  };
}

function ReadableResult({ result }: { result: Record<string, unknown> }) {
  const normalized = normalizeTestSlotResult(result);

  if (normalized.isError) {
    return (
      <div className="mt-3 rounded-md border border-danger-bg bg-danger-bg p-4 text-sm text-danger-fg">
        <div className="flex items-center gap-2 font-bold"><AlertTriangle className="h-5 w-5" /> Check failed</div>
        <p className="mt-2 font-semibold">{String(normalized.error?.message || normalized.error || "Unknown error")}</p>
        <details className="mt-3 cursor-pointer text-xs opacity-80">
          <summary>Developer diagnostics</summary>
          <div className="mt-2 rounded bg-surface/80 p-2 text-foreground">
            <p>Provider: {String(result.providerDisplayName || result.provider || "Unknown")}</p>
            <p>Model: {String(result.effectiveModelName || result.modelName || "Unknown")}</p>
            <p>Status: {String(result.status || "failed")}</p>
            <p>Backup used: {String(Boolean(result.fallbackUsed))}</p>
          </div>
        </details>
      </div>
    );
  }

  if (normalized.isMissingMetadata) {
    return (
      <div className="mt-3 rounded-md border border-warning-bg bg-warning-bg p-4 text-sm text-warning-fg">
        <div className="flex items-center gap-2 font-bold"><AlertTriangle className="h-5 w-5" /> Check incomplete</div>
        <p className="mt-2 font-semibold">Test completed, but provider/model details were missing. Please test again or check AI Settings configuration.</p>
        <details className="mt-3 cursor-pointer text-xs opacity-80">
          <summary>Developer diagnostics</summary>
          <div className="mt-2 rounded bg-surface/80 p-2 text-foreground">
            <p>Provider: {String(result.providerDisplayName || result.provider || "Unknown")}</p>
            <p>Model: {String(result.effectiveModelName || result.modelName || "Unknown")}</p>
            <p>Status: {String(result.status || "metadata_incomplete")}</p>
            <p>Backup used: {String(Boolean(result.fallbackUsed))}</p>
          </div>
        </details>
      </div>
    );
  }

  const isSuccess = normalized.statusLabel === "Ready to use" && !normalized.fallbackUsed && normalized.mode === "real";

  return (
    <div className={`mt-3 rounded-md border p-4 text-sm ${isSuccess ? "border-success-bg bg-success-bg text-success-fg" : "border-warning-bg bg-warning-bg text-warning-fg"}`}>
      <div className="flex items-center gap-2 font-bold">
        {isSuccess ? <Check className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        {isSuccess ? "It answered — this job is using real AI" : "It answered, but not with your chosen AI"}
      </div>
      <p className="mt-2 font-semibold">
        {isSuccess ? "The selected model responded successfully and is ready to use." : "The test completed but used a backup or sample model."}
      </p>

      <div className={`mt-3 grid gap-1 border-t pt-3 ${isSuccess ? "border-success-bg/50" : "border-warning-fg/20"}`}>
        <Row label="Job checked" value={String(normalized.slotDisplayName)} />
        <Row label="Provider" value={String(normalized.providerDisplayName)} />
        <Row label="Model tested" value={String(normalized.modelTested)} />
        <Row label="Mode" value={String(normalized.modeLabel)} />
        <Row label="Backup used" value={String(normalized.fallbackText)} />
        <Row label="Status" value={String(normalized.statusLabel)} />
      </div>

      {Boolean(normalized.responsePreview) && (
        <div className={`mt-3 border-t pt-3 ${isSuccess ? "border-success-bg/50" : "border-warning-fg/20"}`}>
          <p className="font-semibold mb-1">Model response preview:</p>
          <p className="opacity-90">{normalized.responsePreview}</p>
        </div>
      )}

      {normalized.mode === "mock" && !normalized.fallbackUsed && (
        <p className="mt-3 opacity-90 font-medium">Sample mode was used. Your real model was not tested successfully.</p>
      )}

      {normalized.fallbackUsed && Boolean(normalized.fallbackReason) && (
        <p className="mt-3 opacity-90 text-xs italic">
          Reason backup was used: {String(normalized.fallbackReason)}
        </p>
      )}

      <details className="mt-3 cursor-pointer text-xs opacity-80">
        <summary>Developer diagnostics</summary>
        <div className="mt-2 rounded bg-surface/80 p-2 text-foreground">
          <p>Provider: {String(normalized.providerDisplayName)}</p>
          <p>Model: {String(normalized.modelTested)}</p>
          <p>Mode: {String(normalized.modeLabel)}</p>
          <p>Status: {String(normalized.statusLabel)}</p>
          <p>Backup used: {String(normalized.fallbackText)}</p>
        </div>
      </details>
    </div>
  );
}
