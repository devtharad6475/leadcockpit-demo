/**
 * WhatsApp Agent Settings screen — LLM live test, automation mode + safety
 * toggles, and the provider-safe dry-run panel.
 *
 * Extracted from src/app/page.tsx (chokepoint-rule cleanup, F-5) — pure
 * mechanical move, no behavior change. See src/app/sections/Compliance.tsx
 * for the extraction pattern this file follows.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, EmptyState, Button, Badge, Tabs, TabPanel } from "@/components/ui";
import { Panel, Row } from "@/components/ui/primitives";
import { MessageCircle, AlertCircle, Sparkles, AlertTriangle, Settings } from "lucide-react";
import { api } from "@/lib/api-client";
import { displayLabel, displayAgentMode, displayReplyClassification } from "@/lib/display-labels";
import type { Lead } from "@/lib/types";
import type { Runner } from "@/app/page";
import { BuyerChecklistPanel } from "@/app/sections/BuyerChecklist";
import { AutoReplyTopicsPanel } from "@/app/sections/AutoReplyTopics";
import { workspaceId } from "@/app/page";

const DEFAULT_HOLDING_MESSAGE = "Thanks for your message! I want to give you the exact details, so I'm confirming with our team now. I'll get back to you within 24 hours.";

export function WhatsAppAgentSettingsView({ leads, run }: { leads: Lead[]; run: Runner }) {
  const [activeSection, setActiveSection] = useState("whatsapp-agent-try");
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [mode, setMode] = useState("draft_only");
  // CP-22 — auto-acknowledge toggle + template. Default OFF; the owner enables
  // it to let the system auto-send a generic holding message on sensitive
  // questions (the controlled no-auto-outreach exception, D-2026-08-02-m).
  const [autoAck, setAutoAck] = useState(false);
  const [ackTemplate, setAckTemplate] = useState(DEFAULT_HOLDING_MESSAGE);
  // CP-23 — message batching toggle.
  const [msgBatching, setMsgBatching] = useState(false);
  // D-2026-09-27-b — kinds of question the AI may answer by itself.
  const [autoReplyTopics, setAutoReplyTopics] = useState<string[]>([]);
  // Dry-run legacy
  // LLM live test
  const [llmTestMessage, setLlmTestMessage] = useState("Hi, can you send me the price list and catalogue?");
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [llmTestResult, setLlmTestResult] = useState<Record<string, unknown> | null>(null);
  const [llmTestError, setLlmTestError] = useState<string | null>(null);
  const [fastSlotInfo, setFastSlotInfo] = useState<Record<string, unknown> | null>(null);
  // Cluster 5 P1-10: load-error state.
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    const [loaded, slots] = await Promise.all([
      api<Record<string, unknown>>("/api/whatsapp-agent/settings"),
      api<Array<Record<string, unknown>>>("/api/ai/model-slots"),
    ]);
    setSettings(loaded);
    setMode(String(loaded.mode || "draft_only"));
    setAutoAck(loaded.autoAcknowledgeSensitive === true);
    setMsgBatching(loaded.messageBatchingEnabled === true);
    setAutoReplyTopics(Array.isArray(loaded.autoReplyTopics) ? loaded.autoReplyTopics.map(String) : []);
    if (typeof loaded.acknowledgementTemplate === "string" && loaded.acknowledgementTemplate.trim()) setAckTemplate(loaded.acknowledgementTemplate);
    const fast = slots.find((s) => String(s.slotId) === "fast_customer_reply");
    if (fast) setFastSlotInfo(fast);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load WhatsApp agent settings")); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (loadError) {
    return (
      <Card title="WhatsApp Agent Settings" icon={MessageCircle}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={loadError}
          action={<Button onClick={() => load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load WhatsApp agent settings"))}>Try again</Button>}
        />
      </Card>
    );
  }

  async function runLlmTest() {
    setLlmTestResult(null);
    setLlmTestError(null);
    try {
      const result = await api<Record<string, unknown>>("/api/whatsapp-agent/llm-test", {
        method: "POST",
        body: { workspaceId, customerMessage: llmTestMessage, leadId: selectedLeadId || undefined, forceRealModel: true },
      });
      setLlmTestResult(result);
    } catch (err) {
      setLlmTestError(err instanceof Error ? err.message : "LLM test failed.");
    }
  }

  const fastProvider = fastSlotInfo ? String(fastSlotInfo.provider || "mock") : "mock";
  const fastModel = fastSlotInfo ? String(fastSlotInfo.modelName || "mock-fast") : "mock-fast";
  const isRealProvider = fastProvider !== "mock";
  // 2026-09-04 N-UX-31 — `isRealProvider` alone decided whether this bar said
  // "Live AI", so a workspace pointed at a real provider with NO key on the
  // machine read "API Key: Not configured" in red and "Mode: Live AI" in blue,
  // side by side, one line apart. Both were computed correctly and together
  // they were a contradiction: the run would quietly fall back to samples. The
  // mode now depends on the same two facts the run depends on.
  // N-BUG (2026-09-08) — this counted only a WORKSPACE credential, so a
  // deployment running on the shared platform key (PLATFORM_DEEPSEEK_API_KEY
  // and friends) read "Key: Not configured" and "Mode: Sample answers — no key
  // on this machine" while the panel's own result box, four lines below, said
  // "✅ Live AI responded successfully — Mode: real". One screen contradicting
  // itself about whether a customer-facing agent is live.
  //
  // The server already reports this: getModelSlots sets `hasPlatformKey`, and
  // the dashboard health widget (page.tsx) already checks all three facts —
  // that was the UA-9 fix. This panel duplicated the logic and missed it. Ask
  // the same question the run asks.
  const hasWorkspaceKey = Boolean(fastSlotInfo?.primaryKeyPreview || fastSlotInfo?.credentialId);
  const hasPlatformKey = Boolean(fastSlotInfo?.hasPlatformKey);
  const hasKey = hasWorkspaceKey || hasPlatformKey;
  const willUseLiveAi = isRealProvider && hasKey;
  const apiKeyStatus = fastSlotInfo
    ? (isRealProvider
      ? (fastSlotInfo.primaryKeyPreview
        ? `Configured (${fastSlotInfo.primaryKeyPreview})`
        : hasKey ? "Configured (platform key)" : "Not configured")
      : "Not required for mock")
    : "Checking…";

  const replyRulesDirty = Boolean(settings && (
    mode !== String(settings.mode || "draft_only") ||
    autoAck !== (settings.autoAcknowledgeSensitive === true) ||
    msgBatching !== (settings.messageBatchingEnabled === true) ||
    ackTemplate !== String(settings.acknowledgementTemplate || DEFAULT_HOLDING_MESSAGE) ||
    JSON.stringify(autoReplyTopics) !== JSON.stringify(Array.isArray(settings.autoReplyTopics) ? settings.autoReplyTopics.map(String) : [])
  ));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Customer reply agent</h2>
            <p className="mt-1 text-sm text-muted">Try a reply, choose its rules, or decide what to learn about buyers.</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Saved agent settings">
            <Badge tone="neutral">{settings ? `Saved mode: ${displayAgentMode(String(settings.mode))}` : "Loading reply rules…"}</Badge>
            {settings && <Badge tone={settings.autoAcknowledgeSensitive === true ? "warning" : "neutral"}>
              {settings.autoAcknowledgeSensitive === true ? "Holding messages enabled" : "Holding messages off"}
            </Badge>}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">Tests never send a customer message. Switching sections keeps your edits.</p>
        {replyRulesDirty && <p role="status" className="mt-2 text-sm text-warning-fg">Reply rules have unsaved changes. Save them in Reply rules before leaving this page.</p>}
      </div>
      <Tabs
        tabs={[
          { id: "whatsapp-agent-try", label: "Try a customer message" },
          { id: "whatsapp-agent-rules", label: "Reply rules" },
          { id: "whatsapp-agent-buyer", label: "Buyer information" },
        ]}
        activeTab={activeSection}
        onSelect={setActiveSection}
      />
      <TabPanel tabId="whatsapp-agent-try" hidden={activeSection !== "whatsapp-agent-try"}>
      {/* 2026-09-04 N-UX-32 — this panel spoke in engineering terms to a business
          owner: "LLM", "slot", and the raw field name `doNotContact`. Same
          controls, same behaviour, words a person can act on. */}
      <Panel title="Try the agent before customers do" icon={Sparkles}>
        <div className="space-y-1 mb-4">
          <p className="text-sm font-semibold text-primary-strong">Type a message the way a customer would, and see exactly what the agent would reply.</p>
          <p className="text-xs text-muted">Nothing is sent to anyone. You will see whether the agent would answer on its own, hold the reply for you, or refuse it.</p>
        </div>

        {/* Slot status bar */}
        <div className="mb-4 rounded-lg border border-border-default bg-surface-muted p-3 text-xs space-y-1">
          <div className="flex flex-wrap gap-4">
            <span><span className="font-semibold text-muted-2">Answering with:</span> Quick customer replies</span>
            <span>
              <span className="font-semibold text-muted-2">Provider:</span>{" "}
              <span className={isRealProvider ? "text-primary-strong font-semibold" : "text-warning-fg font-semibold"}>
                {displayLabel(fastProvider)}
              </span>
            </span>
            <span><span className="font-semibold text-muted-2">Model:</span> <span className="font-mono">{fastModel}</span></span>
            <span>
              <span className="font-semibold text-muted-2">Key:</span>{" "}
              <span className={apiKeyStatus.startsWith("Configured") ? "text-primary-strong" : (isRealProvider ? "text-danger-fg font-semibold" : "text-muted")}>
                {apiKeyStatus}
              </span>
            </span>
            <span>
              <span className="font-semibold text-muted-2">Mode:</span>{" "}
              <span className={willUseLiveAi ? "text-primary-strong" : "text-warning-fg"}>{willUseLiveAi ? "Real AI" : isRealProvider ? "Sample answers — no key on this machine" : "Sample answers — no AI connected"}</span>
            </span>
          </div>
          {!isRealProvider && (
            <p className="text-warning-fg font-semibold">Quick customer replies are giving sample answers only. Connect a real AI in AI Settings → Which AI does each job → Quick customer replies.</p>
          )}
        </div>

        <label className="block mb-3">
          <span className="label">Customer message to test</span>
          <textarea
            className="input min-h-28 mt-1"
            value={llmTestMessage}
            onChange={(e) => setLlmTestMessage(e.target.value)}
            placeholder="Enter a WhatsApp message from a customer..."
          />
        </label>

        {leads.length > 0 && (
          <label className="block mb-3">
            <span className="label">Pretend it came from this customer (optional — checks the do-not-contact list)</span>
            <select className="input" value={selectedLeadId} onChange={(e) => setSelectedLeadId(e.target.value)}>
              <option value="">— No lead selected —</option>
              {/* N-DATA-23 (2026-08-27): a lead can genuinely have no company name —
                  discovery finds a site before it finds a business name, and a
                  WhatsApp message can arrive from a number nobody has identified
                  yet. Every other lead render in the app already falls back;
                  this one did not, so such a lead appeared as a blank option the
                  operator could select without knowing what they had picked.
                  Falls through name → contact → number → an honest label. */}
              {leads.map((l) => <option key={l.id} value={l.id}>{l.companyName || l.contactName || l.whatsappNumber || "Unnamed prospect"} {l.companyName && l.whatsappNumber ? `(${l.whatsappNumber})` : ""}</option>)}
            </select>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn"
            onClick={() => run("WhatsApp LLM Live Test", runLlmTest)}
          >
            <Sparkles className="h-4 w-4" /> See what it would reply
          </button>
          <span className="text-xs text-muted italic">No WhatsApp message will be sent.</span>
        </div>

        {/* Test messages quick-select */}
        <div className="mt-3">
          <p className="text-xs font-semibold text-muted mb-1">Quick test messages:</p>
          <div className="flex flex-wrap gap-1">
            {[
              "Hi",
              "Send catalogue",
              "Price kya hai?",
              "Delivery tomorrow possible?",
              "Return policy kya hai?",
              "Stop, don't contact me",
              "You people are useless",
              "What is your MOQ for export orders to UAE?",
            ].map((msg) => (
              <button
                key={msg}
                className="text-xs rounded border border-border-default bg-surface px-2 py-0.5 hover:bg-surface-muted transition"
                onClick={() => setLlmTestMessage(msg)}
              >
                {msg}
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {llmTestError && (
          <div className="mt-4 rounded-lg border border-danger-bg bg-danger-bg p-4 text-sm text-danger-fg">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle className="h-5 w-5" /> ❌ WhatsApp LLM Test Failed</div>
            <p className="mt-2">{llmTestError}</p>
            <p className="mt-1 text-xs opacity-80">Check that your Fast Customer Reply provider is configured in AI Settings.</p>
          </div>
        )}

        {/* Result */}
        {llmTestResult && <WhatsAppLLMTestResult result={llmTestResult} />}
      </Panel>

      </TabPanel>
      <TabPanel tabId="whatsapp-agent-rules" hidden={activeSection !== "whatsapp-agent-rules"}>
      {/* Settings panel */}
      <Panel title="WhatsApp agent safety settings" icon={MessageCircle}>
        <p className="text-sm text-muted-2">Control how the AI handles WhatsApp replies. Tests never send; approved replies can use WhatsApp Cloud only after Meta credentials are configured.</p>
        {/* 2026-08-05 F-P2-1: was showing only 2 of 5 valid modes + remapping
            safe_auto_reply→automatic (display/save desync). Now exposes all 5
            modes the schema + service accept, so the saved value always matches
            what the dropdown shows. */}
        <label className="mt-4 block"><span className="label">Automation mode</span><select className="input" value={mode} onChange={(event) => setMode(event.target.value)}><option value="off">Off — no automated reply handling</option><option value="draft_only">Draft only — the AI prepares the reply, you send it</option><option value="human_approval">Human approval — every reply needs your OK before sending</option><option value="safe_auto_reply">Automatic replies — the AI answers the kinds ticked below by itself, you approve the rest</option><option value="automatic">Automatic (same as above) — only the kinds ticked below, only when WhatsApp is connected</option></select></label>
        {/* CP-22 (2026-08-02) — auto-acknowledge toggle + template editor. The
            ONE controlled exception to no-auto-outreach. When ON, a generic
            owner-written holding message is auto-sent on sensitive questions,
            then the owner is asked for the real answer. Default OFF. */}
        <div className="mt-4 rounded-md border border-border-default bg-surface-muted p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={autoAck} onChange={(e) => setAutoAck(e.target.checked)} />
            Auto-acknowledge sensitive questions
          </label>
          <p className="mt-1 text-xs text-muted">When a customer asks about price, delivery, or MOQ, instantly send the holding message below (so they aren&apos;t left waiting), then ask YOU for the real answer. The real reply still needs your approval. Default OFF.</p>
          {autoAck ? (
            <textarea className="input mt-2 text-sm" value={ackTemplate} onChange={(e) => setAckTemplate(e.target.value)} rows={2} aria-label="Holding message template" />
          ) : null}
        </div>
        <AutoReplyTopicsPanel topics={autoReplyTopics} onChange={setAutoReplyTopics} automaticMode={mode === "safe_auto_reply" || mode === "automatic"} />
        {/* CP-23 (2026-08-02) — message batching toggle. When ON, rapid-fire
            messages from the same customer are merged into one before the AI
            processes them, so the AI sees full context. Default OFF. */}
        <div className="mt-3 rounded-md border border-border-default bg-surface-muted p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={msgBatching} onChange={(e) => setMsgBatching(e.target.checked)} />
            Merge rapid-fire messages (60s conversation window)
          </label>
          <p className="mt-1 text-xs text-muted">When a customer sends multiple quick messages (like &quot;Hi&quot; / &quot;Price&quot; / &quot;500m&quot; / &quot;Urgent&quot;), the system waits 60 seconds, merges them into one, then processes — so the AI sees the full request instead of fragments. Default OFF.</p>
        </div>
        <button className="btn mt-3" onClick={() => run("Save WhatsApp settings", async () => { await api("/api/whatsapp-agent/settings", { method: "PUT", body: { workspaceId, enabled: true, mode, defaultLanguage: "English", autoAcknowledgeSensitive: autoAck, acknowledgementTemplate: ackTemplate, messageBatchingEnabled: msgBatching, autoReplyTopics } }); await load(); })}><Settings className="h-4 w-4" /> Save settings</button>
        {/* 2026-08-05 audit fix (F-UI-24): raw snake_case mode (draft_only,
            safe_auto_reply) leaked to the operator. Routed through the
            displayAgentMode label map that exists for exactly this. */}
        {settings ? <Row label="Current mode" value={displayAgentMode(String(settings.mode))} /> : null}
      </Panel>

      </TabPanel>
      <TabPanel tabId="whatsapp-agent-buyer" hidden={activeSection !== "whatsapp-agent-buyer"}>
      {/* N12 (2026-09-23) — what the owner wants to learn about buyers. */}
      <BuyerChecklistPanel run={run} />
      </TabPanel>

      {/* 2026-09-25 — the second test box ("dry-run") is gone from here. It
          repeated the test at the top of this screen, and it saved every test
          as if a real customer had written (see
          golden-whatsapp-test-saves-nothing). The full-path check still lives
          in the Replies inbox as "Simulate", and now saves nothing. */}
    </div>
  );
}

function WhatsAppLLMTestResult({ result }: { result: Record<string, unknown> }) {
  const data = (result.data as Record<string, unknown>) || {};
  const resultStatus = String(result.resultStatus || "unknown");
  const isRealSuccess = resultStatus === "real_success";
  const isMockOrFallback = resultStatus === "mock_or_fallback";
  const mode = String(data.mode || "unknown");
  const fallbackUsed = Boolean(data.fallbackUsed);

  const cardClass = isRealSuccess
    ? "border-success-bg bg-success-bg text-success-fg"
    : isMockOrFallback
    ? "border-warning-bg bg-warning-bg text-warning-fg"
    : "border-danger-bg bg-danger-bg text-danger-fg";

  const icon = isRealSuccess ? "✅" : isMockOrFallback ? "⚠️" : "❌";
  const headline = isRealSuccess
    ? "Live AI responded successfully."
    : isMockOrFallback
    ? "Sample or backup mode was used. Live AI was NOT confirmed."
    : "WhatsApp LLM test failed.";

  const classification = displayReplyClassification(String(data.classification || "unknown"));
  const riskLevel = String(data.riskLevel || "unknown");
  const riskColor = riskLevel === "low" ? "text-success-fg" : riskLevel === "medium" ? "text-warning-fg" : "text-danger-fg";

  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className={`mt-4 rounded-lg border p-4 text-sm ${cardClass}`}>
      {/* Header */}
      <div className="flex items-center gap-2 font-bold text-base mb-1">
        {icon} {headline}
      </div>
      <p className="text-xs opacity-80 mb-3 font-medium">This test did not send any WhatsApp message.</p>

      {/* Provider & model */}
      <div className={`grid gap-1 border-t pt-3 mb-3 border-current/20`}>
        <Row label="Provider" value={String(data.providerDisplayName || data.provider || "Unknown")} />
        <Row label="Model" value={String(data.effectiveModelName || data.modelName || "Unknown")} />
        <Row label="Mode" value={`${mode}${fallbackUsed ? " (fallback used)" : ""}`} />
        <Row label="Slot" value="Fast Customer Reply Model" />
        <Row label="Latency" value={`${data.latencyMs || 0}ms`} />
      </div>

      {/* Classification & decision */}
      <div className={`grid gap-1 border-t pt-3 mb-3 border-current/20`}>
        <div className="flex flex-wrap gap-2 items-center mb-1">
          <span className="font-semibold">Classification:</span>
          <span className="rounded-full bg-white/50 px-2 py-0.5 font-bold capitalize">{classification}</span>
          <span className={`rounded-full bg-white/50 px-2 py-0.5 font-bold ${riskColor}`}>{riskLevel} risk</span>
        </div>
        <Row label="Confidence" value={`${Math.round(Number(data.confidenceScore || 0) * 100)}%`} />
        <Row label="Human review required" value={data.needsHumanReview ? "✅ Yes — do not auto-send" : "No"} />
        <Row label="Can auto-send" value={data.canAutoSend ? "Yes" : "No — held for review"} />
        <Row label="Blocked" value={data.blocked ? "Yes" : "No"} />
        {Boolean(data.policyNote) && <Row label="Policy decision" value={String(data.policyNote)} />}
        <Row label="Reason" value={String(data.reason || "—")} />
        <Row label="Lead status suggestion" value={displayLabel(String(data.leadStatusSuggestion || "—"))} />
      </div>

      {/* Suggested reply */}
      {Boolean(data.suggestedReply) && (
        <div className={`border-t pt-3 mb-3 border-current/20`}>
          <p className="font-semibold mb-1">Suggested reply:</p>
          <p className="whitespace-pre-wrap rounded-lg bg-white/60 p-3 font-medium leading-relaxed">{String(data.suggestedReply)}</p>
        </div>
      )}

      {/* Knowledge */}
      <div className={`border-t pt-3 mb-3 border-current/20`}>
        <Row label="Knowledge chunks used" value={`${data.knowledgeChunksUsed || 0} relevant items`} />
        {Boolean(data.knowledgeChunksUsed === 0) && (
          <p className="text-xs mt-1 opacity-90 font-semibold">No matching knowledge found. Make sure your Knowledge Base is populated.</p>
        )}
        {Boolean(data.missingKnowledge) && (
          <div className="mt-1">
            <span className="font-semibold">Missing knowledge:</span> {String(data.missingQuestion || "Unknown question")}
          </div>
        )}
        {Boolean(data.unknownQuestionCreated) && (
          <p className="mt-1 font-semibold">Question card created — check the Questions from AI tab.</p>
        )}
      </div>

      {/* Log IDs */}
      <div className={`border-t pt-3 border-current/20`}>
        {Boolean(data.autoReplyLogId) && <Row label="AutoReply log ID" value={String(data.autoReplyLogId)} />}
        {Boolean(data.agentRunId) && <Row label="Agent run ID" value={String(data.agentRunId)} />}
      </div>

      {/* Advanced details */}
      <details className="mt-3 cursor-pointer text-xs opacity-80" open={showAdvanced}>
        <summary onClick={() => setShowAdvanced(!showAdvanced)}>Advanced details (collapsed)</summary>
        <div className="mt-2 space-y-1">
          <Row label="Raw provider" value={String(data.provider || "—")} />
          <Row label="Raw model" value={String(data.modelName || "—")} />
          <Row label="Backup used" value={String(data.fallbackUsed)} />
          <Row label="Route status" value={String(data.status || "—")} />
          <Row label="Knowledge confidence" value={`${Math.round(Number(data.knowledgeConfidenceScore || 0) * 100)}%`} />
        </div>
      </details>
    </div>
  );
}

