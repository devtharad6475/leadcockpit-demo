/**
 * Questions from AI screen — grouped business-detail cards created from
 * unanswered internal framework questions, plus the WhatsApp agent's direct
 * enquiries to the owner.
 *
 * Extracted from src/app/page.tsx (chokepoint-rule cleanup, F-5) — pure
 * mechanical move, no behavior change. See src/app/sections/Compliance.tsx
 * for the extraction pattern this file follows.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, EmptyState, Button, Badge, Spinner } from "@/components/ui";
import { Panel, Field } from "@/components/ui/primitives";
import { AlertTriangle, AlertCircle, Gavel, Package, Trash2, MessageCircle, Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { knowledgeAreaName } from "@/lib/knowledge-area-names";
import { displayLabel, displayPriority } from "@/lib/display-labels";
import type { Lead, ProductSetting, ProductSettings, SalesSettings, PolicySettings, CommunicationSettings, PendingSettingsDraft } from "@/lib/types";
import type { Runner, TabId, KnowledgeDocument } from "@/app/page";
import { Grid, workspaceId } from "@/app/page";
import { TextAreaField, mergeProducts } from "@/app/sections/StructuredSettings";

type UnknownQuestionItem = { id: string; questionText: string; channel: string; status: string; suggestedAnswer?: string; finalAnswer?: string; leadId?: string; conversationId?: string; missingTopic?: string; generatedBy?: string; relatedDomain?: string; relatedQuestionKey?: string; priority?: "high" | "medium" | "low"; createdAt: string };
type MissingBusinessDetailGroup = {
  groupKey: string;
  title: string;
  description: string;
  domainKey?: string;
  topic: string;
  priority: "high" | "medium" | "low";
  status: "open" | "resolved" | "skipped" | "mixed";
  questionsCount: number;
  questionIds: string[];
  relatedQuestionKeys: string[];
  generatedByTypes: string[];
  exampleQuestions: string[];
  suggestedAnswer?: string;
};
type EssentialSetupStage = { groups: MissingBusinessDetailGroup[]; essentialOpenCount: number; essentialTotalCount: number; remainingOpenCount: number };
type MissingGroupsResponse = { groups: MissingBusinessDetailGroup[]; rawOpenCount: number; essential: EssentialSetupStage };
type UnknownAnswerResponse = { status?: string; message?: string; knowledgeAnswer?: { id: string; answerStatus: string; answer?: string }; answeredQuestions?: number; mappedAnswers?: number; chunks?: number };
type ProductDraftResponse = { products: ProductSetting[]; warnings: string[] };
type StructuredSettingsDraftField = { area: "sales" | "policy" | "communication"; fieldKey: string; label: string; inputType?: "text" | "textarea" | "list"; value: string | string[] };
type StructuredSettingsDraftResponse = {
  sales: Partial<SalesSettings>;
  policy: Partial<PolicySettings>;
  communication: Partial<CommunicationSettings>;
  fields: StructuredSettingsDraftField[];
  warnings: string[];
};
type PendingSettingsDraftItem = PendingSettingsDraft & {
  fields?: StructuredSettingsDraftField[];
};

function isProductSettingsCandidate(group: MissingBusinessDetailGroup) {
  if (group.topic !== "product") return false;
  const text = [
    group.title,
    group.description,
    group.domainKey || "",
    group.relatedQuestionKeys.join(" "),
    group.exampleQuestions.join(" "),
  ].join(" ").toLowerCase();
  return /(product|sku|material|pack|moq|dispatch|stock|customi[sz]ation|variant|application|use case)/.test(text);
}

function inferSettingsDraftDomainKey(group: MissingBusinessDetailGroup) {
  const text = [group.title, group.description, group.topic, group.exampleQuestions.join(" ")].join(" ").toLowerCase();
  if (/whatsapp|reply|tone|auto[- ]?reply|unknown answer/.test(text)) return "whatsapp_communication";
  if (/return|replacement|refund|complaint|cancellation/.test(text)) return "returns_replacement";
  if (/shipping|delivery|dispatch/.test(text)) return "shipping_delivery";
  if (/payment|credit|advance|quotation|gst/.test(text)) return "payment_credit_terms";
  if (/price|pricing|discount|negotiation/.test(text)) return "pricing_policy";
  if (/sample|catalogue|catalog|bulk order/.test(text)) return "samples_catalogue_quotation_rules";
  if (/lead|qualification|mql|sql|human review/.test(text)) return "lead_qualification";
  if (/custom/.test(text)) return "customization";
  return group.domainKey;
}

function settingsAreaLabel(area: "sales" | "policy" | "communication") {
  if (area === "sales") return "Sales Settings";
  if (area === "policy") return "Policy Settings";
  return "Communication Settings";
}

function whyThisHelps(topic: string) {
  const map: Record<string, string> = {
    product: "This helps the AI answer product enquiries, recommend the right item, and quote accurately.",
    payment: "This helps the AI explain payment terms, credit rules, and advance requirements to buyers.",
    shipping: "This helps the AI give clear delivery expectations and handle return requests.",
    whatsapp: "This helps the AI stay on-brand, know when to escalate, and reply safely.",
    lead: "This helps the AI qualify leads, spot hot buyers, and route enquiries to your team.",
    policy: "This helps the AI explain rules consistently and avoid giving wrong commitments.",
    strategy: "This helps the AI plan outreach and choose the right message for each buyer type.",
    profile: "This helps the AI introduce your business correctly and build trust with prospects.",
    general: "This helps the AI give more accurate and confident answers to customer questions.",
  };
  return map[topic] || map.general;
}

export function QuestionsFromAI({ run, loadKnowledge, setActive, leads }: { run: Runner; documents: KnowledgeDocument[]; loadKnowledge: () => Promise<void>; setActive: (tab: TabId) => void; leads: Lead[] }) {
  const [items, setItems] = useState<UnknownQuestionItem[]>([]);
  const [groups, setGroups] = useState<MissingBusinessDetailGroup[]>([]);
  // Only the setter is used: the running total is kept up to date, but the
  // badge that displayed it ("N knowledge items open") was removed in N-UX-10
  // as one of four mutually inconsistent totals on one screen.
  const [, setRawOpenCount] = useState(0);
  // Q-7: the backlog now has two stages. "start" is the ~12 core-domain areas
  // covering the questions the AI is actually blocked on; "everything" is the
  // full backlog that used to be the only thing an owner ever saw.
  const [essential, setEssential] = useState<EssentialSetupStage>({ groups: [], essentialOpenCount: 0, essentialTotalCount: 0, remainingOpenCount: 0 });
  const [stage, setStage] = useState<"start" | "everything">("start");
  const [stageChosenByUser, setStageChosenByUser] = useState(false);
  const [index, setIndex] = useState(0);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({});
  const [showAllPendingDrafts, setShowAllPendingDrafts] = useState(false);
  const [readyReply, setReadyReply] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [syncNeeded, setSyncNeeded] = useState(false);
  const [productReviewDrafts, setProductReviewDrafts] = useState<ProductSetting[]>([]);
  const [productReviewMessage, setProductReviewMessage] = useState("");
  const [settingsReviewDraft, setSettingsReviewDraft] = useState<StructuredSettingsDraftResponse | null>(null);
  const [settingsReviewMessage, setSettingsReviewMessage] = useState("");
  const [pendingSettingsDrafts, setPendingSettingsDrafts] = useState<PendingSettingsDraftItem[]>([]);
  // Cluster 5 P1-10: load-error state.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Session 55: whether data has ever arrived. Without this the screen renders
  // its zero-state — "Every business area is answered · 0 of 0 done" — from the
  // empty initial state, before the first fetch has returned. Observed live
  // while the container was 502ing: the operator was told the work was finished
  // when in fact nothing had loaded, and a retry then said "5 business areas
  // still need your answer · 7 of 12 done". A completion claim must never be
  // the default rendering of "we do not know yet".
  const [loaded, setLoaded] = useState(false);
  const [activePendingDraftId, setActivePendingDraftId] = useState("");
  const [localResolvedGroupKeys, setLocalResolvedGroupKeys] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState("high");
  const [domainFilter, setDomainFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [topicFilter, setTopicFilter] = useState("all");

  async function load() {
    const [unknownItems, grouped, pendingDrafts] = await Promise.all([
      api<UnknownQuestionItem[]>("/api/unknown-questions"),
      api<MissingGroupsResponse>("/api/unknown-questions/groups"),
      api<PendingSettingsDraftItem[]>("/api/settings/pending-drafts"),
    ]);
    setItems(unknownItems);
    setGroups(grouped.groups);
    setRawOpenCount(grouped.rawOpenCount);
    setEssential(grouped.essential);
    setPendingSettingsDrafts(pendingDrafts);
    // Only steer the owner on the first load. Once they have picked a stage
    // themselves, a background refresh must not drag them back.
    if (!stageChosenByUser) setStage(grouped.essential.essentialOpenCount > 0 ? "start" : "everything");
    // Last, and only on the success path: everything above has landed, so the
    // counts on screen are now describing real data rather than initial state.
    setLoaded(true);
  }
  function markGroupResolvedLocally(group: MissingBusinessDetailGroup, answeredQuestions: number) {
    setLocalResolvedGroupKeys((currentKeys) => {
      if (currentKeys.has(group.groupKey)) return currentKeys;
      const nextKeys = new Set(currentKeys);
      nextKeys.add(group.groupKey);
      return nextKeys;
    });
    setItems((currentItems) => currentItems.map((item) => group.questionIds.includes(item.id) ? { ...item, status: "added_to_knowledge" } : item));
    setGroups((currentGroups) => currentGroups.map((item) => item.groupKey === group.groupKey ? { ...item, status: "resolved" } : item));
    // The same UnknownQuestion ids appear in both stages, so a card answered in
    // one stage has to stop looking open in the other.
    const answeredIds = new Set(group.questionIds);
    const stillOpen = (item: MissingBusinessDetailGroup) => item.questionIds.some((id) => !answeredIds.has(id));
    setEssential((current) => ({
      ...current,
      groups: current.groups.map((item) => (item.groupKey === group.groupKey || !stillOpen(item)) && item.questionIds.some((id) => answeredIds.has(id)) ? { ...item, status: "resolved" } : item),
      essentialOpenCount: Math.max(0, current.essentialOpenCount - current.groups.filter((item) => item.groupKey === group.groupKey).reduce((sum, item) => sum + item.questionIds.filter((id) => answeredIds.has(id)).length, 0)),
    }));
    setRawOpenCount((currentCount) => Math.max(0, currentCount - answeredQuestions));
  }
  async function prepareProductSettingsReview(group: MissingBusinessDetailGroup, ownerAnswer: string) {
    if (!isProductSettingsCandidate(group)) {
      setProductReviewDrafts([]);
      setProductReviewMessage("");
      return;
    }
    const draft = await api<ProductDraftResponse>("/api/settings/products/draft", { method: "POST", body: { workspaceId, notes: ownerAnswer } });
    if (!draft.products.length) {
      setProductReviewDrafts([]);
      setProductReviewMessage(draft.warnings[0] || "Product settings were not drafted from this answer. The answer is still saved in Knowledge Base and the internal framework.");
      return;
    }
    setProductReviewDrafts(draft.products);
    setProductReviewMessage(`Created ${draft.products.length} editable Product Settings draft${draft.products.length === 1 ? "" : "s"} from this answer. Review and save only if these rows are correct.`);
    const pendingDraft = await api<PendingSettingsDraftItem>("/api/settings/pending-drafts", { method: "POST", body: { workspaceId, kind: "product", sourceGroupKey: group.groupKey, sourceTitle: group.title, sourceTopic: group.topic, sourceAnswer: ownerAnswer, products: draft.products } });
    setActivePendingDraftId(pendingDraft.id);
    setPendingSettingsDrafts((drafts) => [pendingDraft, ...drafts.filter((item) => item.id !== pendingDraft.id)]);
  }
  async function prepareStructuredSettingsReview(group: MissingBusinessDetailGroup, ownerAnswer: string) {
    if (isProductSettingsCandidate(group)) {
      setSettingsReviewDraft(null);
      setSettingsReviewMessage("");
      return;
    }
    const draftDomainKey = group.domainKey || inferSettingsDraftDomainKey(group);
    const draft = await api<StructuredSettingsDraftResponse>("/api/settings/draft-from-answer", { method: "POST", body: { workspaceId, domainKey: draftDomainKey, relatedQuestionKeys: group.relatedQuestionKeys, answer: ownerAnswer } });
    if (!draft.fields.length) {
      setSettingsReviewDraft(null);
      setSettingsReviewMessage(draft.warnings[0] || "");
      return;
    }
    setSettingsReviewDraft(draft);
    const areaLabels = Array.from(new Set(draft.fields.map((field) => settingsAreaLabel(field.area)))).join(", ");
    setSettingsReviewMessage(`Created ${draft.fields.length} editable ${areaLabels} draft field${draft.fields.length === 1 ? "" : "s"} from this answer. Review and save only if correct.`);
    const pendingDraft = await api<PendingSettingsDraftItem>("/api/settings/pending-drafts", { method: "POST", body: { workspaceId, kind: "structured", sourceGroupKey: group.groupKey, sourceTitle: group.title, sourceTopic: group.topic, sourceAnswer: ownerAnswer, sales: draft.sales, policy: draft.policy, communication: draft.communication, fields: draft.fields } });
    setActivePendingDraftId(pendingDraft.id);
    setPendingSettingsDrafts((drafts) => [pendingDraft, ...drafts.filter((item) => item.id !== pendingDraft.id)]);
  }
  function updateProductReviewDraft(index: number, field: keyof ProductSetting, value: unknown) {
    setProductReviewDrafts((drafts) => {
      const next = [...drafts];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }
  function removeProductReviewDraft(index: number) {
    setProductReviewDrafts((drafts) => drafts.filter((_, itemIndex) => itemIndex !== index));
  }
  async function saveProductReviewDrafts() {
    if (!productReviewDrafts.length) {
      setProductReviewMessage("No product drafts are ready to save.");
      return;
    }
    // This save replaces the list: a failed read must never become an empty
    // catalogue. Keep the reviewed draft until a complete read and save succeed.
    const current = await api<ProductSettings>("/api/settings/products").catch(() => {
      throw new Error("Could not read your saved products. Nothing was changed. Your reviewed draft is still here; try again.");
    });
    if (!Array.isArray(current?.products)) {
      throw new Error("Could not read your saved products. Nothing was changed. Your reviewed draft is still here; try again.");
    }
    const merged = mergeProducts(current.products, productReviewDrafts);
    await api("/api/settings/products", { method: "PUT", body: { workspaceId, products: merged } });
    if (activePendingDraftId) await api(`/api/settings/pending-drafts/${activePendingDraftId}/saved`, { method: "POST", body: { workspaceId } }).catch(() => undefined);
    setProductReviewDrafts([]);
    setActivePendingDraftId("");
    setPendingSettingsDrafts((drafts) => drafts.filter((draft) => draft.id !== activePendingDraftId));
    setProductReviewMessage(`Saved ${merged.length} reviewed product row${merged.length === 1 ? "" : "s"} to Product Settings. Run Sync Knowledge so agents use the structured product facts.`);
    setSyncNeeded(true);
  }
  function updateSettingsReviewDraft(field: StructuredSettingsDraftField, value: string) {
    setSettingsReviewDraft((current) => {
      if (!current) return current;
      const parsedValue = field.inputType === "list" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value;
      return {
        ...current,
        [field.area]: { ...(current[field.area] as Record<string, unknown>), [field.fieldKey]: parsedValue },
        fields: current.fields.map((item) => item.area === field.area && item.fieldKey === field.fieldKey ? { ...item, value: parsedValue } : item),
      };
    });
  }
  async function saveSettingsReviewDrafts() {
    if (!settingsReviewDraft?.fields.length) {
      setSettingsReviewMessage("No structured settings drafts are ready to save.");
      return;
    }
    if (Object.keys(settingsReviewDraft.sales).length) {
      const current = await api<Partial<SalesSettings>>("/api/settings/sales").catch(() => ({}));
      await api("/api/settings/sales", { method: "PUT", body: { ...current, ...settingsReviewDraft.sales, workspaceId } });
    }
    if (Object.keys(settingsReviewDraft.policy).length) {
      const current = await api<Partial<PolicySettings>>("/api/settings/policy").catch(() => ({}));
      await api("/api/settings/policy", { method: "PUT", body: { ...current, ...settingsReviewDraft.policy, workspaceId } });
    }
    if (Object.keys(settingsReviewDraft.communication).length) {
      const current = await api<Partial<CommunicationSettings>>("/api/settings/communication").catch(() => ({}));
      await api("/api/settings/communication", { method: "PUT", body: { ...current, ...settingsReviewDraft.communication, workspaceId } });
    }
    const count = settingsReviewDraft.fields.length;
    if (activePendingDraftId) await api(`/api/settings/pending-drafts/${activePendingDraftId}/saved`, { method: "POST", body: { workspaceId } }).catch(() => undefined);
    setSettingsReviewDraft(null);
    setActivePendingDraftId("");
    setPendingSettingsDrafts((drafts) => drafts.filter((draft) => draft.id !== activePendingDraftId));
    setSettingsReviewMessage(`Saved ${count} reviewed structured setting field${count === 1 ? "" : "s"}. Run Sync Knowledge so agents use the reviewed settings.`);
    setSyncNeeded(true);
  }
  function openPendingSettingsDraft(draft: PendingSettingsDraftItem) {
    setActivePendingDraftId(draft.id);
    if (draft.kind === "product") {
      setProductReviewDrafts(draft.products || []);
      setProductReviewMessage(`Review pending Product Settings draft from ${draft.sourceTitle || "Information Needed"}. Save only if these rows are correct.`);
      setSettingsReviewDraft(null);
      setSettingsReviewMessage("");
    } else {
      setSettingsReviewDraft({ sales: draft.sales || {}, policy: draft.policy || {}, communication: draft.communication || {}, fields: draft.fields || [], warnings: [] });
      setSettingsReviewMessage(`Review pending structured settings draft from ${draft.sourceTitle || "Information Needed"}. Save only if these fields are correct.`);
      setProductReviewDrafts([]);
      setProductReviewMessage("");
    }
  }
  async function discardPendingSettingsDraftItem(draftId: string) {
    await api(`/api/settings/pending-drafts/${draftId}/discard`, { method: "POST", body: { workspaceId } });
    if (activePendingDraftId === draftId) {
      setActivePendingDraftId("");
      setProductReviewDrafts([]);
      setProductReviewMessage("");
      setSettingsReviewDraft(null);
      setSettingsReviewMessage("");
    }
    setPendingSettingsDrafts((drafts) => drafts.filter((draft) => draft.id !== draftId));
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadKnowledge().catch(() => undefined);
      // 2026-08-05 multi-agent audit P0-1: was `.catch(() => undefined)` which
      // swallowed load failures — a dead API looked like "nothing to review"
      // (the built loadError EmptyState was unreachable). Now surfaces the error.
      load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load information needed"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadKnowledge]);

  const openItems = items.filter((item) => item.status === "open");
  const whatsappQuestions = openItems.filter((item) => item.channel === "whatsapp");

  const allCompanyQuestions = items.filter((item) => item.channel === "knowledge" && (statusFilter === "all" || item.status === statusFilter));
  const domains = Array.from(new Set(allCompanyQuestions.map((item) => item.relatedDomain || item.missingTopic || "general"))).sort();
  const stageGroups = stage === "start" ? essential.groups : groups;
  const progressGroups = stageGroups.map((group) => localResolvedGroupKeys.has(group.groupKey) ? { ...group, status: "resolved" as const } : group);
  const visibleGroups = progressGroups
    .filter((group) => statusFilter === "all" || (statusFilter === "open" ? group.status === "open" || group.status === "mixed" : group.status === statusFilter || (statusFilter === "added_to_knowledge" && group.status === "resolved") || (statusFilter === "ignored" && group.status === "skipped")))
    // In the start-here stage the twelve areas are the whole point, so the
    // topic/priority/source filters are bypassed rather than silently hiding
    // some of them. They come back in the everything stage.
    .filter((group) => stage === "start" || priorityFilter === "all" || (priorityFilter === "critical" ? group.priority === "high" || ["product", "payment", "shipping", "whatsapp", "lead"].includes(group.topic) : group.priority === priorityFilter))
    .filter((group) => stage === "start" || domainFilter === "all" || group.domainKey === domainFilter || group.title.toLowerCase().includes(domainFilter.replaceAll("_", " ")))
    .filter((group) => stage === "start" || sourceFilter === "all" || group.generatedByTypes.includes(sourceFilter))
    .filter((group) => stage === "start" || topicFilter === "all" || group.topic === topicFilter || (topicFilter === "shipping" && group.topic === "shipping"));
  // A-12 (2026-08-25): there used to be a .sort() here, and it was not a valid
  // ordering. It read
  //   (a.priority === "high" ? -1 : b.priority === "high" ? 1 : b.questionsCount - a.questionsCount)
  // which answers "a first" for (a,b) AND "b first" for (b,a) whenever both are
  // high priority. EVERY start-here card is high priority, so it returned -1 for
  // every pair and V8 handed back the list REVERSED: a brand-new owner opened on
  // "Analytics & Learning" (1 question) while "Brand Identity" and
  // "Products & Services" sat at the end of a 12-card walk. Measured on a fresh
  // tenant: 132 pairs where the comparator contradicted itself, and the result
  // changed when the same 12 cards arrived in a different order.
  // It is deleted rather than repaired because the server already orders both
  // lists deliberately and better: the start-here stage follows the curated
  // KNOWLEDGE_CORE_DOMAINS onboarding sequence, and the backlog is sorted by
  // priority then size in groupMissingBusinessDetails(). Filtering preserves
  // order, so what the screen walks is what the server sent. One ordering
  // policy, in one place. Pinned by scripts/golden/golden-setup-card-order.ts
  // and by scripts/probes/essential-stage-ui.ts in a real browser.
  const openGroupCount = progressGroups.filter((group) => group.status === "open" || group.status === "mixed").length;
  const resolvedGroupCount = progressGroups.filter((group) => group.status === "resolved").length;
  const overallProgressPercent = Math.round((resolvedGroupCount / Math.max(progressGroups.length, 1)) * 100);
  const recentlyResolvedGroups = progressGroups.filter((group) => group.status === "resolved").slice(0, 3);
  const effectiveIndex = index >= visibleGroups.length ? 0 : index;
  const currentGroup = visibleGroups[effectiveIndex];
  const currentWhatsapp = whatsappQuestions[0];
  const answer = currentGroup ? answerDrafts[currentGroup.groupKey] || "" : "";
  const setAnswer = (value: string) => {
    if (currentGroup) setAnswerDrafts(drafts => ({ ...drafts, [currentGroup.groupKey]: value }));
  };
  const conversationAnswer = currentWhatsapp ? conversationDrafts[currentWhatsapp.id] ?? currentWhatsapp.suggestedAnswer ?? "Please share the catalogue requirement, quantity, and design details. Our team will confirm the exact answer." : "";
  const setConversationAnswer = (value: string) => {
    if (currentWhatsapp) setConversationDrafts(drafts => ({ ...drafts, [currentWhatsapp.id]: value }));
  };
  const learningQueue = visibleGroups;

  // Session 55: until the first load lands there is nothing true to say about
  // how much is answered, so say that rather than rendering the zero-state.
  if (!loaded && !loadError) {
    return (
      <Card title="Questions from AI" icon={AlertTriangle}>
        <div className="flex items-center justify-center gap-2 py-8 text-muted">
          <Spinner />
          <span className="text-sm">Loading what the AI still needs...</span>
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card title="Questions from AI" icon={AlertTriangle}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={loadError}
          action={<Button onClick={() => {
            setLoadError(null);
            load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load information needed"));
          }}>Try again</Button>}
        />
      </Card>
    );
  }

  return (
    <Grid>
      {/* N-UX-10 (2026-09-03) — the waiting customer comes FIRST, and only
          appears when there is one.

          Before this, a live customer question ("Can you confirm exact price
          for 500 meters?") and a setup form sat side by side in two identical
          panels, so the screen never said which mattered more. One is a person
          expecting a price; the other is homework with no deadline.

          When nobody is waiting the panel is not rendered at all rather than
          rendered empty: an empty panel still costs a heading, a border and a
          share of the operator's attention to establish that it is empty. The
          reassurance that there is nothing waiting moves to a quiet line at the
          bottom, where reassurance belongs. */}
      {currentWhatsapp ? (
      <div className="xl:col-span-2">
      <Panel title={whatsappQuestions.length > 1 ? `${whatsappQuestions.length} customers are waiting for an answer` : "A customer is waiting for an answer"} icon={MessageCircle} tone="urgent">
        <p className="text-sm text-muted-2">Answer here and the reply is prepared for that customer. Nothing is sent to them automatically.</p>
        {currentWhatsapp ? (
          <div className="mt-4 rounded-md border border-border-default bg-surface p-3">
            {/* 2026-08-05 UX audit (P2-1): only the FIRST unanswered WhatsApp
                question rendered, silently stranding the rest. Show the queue
                depth so the operator knows how many customers are waiting. */}
            {whatsappQuestions.length > 1 && (
              <p className="mb-2 text-xs text-muted-2">Answering below saves the first one; the rest appear after it is saved.</p>
            )}
            <p className="text-lg font-semibold leading-snug text-foreground">{currentWhatsapp.questionText}</p>
            {/* U-4 fix (batch 3): was raw UUID text ("Lead: abc-123 / Conversation:
                xyz-789") — hostile to a non-technical host. Now resolves leadId →
                company name from the leads list (same pattern as the Replies panel),
                makes it clickable to jump to the Leads tab, and drops the internal
                conversation UUID entirely (no business value to the operator). */}
            {(() => {
              const matched = currentWhatsapp.leadId ? leads.find((l) => l.id === currentWhatsapp.leadId) : undefined;
              if (matched) {
                return (
                  <p className="mt-1 text-sm text-muted">
                    Customer:{" "}
                    <button type="button" className="font-semibold text-primary underline underline-offset-2 hover:text-primary-strong" onClick={() => setActive("crm")}>
                      {matched.companyName || "Unnamed lead"}
                    </button>
                  </p>
                );
              }
              return <p className="mt-1 text-sm text-muted">Customer: not matched yet (inbound or dry-run message)</p>;
            })()}
            <label className="mt-4 block"><span className="label">Your answer to the agent</span><textarea className="input min-h-24" value={conversationAnswer} onChange={(event) => setConversationAnswer(event.target.value)} /></label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn" onClick={() => run("Save WhatsApp answer", async () => {
                await api(`/api/unknown-questions/${currentWhatsapp.id}/answer`, { method: "POST", body: { workspaceId, finalAnswer: conversationAnswer, addToKnowledge: true } });
                setReadyReply(conversationAnswer);
                await load();
              })}>Save and prepare reply</button>
              <button className="btn secondary" onClick={() => run("Keep for later", async () => { await api(`/api/unknown-questions/${currentWhatsapp.id}`, { method: "PUT", body: { workspaceId, suggestedAnswer: conversationAnswer } }); await load(); })}>Save draft only</button>
            </div>
            {readyReply ? <div className="mt-3 rounded-md border border-border-default bg-surface-tint p-3 text-sm"><p className="font-semibold">Reply ready for manual sending</p><p className="mt-1 whitespace-pre-wrap">{readyReply}</p><p className="mt-2 text-xs text-muted">Copy and send outside the app, or approve later from AI Drafts once sending is connected.</p></div> : null}
          </div>
        ) : null}
      </Panel>
      </div>
      ) : null}
      <Panel title="Business areas the AI is waiting on" icon={AlertTriangle}>
        {/* N-UX-10 — the page heading and its one sentence now live in the
            shell (src/app/page-intros.ts), so the paragraph that used to sit
            here repeated them at greater length. The screen starts at the work.
            The two stages still explain themselves, one line each, below. */}
        {/* Q-7 (2026-08-24): the stage switcher. A fresh workspace used to open
            straight onto ~90 backlog cards; the twelve areas below cover the
            questions the AI is actually blocked on. Both stages write through
            the same endpoint, so this is an ordering change, not a second
            way to answer. */}
        {essential.essentialTotalCount > 0 ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-default bg-surface-tint p-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {stage === "start" ? "Setup essentials" : "Everything else"}
              </p>
              {/* N-UX-10 — this line used to read "38 of 43 essential questions
                  still open, across 12 business areas. 384 deeper questions can
                  wait." Three more totals, in a DIFFERENT unit (questions) from
                  the count stated just below it (business areas), so the screen
                  appeared to disagree with itself about how much work there
                  was. The counts live below in areas, once; this line's job is
                  only to say which of the two stages you are looking at and
                  why it comes first. */}
              <p className="mt-1 text-sm text-muted-2">
                {essential.essentialOpenCount > 0
                  ? (stage === "start"
                    ? "The areas the AI is actually blocked on. Answer these first and it can start replying on its own."
                    : "The rest of the questions. Useful, but the AI is not waiting on them to do its job.")
                  : "Every essential area is answered — the AI has what it needs to reply safely."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className={stage === "start" ? "btn text-xs" : "btn secondary text-xs"}
                onClick={() => { setStageChosenByUser(true); setStage("start"); setIndex(0); }}
              >
                Setup essentials · {essential.essentialOpenCount} open
              </button>
              <button
                className={stage === "everything" ? "btn text-xs" : "btn secondary text-xs"}
                onClick={() => { setStageChosenByUser(true); setStage("everything"); setIndex(0); }}
              >
                Everything else · {essential.remainingOpenCount} open
              </button>
            </div>
          </div>
        ) : null}
        {/* N-UX-10 — progress, in one line instead of a scoreboard.
            
            This block used to carry a percentage badge, a bar, two sentences and
            four metric tiles. Counting the whole screen, an operator was shown
            twenty-two numbers, four of which were the same number ("needs
            input", "high priority open", "visible areas need attention", "high
            priority" all read 12), and four totals that disagreed with each
            other (43, 106, 384, 422). Numbers that repeat and disagree do not
            inform, they erode trust in all of them.
            
            What survives is what an operator can act on: how many areas are
            left, and how far through they are. "Skipped" and "high priority"
            still exist as filters below, where they do something. */}
        <div className="mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {progressGroups.length === 0
                // Nothing to be finished with is not the same sentence as
                // having finished it. This branch is what an empty result
                // renders; the completion claim below needs something to have
                // been completed.
                ? "No business areas are waiting on you yet."
                : openGroupCount === 0
                  ? "Every business area is answered."
                  : `${openGroupCount} business area${openGroupCount === 1 ? "" : "s"} still need${openGroupCount === 1 ? "s" : ""} your answer.`}
            </p>
            <p className="text-xs text-muted-2 tabular-nums">{resolvedGroupCount} of {progressGroups.length} done</p>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${overallProgressPercent}%` }}
            />
          </div>
        </div>
        {pendingSettingsDrafts.length ? (
          <div className="mt-4 rounded-md border border-warning-bg bg-warning-bg p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <Gavel className="mt-0.5 h-4 w-4 text-warning-fg" />
                <div>
                  <p className="font-semibold text-warning-fg">Review pending settings</p>
                  <p className="mt-1 text-sm text-warning-fg">{pendingSettingsDrafts.length} draft{pendingSettingsDrafts.length === 1 ? "" : "s"} need owner review before becoming structured source-of-truth.</p>
                </div>
              </div>
              <Badge>{pendingSettingsDrafts.length} pending</Badge>
            </div>
            <div className="mt-3 space-y-2">
              {pendingSettingsDrafts.slice(0, showAllPendingDrafts ? undefined : 3).map((draft) => (
                <div key={draft.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-bg bg-white/70 p-2 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{draft.sourceTitle || (draft.kind === "product" ? "Product Settings draft" : "Structured settings draft")}</p>
                    <p className="text-xs text-warning-fg">{draft.kind === "product" ? `${draft.products?.length || 0} product row${draft.products?.length === 1 ? "" : "s"}` : `${draft.fields?.length || 0} field${draft.fields?.length === 1 ? "" : "s"}`} waiting for explicit save</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn secondary text-xs" onClick={() => openPendingSettingsDraft(draft)}>Review here</button>
                    <button className="btn secondary text-xs" onClick={() => run("Discard pending settings draft", () => discardPendingSettingsDraftItem(draft.id))}>Discard</button>
                  </div>
                </div>
              ))}
            </div>
            {pendingSettingsDrafts.length > 3 && <Button className="mt-3" variant="secondary" size="sm" aria-expanded={showAllPendingDrafts} onClick={() => setShowAllPendingDrafts(current => !current)}>
              {showAllPendingDrafts ? "Show fewer pending reviews" : `Show all ${pendingSettingsDrafts.length} pending reviews`}
            </Button>}
          </div>
        ) : null}
        {stage === "everything" ? (
        <div className="mt-4 grid gap-2 md:grid-cols-5">
          <label><span className="label">Priority</span><select className="input" value={priorityFilter} onChange={(event) => { setPriorityFilter(event.target.value); setIndex(0); }}>
            <option value="high">High priority first</option>
            <option value="critical">Critical business areas</option>
            <option value="medium">Medium priority</option>
            <option value="low">Low priority</option>
            <option value="all">All open questions</option>
          </select></label>
          <label><span className="label">Status</span><select className="input" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setIndex(0); }}>
            <option value="open">Open</option>
            <option value="added_to_knowledge">Resolved</option>
            <option value="ignored">Skipped</option>
            <option value="all">All statuses</option>
          </select></label>
          <label><span className="label">Domain</span><select className="input" value={domainFilter} onChange={(event) => { setDomainFilter(event.target.value); setIndex(0); }}>
            <option value="all">All domains</option>
            {domains.map((domain) => <option key={domain} value={domain}>{knowledgeAreaName(domain)}</option>)}
          </select></label>
          <label><span className="label">Source</span><select className="input" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value); setIndex(0); }}>
            <option value="all">All sources</option>
            <option value="framework">Framework questions</option>
            <option value="llm_suggested">LLM suggested</option>
            <option value="conflict_detection">Conflict detection</option>
            <option value="whatsapp_unknown">WhatsApp unknown</option>
          </select></label>
          <label><span className="label">Topic</span><select className="input" value={topicFilter} onChange={(event) => { setTopicFilter(event.target.value); setIndex(0); }}>
            <option value="all">All topics</option>
            <option value="product">Product specifications</option>
            <option value="payment">Payment / Credit</option>
            <option value="shipping">Shipping / Returns</option>
            <option value="whatsapp">WhatsApp behavior</option>
            <option value="lead">Lead qualification</option>
          </select></label>
        </div>
        ) : null}
        {/* N-UX-10 — a second progress bar and four badges used to sit here,
            under the first progress bar added a few lines above. Between them
            they restated the same twelve four times ("visible areas need
            attention", "high priority", "needs input", "high priority open")
            and printed a fourth incompatible total (422 "knowledge items",
            counting a different unit from the 43 and the 106 already on
            screen). Two progress bars for one task is a contradiction the
            operator has to resolve before they can start working.
            
            One bar, one count, stated once, above. */}
        {currentGroup ? (
          <div className="mt-4 rounded-md border border-border-default bg-surface p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <Badge>{effectiveIndex + 1} of {visibleGroups.length}</Badge>
              <span className="text-xs font-bold uppercase text-muted">{displayLabel(currentGroup.topic)}</span>
            </div>
            <p className="mt-3 text-lg font-semibold text-primary-strong leading-tight">{currentGroup.title}</p>
            <p className="mt-2 text-sm text-muted-2">{currentGroup.description}</p>
            <p className="mt-2 text-sm text-muted">{whyThisHelps(currentGroup.topic)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {/* S6 U-6: was raw `{currentGroup.priority} priority` → showed "high priority"
                  (lowercase). Now uses the displayPriority helper for consistent capitalization. */}
              <Badge>{displayPriority(currentGroup.priority)} priority</Badge>
              <Badge>{displayLabel(currentGroup.status)}</Badge>
              <Badge>{currentGroup.questionsCount} knowledge items</Badge>
              {currentGroup.domainKey ? <Badge>{knowledgeAreaName(currentGroup.domainKey)}</Badge> : null}
            </div>
            {currentGroup.exampleQuestions.length ? (
              <details className="mt-3 rounded-md border border-border-subtle bg-surface-muted p-2 text-xs text-muted">
                <summary className="cursor-pointer font-semibold text-foreground">Show what this helps answer</summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {currentGroup.exampleQuestions.map((question) => <li key={question}>{question}</li>)}
                </ul>
              </details>
            ) : null}

            <label className="mt-5 block">
              <span className="label text-success-fg font-semibold">Add this business detail once</span>
              <textarea
                className="input min-h-32 text-base mt-1"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Example: MOQ is 150 kg for standard products. Custom designs need advance payment and usually dispatch in 10-15 days..."
              />
            </label>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn" disabled={!answer.trim()} onClick={() => run("Save intelligence", async () => {
                if (!answer.trim()) {
                  setSaveMessage("Write an answer before saving.");
                  throw new Error("Write an answer before saving.");
                }
                const ownerAnswer = answer;
                const result = await api<UnknownAnswerResponse>("/api/unknown-questions/groups/answer", { method: "POST", body: { workspaceId, questionIds: currentGroup.questionIds, domainKey: currentGroup.domainKey, relatedQuestionKeys: currentGroup.relatedQuestionKeys, finalAnswer: answer, addToKnowledge: true } });
                markGroupResolvedLocally(currentGroup, result.answeredQuestions ?? currentGroup.questionsCount);
                await loadKnowledge();
                setSaveMessage(result.message || `Business detail saved. ${result.mappedAnswers ?? currentGroup.questionsCount} knowledge items were updated for agent context.`);
                await prepareProductSettingsReview(currentGroup, ownerAnswer);
                await prepareStructuredSettingsReview(currentGroup, ownerAnswer);
                setSyncNeeded(true);
                setAnswer("");
                setIndex(0);
                await load();
                markGroupResolvedLocally(currentGroup, result.answeredQuestions ?? currentGroup.questionsCount);
              })}>Save and next</button>
              <button className="btn secondary" onClick={() => { setIndex((index + 1) % Math.max(visibleGroups.length, 1)); }}>Skip</button>
              <button className="btn secondary" onClick={() => run("Mark not applicable", async () => {
                const result = await api<UnknownAnswerResponse>("/api/unknown-questions/groups/answer", { method: "POST", body: { workspaceId, questionIds: currentGroup.questionIds, domainKey: currentGroup.domainKey, relatedQuestionKeys: currentGroup.relatedQuestionKeys, finalAnswer: "Not applicable for this business.", addToKnowledge: true } });
                markGroupResolvedLocally(currentGroup, result.answeredQuestions ?? currentGroup.questionsCount);
                setSaveMessage("Marked as not applicable and mapped to the knowledge framework.");
                setSyncNeeded(true);
                setAnswer("");
                setIndex(0);
                await load();
                markGroupResolvedLocally(currentGroup, result.answeredQuestions ?? currentGroup.questionsCount);
                await loadKnowledge();
              })}>Not applicable</button>
            </div>
            {saveMessage ? <p className="mt-3 rounded-md border border-border-default bg-surface-tint p-2 text-sm text-primary-strong">{saveMessage}</p> : null}
            {productReviewMessage || productReviewDrafts.length ? (
              <div className="mt-3 rounded-md border border-success-bg bg-surface-muted p-3">
                <div className="flex items-start gap-2">
                  <Package className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <p className="font-semibold text-foreground">Review Product Settings draft</p>
                    <p className="mt-1 text-sm text-muted-2">{productReviewMessage}</p>
                  </div>
                </div>
                {productReviewDrafts.length ? (
                  <div className="mt-3 space-y-3">
                    {productReviewDrafts.map((product, productIndex) => (
                      <div key={product.id} className="rounded-md border border-border-default bg-surface p-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <p className="font-semibold text-foreground">{product.name || `Product ${productIndex + 1}`}</p>
                          <button className="btn secondary text-xs" onClick={() => removeProductReviewDraft(productIndex)}><Trash2 className="h-3 w-3" /> Remove</button>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <Field label="Name" value={product.name} onChange={(value) => updateProductReviewDraft(productIndex, "name", value)} />
                          <Field label="Category" value={product.category || ""} onChange={(value) => updateProductReviewDraft(productIndex, "category", value)} />
                          <Field label="Material" value={product.material || ""} onChange={(value) => updateProductReviewDraft(productIndex, "material", value)} />
                          <Field label="Packaging" value={product.packaging || ""} onChange={(value) => updateProductReviewDraft(productIndex, "packaging", value)} />
                          <Field label="MOQ" value={product.moq || ""} onChange={(value) => updateProductReviewDraft(productIndex, "moq", value)} />
                          <Field label="In-stock dispatch time" value={product.inStockDispatchTime || ""} onChange={(value) => updateProductReviewDraft(productIndex, "inStockDispatchTime", value)} />
                          <Field label="Production dispatch time" value={product.productionDispatchTime || ""} onChange={(value) => updateProductReviewDraft(productIndex, "productionDispatchTime", value)} />
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={product.customizationAvailable || false} onChange={(event) => updateProductReviewDraft(productIndex, "customizationAvailable", event.target.checked)} />
                            Customization available
                          </label>
                          <Field label="Use case tags (comma-separated)" value={(product.useCaseTags || []).join(", ")} onChange={(value) => updateProductReviewDraft(productIndex, "useCaseTags", value.split(",").map((item) => item.trim()).filter(Boolean))} />
                          <Field label="Notes" value={product.notes || ""} onChange={(value) => updateProductReviewDraft(productIndex, "notes", value)} />
                        </div>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="btn" onClick={() => run("Save reviewed Product Settings", saveProductReviewDrafts)}>Save reviewed Product Settings</button>
                      <button className="btn secondary" onClick={() => setActive("settings")}>Open full Settings</button>
                      <span className="text-xs text-muted">The draft is not source-of-truth until you save it.</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {settingsReviewMessage || settingsReviewDraft?.fields.length ? (
              <div className="mt-3 rounded-md border border-success-bg bg-surface-muted p-3">
                <div className="flex items-start gap-2">
                  <Gavel className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <p className="font-semibold text-foreground">Review structured settings draft</p>
                    <p className="mt-1 text-sm text-muted-2">{settingsReviewMessage}</p>
                  </div>
                </div>
                {settingsReviewDraft?.fields.length ? (
                  <div className="mt-3 space-y-3">
                    {(["sales", "policy", "communication"] as const).map((area) => {
                      const areaFields = settingsReviewDraft.fields.filter((field) => field.area === area);
                      if (!areaFields.length) return null;
                      return (
                        <div key={area} className="rounded-md border border-border-default bg-surface p-3">
                          <p className="mb-2 font-semibold text-foreground">{settingsAreaLabel(area)}</p>
                          <div className="grid gap-3">
                            {areaFields.map((field) => {
                              const value = Array.isArray(field.value) ? field.value.join(", ") : field.value;
                              return field.inputType === "textarea" ? (
                                <TextAreaField key={`${field.area}.${field.fieldKey}`} label={field.label} value={value} onChange={(nextValue) => updateSettingsReviewDraft(field, nextValue)} />
                              ) : (
                                <Field key={`${field.area}.${field.fieldKey}`} label={field.inputType === "list" ? `${field.label} (comma-separated)` : field.label} value={value} onChange={(nextValue) => updateSettingsReviewDraft(field, nextValue)} />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="btn" onClick={() => run("Save reviewed structured settings", saveSettingsReviewDrafts)}>Save reviewed settings</button>
                      <button className="btn secondary" onClick={() => setActive("settings")}>Open full Settings</button>
                      <span className="text-xs text-muted">These drafts are not source-of-truth until you save them.</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {syncNeeded ? (
              <div className="mt-3 rounded-md border border-border-default bg-warning-bg p-3 text-sm text-warning-fg">
                <p className="font-semibold">Sync Knowledge is needed before agents use this update.</p>
                <p className="mt-1">The answer is saved in the internal framework. Run the global Sync Knowledge action to refresh WhatsApp, lead review, campaign, and message contexts.</p>
                <button className="btn secondary mt-3 text-xs" onClick={() => setActive("knowledge")}>Open Sync Knowledge</button>
              </div>
            ) : null}
          </div>
        ) : (
          /* N-UX-11 — "no cards need attention" with no controls was a dead
             end, and it also used the system's vocabulary ("grouped
             business-detail cards") rather than the operator's. Reaching this
             state is genuinely good news, so it says so, and then offers the
             two things worth doing next: see what the AI now knows, or give it
             more to read. */
          <EmptyState
            icon={Check}
            title="Nothing left to answer"
            description="The AI has an answer for every business area it was stuck on. It can reply to customers on these topics without you."
            action={(
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setActive("knowledge")}>See what the AI knows</Button>
                <Button variant="secondary" onClick={() => setActive("onboarding")}>Add more documents</Button>
              </div>
            )}
          />
        )}

        {!currentGroup && (productReviewMessage || productReviewDrafts.length) ? (
          <div className="mt-4 rounded-md border border-success-bg bg-surface-muted p-3">
            <div className="flex items-start gap-2">
              <Package className="mt-0.5 h-4 w-4 text-primary" />
              <div>
                <p className="font-semibold text-foreground">Review Product Settings draft</p>
                <p className="mt-1 text-sm text-muted-2">{productReviewMessage}</p>
              </div>
            </div>
            {productReviewDrafts.length ? (
              <div className="mt-3 space-y-3">
                {productReviewDrafts.map((product, productIndex) => (
                  <div key={product.id} className="rounded-md border border-border-default bg-surface p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="font-semibold text-foreground">{product.name || `Product ${productIndex + 1}`}</p>
                      <button className="btn secondary text-xs" onClick={() => removeProductReviewDraft(productIndex)}><Trash2 className="h-3 w-3" /> Remove</button>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="Name" value={product.name} onChange={(value) => updateProductReviewDraft(productIndex, "name", value)} />
                      <Field label="Category" value={product.category || ""} onChange={(value) => updateProductReviewDraft(productIndex, "category", value)} />
                      <Field label="Material" value={product.material || ""} onChange={(value) => updateProductReviewDraft(productIndex, "material", value)} />
                      <Field label="Packaging" value={product.packaging || ""} onChange={(value) => updateProductReviewDraft(productIndex, "packaging", value)} />
                      <Field label="MOQ" value={product.moq || ""} onChange={(value) => updateProductReviewDraft(productIndex, "moq", value)} />
                      <Field label="In-stock dispatch time" value={product.inStockDispatchTime || ""} onChange={(value) => updateProductReviewDraft(productIndex, "inStockDispatchTime", value)} />
                      <Field label="Production dispatch time" value={product.productionDispatchTime || ""} onChange={(value) => updateProductReviewDraft(productIndex, "productionDispatchTime", value)} />
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={product.customizationAvailable || false} onChange={(event) => updateProductReviewDraft(productIndex, "customizationAvailable", event.target.checked)} />
                        Customization available
                      </label>
                      <Field label="Use case tags (comma-separated)" value={(product.useCaseTags || []).join(", ")} onChange={(value) => updateProductReviewDraft(productIndex, "useCaseTags", value.split(",").map((item) => item.trim()).filter(Boolean))} />
                      <Field label="Notes" value={product.notes || ""} onChange={(value) => updateProductReviewDraft(productIndex, "notes", value)} />
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn" onClick={() => run("Save reviewed Product Settings", saveProductReviewDrafts)}>Save reviewed Product Settings</button>
                  <button className="btn secondary" onClick={() => setActive("settings")}>Open full Settings</button>
                  <span className="text-xs text-muted">The draft is not source-of-truth until you save it.</span>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {!currentGroup && (settingsReviewMessage || settingsReviewDraft?.fields.length || syncNeeded) ? (
          <div className="mt-4 rounded-md border border-success-bg bg-surface-muted p-3">
            {settingsReviewMessage || settingsReviewDraft?.fields.length ? (
              <>
                <div className="flex items-start gap-2">
                  <Gavel className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <p className="font-semibold text-foreground">Review structured settings draft</p>
                    <p className="mt-1 text-sm text-muted-2">{settingsReviewMessage}</p>
                  </div>
                </div>
                {settingsReviewDraft?.fields.length ? (
                  <div className="mt-3 space-y-3">
                    {(["sales", "policy", "communication"] as const).map((area) => {
                      const areaFields = settingsReviewDraft.fields.filter((field) => field.area === area);
                      if (!areaFields.length) return null;
                      return (
                        <div key={area} className="rounded-md border border-border-default bg-surface p-3">
                          <p className="mb-2 font-semibold text-foreground">{settingsAreaLabel(area)}</p>
                          <div className="grid gap-3">
                            {areaFields.map((field) => {
                              const value = Array.isArray(field.value) ? field.value.join(", ") : field.value;
                              return field.inputType === "textarea" ? (
                                <TextAreaField key={`${field.area}.${field.fieldKey}`} label={field.label} value={value} onChange={(nextValue) => updateSettingsReviewDraft(field, nextValue)} />
                              ) : (
                                <Field key={`${field.area}.${field.fieldKey}`} label={field.inputType === "list" ? `${field.label} (comma-separated)` : field.label} value={value} onChange={(nextValue) => updateSettingsReviewDraft(field, nextValue)} />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="btn" onClick={() => run("Save reviewed structured settings", saveSettingsReviewDrafts)}>Save reviewed settings</button>
                      <button className="btn secondary" onClick={() => setActive("settings")}>Open full Settings</button>
                      <span className="text-xs text-muted">These drafts are not source-of-truth until you save them.</span>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
            {syncNeeded ? (
              <div className="mt-3 rounded-md border border-border-default bg-warning-bg p-3 text-sm text-warning-fg">
                <p className="font-semibold">Sync Knowledge is needed before agents use this update.</p>
                <p className="mt-1">The answer is saved in the internal framework. Run the global Sync Knowledge action to refresh WhatsApp, lead review, campaign, and message contexts.</p>
                <button className="btn secondary mt-3 text-xs" onClick={() => setActive("knowledge")}>Open Sync Knowledge</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {learningQueue.length > 0 && (
          <div className="mt-6 border-t pt-4">
            <p className="text-xs font-bold uppercase tracking-wider text-muted mb-3">Upcoming information areas</p>
            <div className="space-y-2">
              {learningQueue.slice(0, 3).map((item, queueIndex) => (
                <div key={item.groupKey} className="flex items-center justify-between rounded-md bg-surface-muted p-2 text-sm border border-border-subtle">
                  <span className="truncate pr-4">{item.title}</span>
                  <button
                    className="text-xs font-bold text-primary-strong hover:underline"
                    onClick={() => { setIndex(queueIndex); }}
                    aria-label={`Open questions about ${item.title}`}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {recentlyResolvedGroups.length > 0 && (
          <div className="mt-6 border-t pt-4">
            <p className="mb-3 text-xs font-bold uppercase tracking-wider text-muted">Recently resolved information</p>
            <div className="space-y-2">
              {recentlyResolvedGroups.map((item) => (
                <div key={item.groupKey} className="rounded-md border border-border-default bg-surface-tint p-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate pr-4 font-medium text-primary-strong">{item.title}</span>
                    <Badge>{item.questionsCount} knowledge items</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </Grid>
  );
}
