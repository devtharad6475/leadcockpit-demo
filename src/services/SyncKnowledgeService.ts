import { createRepositories } from "@/repositories";
import { syncBusinessProfileToKnowledgeBase } from "./KnowledgeBaseService";
import { routeExtractedFactsToBusinessProfile, routeExtractedFactsToSettings, type ProfileRoutingResult, type ExtractionRoutingResult } from "./ExtractionRoutingService";
import { syncKnowledgeQuestionAnswers } from "./DocumentQuestionAnsweringService";
import { indexSourcesIntoKnowledgeBase } from "./KnowledgeSourceIndexingService";
import { syncStructuredSettingsToQuestions } from "./StructuredSettingsQuestionMappingService";
import type { JsonRecord, PendingSettingsDraft, ProductSettings } from "@/lib/types";
import { safeNotFound } from "@/lib/safe-not-found";

export type SyncKnowledgeSummary = {
  status: "synced" | "partial" | "failed";
  timestamp: string;
  profile: { synced: boolean; documentId?: string; chunks?: number } | { synced: false; error: string };
  profileRouting?: ProfileRoutingResult;
  settingsRouting?: ExtractionRoutingResult;
  profileRoutingError?: string;
  settings: {
    sales: SettingsSyncSummary;
    products: SettingsSyncSummary;
    policy: SettingsSyncSummary;
    communication: SettingsSyncSummary;
  };
  knowledgeBase: {
    synced: boolean;
    documentId?: string;
    chunks?: number;
    sectionsSynced?: number;
    blocksSynced?: number;
    warnings?: number;
    skippedUnapproved?: number;
  } | { synced: false; error: string };
  /**
   * The uploaded files themselves, made searchable. See step 4b. `failed`
   * counts sources the indexer could not handle: it swallows those per file so
   * one bad PDF cannot stop the rest, which means the count here is the ONLY
   * place that failure is visible to the owner.
   */
  sourcesIndexed?: { indexed: boolean; documents: number; chunks: number; failed: number } | { indexed: false; error: string };
  conflictsPending: number;
  agentsAffected: string[];
};

type SettingsSyncSummary = {
  synced: boolean;
  status: "synced" | "not_configured" | "failed";
  label: string;
  message: string;
  updatedAnswers?: number;
  action?: string;
  error?: string;
  sourceDetails?: SettingsSourceDetails;
};

type SettingsSourceDetails = {
  reviewedInformationNeeded: number;
  directSettingsFields: number;
  pendingReview: number;
  reviewedDraftTitles: string[];
  message: string;
};

function notConfiguredSettings(label: string, action: string, sourceDetails?: SettingsSourceDetails): SettingsSyncSummary {
  return {
    synced: false,
    status: "not_configured",
    label,
    message: `${label} are not set yet.`,
    action,
    sourceDetails,
  };
}

function syncedSettings(label: string, updatedAnswers: number, sourceDetails?: SettingsSourceDetails): SettingsSyncSummary {
  return {
    synced: true,
    status: "synced",
    label,
    updatedAnswers,
    message: `${label} synced into ${updatedAnswers} internal answer${updatedAnswers === 1 ? "" : "s"}.`,
    sourceDetails,
  };
}

function failedSettings(label: string, error: unknown): SettingsSyncSummary {
  const message = error instanceof Error ? error.message : String(error || "Could not sync this settings area.");
  return {
    synced: false,
    status: "failed",
    label,
    message: `${label} could not be synced.`,
    error: message,
  };
}

export async function syncWorkspaceKnowledge(workspaceId: string, repos = createRepositories()): Promise<SyncKnowledgeSummary> {
  const now = new Date().toISOString();
  // Cluster 5 P1-2: was `.catch(() => [])` — reported "0 pending drafts" when
  // the repo threw, hiding the truth from the operator. Now not-found only.
  const settingsDrafts = await safeNotFound(
    () => repos.pendingSettingsDraft.listByWorkspace(workspaceId),
    { fallback: [] as PendingSettingsDraft[], context: "syncWorkspaceKnowledge pendingSettingsDraft.listByWorkspace" },
  );
  const summary: SyncKnowledgeSummary = {
    status: "synced",
    timestamp: now,
    profile: { synced: false, error: "" },
    settings: {
      sales: notConfiguredSettings("Sales settings", "Add MOQ, payment, quotation, and lead qualification rules in Settings.", settingsSourceDetails(settingsDrafts, "sales", 0)),
      products: notConfiguredSettings("Product settings", "Add important products, variants, packaging, MOQ, and dispatch details in Settings.", settingsSourceDetails(settingsDrafts, "product", 0)),
      policy: notConfiguredSettings("Policy settings", "Add payment, return, shipping, cancellation, and sample policies in Settings.", settingsSourceDetails(settingsDrafts, "policy", 0)),
      communication: notConfiguredSettings("WhatsApp settings", "Add tone, fallback reply, auto-reply topics, and human-review rules in Settings.", settingsSourceDetails(settingsDrafts, "communication", 0)),
    },
    knowledgeBase: { synced: false, error: "" },
    conflictsPending: 0,
    agentsAffected: ["knowledge-base-agent", "whatsapp-conversation-agent", "lead-review-agent", "message-generation-agent", "campaign-planning-agent"],
  };

  // 0. Fill the business profile from settled extraction answers first.
  //
  // N-BUG (2026-09-07). Step 1 below pushes the profile INTO the knowledge
  // base; nothing pushed the extracted facts INTO the profile. A workspace
  // onboarded from documents alone therefore had no profile at all, and this
  // button answered `{ synced: false, error: "Business profile not found" }`
  // while the company name, industry, website, email and address it needed
  // were sitting in knowledgeQuestionAnswers, already extracted and already
  // approved. The extraction path now creates the profile itself, but that
  // only helps the NEXT extraction — this covers a workspace whose extraction
  // has already run, without spending another model call to redo it.
  try {
    const data = await repos.readAll?.();
    const answers = (data?.knowledgeQuestionAnswers || []).filter((item) => item.workspaceId === workspaceId);
    if (answers.length) {
      summary.profileRouting = await routeExtractedFactsToBusinessProfile(workspaceId, answers, "knowledge_sync", repos);
      // 0b. And the same for the structured settings.
      //
      // N-BUG (2026-09-08). Extraction routes facts into settings exactly
      // once, at extraction time, from two call sites — the website crawl and
      // the onboarding bundle. Both re-run the model. There was no way to
      // re-apply facts already extracted and already stored, which is what a
      // workspace needs after any single write fails.
      //
      // It failed on the live deployment: five conflicts were approved, four
      // wrote, and paymentPolicy 500'd on a Date-serialization fault while
      // being marked `resolved` anyway. The operator had approved the
      // company's payment terms, the policy column was empty, and because a
      // resolved conflict never resurfaces, nothing would ever ask again. The
      // resolve path no longer marks before it writes — but that fixes the
      // next workspace, not this one, and a product that cannot repair its
      // own state needs someone with database access every time.
      //
      // Routing only fills EMPTY fields and cards genuine differences for
      // review, so re-running it can restore a lost value and can never
      // overwrite one the operator set.
      // Card, never write: these answers came from Information Needed, and they
      // become settings only through the owner's draft-and-save review.
      summary.settingsRouting = await routeExtractedFactsToSettings(workspaceId, answers, "knowledge_sync", repos, { autoFillEmpty: false });
    }
  } catch (error) {
    // Reported, not swallowed. A profile that silently fails to appear is
    // exactly what made this bug invisible for as long as it was.
    summary.profileRoutingError = error instanceof Error ? error.message : String(error);
  }

  // 1. Sync business profile
  try {
    // N-AI-10: force the rebuild here. The service now skips re-embedding when
    // the profile text is unchanged (because it runs automatically on every
    // save), but this path is the operator pressing "Sync Knowledge" on
    // purpose — a button that deliberately does nothing is worse than a slow one.
    const profileResult = await syncBusinessProfileToKnowledgeBase(workspaceId, repos, { force: true });
    summary.profile = { synced: true, documentId: profileResult.document.id, chunks: profileResult.chunks.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.profile = { synced: false, error: message };
    summary.status = "partial";
  }

  // 2. Sync reviewed structured settings into question answers.
  // Information Needed answers can create editable settings drafts in the UI, but source-of-truth settings
  // are only synced after the owner explicitly saves those reviewed settings.
  const salesSettings = await repos.salesSettings.getByWorkspace(workspaceId);
  if (salesSettings) {
    try {
      const salesSync = await syncStructuredSettingsToQuestions(workspaceId, { sales: salesSettings });
      summary.settings.sales = syncedSettings("Sales settings", salesSync.updatedAnswers, settingsSourceDetails(settingsDrafts, "sales", countFilledSettingsFields(salesSettings)));
    } catch (error) {
      summary.settings.sales = failedSettings("Sales settings", error);
      summary.status = "partial";
    }
  }

  const productSettings = await repos.productSettings.getByWorkspace(workspaceId);
  if (productSettings?.products?.length) {
    try {
      const productSync = await syncStructuredSettingsToQuestions(workspaceId, { product: productSettings });
      summary.settings.products = syncedSettings("Product settings", productSync.updatedAnswers, settingsSourceDetails(settingsDrafts, "product", countProductSettingsFields(productSettings)));
    } catch (error) {
      summary.settings.products = failedSettings("Product settings", error);
      summary.status = "partial";
    }
  }

  const policySettings = await repos.policySettings.getByWorkspace(workspaceId);
  if (policySettings) {
    try {
      const policySync = await syncStructuredSettingsToQuestions(workspaceId, { policy: policySettings });
      summary.settings.policy = syncedSettings("Policy settings", policySync.updatedAnswers, settingsSourceDetails(settingsDrafts, "policy", countFilledSettingsFields(policySettings)));
    } catch (error) {
      summary.settings.policy = failedSettings("Policy settings", error);
      summary.status = "partial";
    }
  }

  const communicationSettings = await repos.communicationSettings.getByWorkspace(workspaceId);
  if (communicationSettings) {
    try {
      const commSync = await syncStructuredSettingsToQuestions(workspaceId, { communication: communicationSettings });
      summary.settings.communication = syncedSettings("WhatsApp settings", commSync.updatedAnswers, settingsSourceDetails(settingsDrafts, "communication", countFilledSettingsFields(communicationSettings)));
    } catch (error) {
      summary.settings.communication = failedSettings("WhatsApp settings", error);
      summary.status = "partial";
    }
  }

  // 4. Compile all approved question-answers into searchable KB document
  try {
    const kbSync = await syncKnowledgeQuestionAnswers(workspaceId);
    summary.knowledgeBase = {
      synced: true,
      documentId: kbSync.document?.id,
      chunks: kbSync.chunks?.length,
      sectionsSynced: kbSync.sectionsSynced,
      blocksSynced: kbSync.blocksSynced,
      warnings: kbSync.warnings,
      skippedUnapproved: kbSync.skippedUnapproved,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.knowledgeBase = { synced: false, error: message };
    summary.status = "partial";
  }

  // 4b. N15 (2026-09-18, session 57) — index the uploaded documents themselves.
  //
  // Source indexing shipped attached to EXTRACTION, and only extraction called
  // it. Every file uploaded before that day therefore sits in the product with
  // its text stored and no chunk in the index, and the only way to fix it was to
  // pay for a full extraction again. Found on production: 424 answers, one
  // source document, ZERO chunks — the AI had nothing to search.
  //
  // Sync Knowledge is the button that means "make what I have searchable", so
  // this is where it belongs. Indexing is keyed on the file name and replaces
  // rather than appends, so pressing Sync twice cannot double the index.
  //
  // It never fails the sync: the answers above are the part the owner is
  // waiting on, and a file that will not chunk must not take them down with it.
  try {
    const data = await repos.readAll!();
    const sources = (data.knowledgeExtractionSources || []).filter(
      (source) => source.workspaceId === workspaceId && source.status === "ready" && (source.extractedText || "").trim(),
    );
    const indexed = sources.length ? await indexSourcesIntoKnowledgeBase(workspaceId, sources, repos) : [];
    // The indexer is best-effort PER FILE and reports a failure only by leaving
    // it out of the result. Counting the difference is therefore the only way
    // an owner ever learns that one of their documents is not searchable — and
    // a sync that quietly dropped a file must not read as a sync that worked.
    const failed = sources.length - indexed.length;
    summary.sourcesIndexed = {
      indexed: failed === 0,
      documents: indexed.length,
      chunks: indexed.reduce((total, item) => total + item.chunkCount, 0),
      failed,
    };
    if (failed > 0) summary.status = "partial";
  } catch (error) {
    summary.sourcesIndexed = { indexed: false, error: error instanceof Error ? error.message : String(error) };
    summary.status = "partial";
  }

  // 5. Count pending conflicts
  // Cluster 5 P1-2: was bare `catch { 0 }` — reported "0 conflicts" when the
  // repo threw, hiding real conflicts the operator needed to resolve. Now:
  // not-found → 0 (none yet, true); real error → bubbles up.
  const conflicts = await safeNotFound(
    () => repos.settingsConflict.listByWorkspace(workspaceId, { status: "open" }),
    { fallback: [], context: "syncWorkspaceKnowledge settingsConflict.listByWorkspace" },
  );
  summary.conflictsPending = conflicts.length;

  return summary;
}

function settingsSourceDetails(drafts: PendingSettingsDraft[], area: "sales" | "product" | "policy" | "communication", filledSettingsFields: number): SettingsSourceDetails {
  const areaDrafts = drafts.filter((draft) => draftTouchesArea(draft, area));
  const savedDrafts = areaDrafts.filter((draft) => draft.status === "saved");
  const pendingDrafts = areaDrafts.filter((draft) => draft.status === "pending_review");
  const reviewedInformationNeeded = savedDrafts.reduce((total, draft) => total + draftFieldCount(draft, area), 0);
  const directSettingsFields = Math.max(0, filledSettingsFields - reviewedInformationNeeded);
  const reviewedDraftTitles = Array.from(new Set(savedDrafts.map((draft) => draft.sourceTitle || (draft.kind === "product" ? "Product Settings review" : "Information Needed review")).filter(Boolean))).slice(0, 3);
  const pieces = [];
  if (reviewedInformationNeeded) pieces.push(`${reviewedInformationNeeded} reviewed Information Needed field${reviewedInformationNeeded === 1 ? "" : "s"}`);
  if (directSettingsFields) pieces.push(`${directSettingsFields} direct Settings field${directSettingsFields === 1 ? "" : "s"}`);
  if (pendingDrafts.length) pieces.push(`${pendingDrafts.length} draft${pendingDrafts.length === 1 ? "" : "s"} still pending review`);
  return {
    reviewedInformationNeeded,
    directSettingsFields,
    pendingReview: pendingDrafts.length,
    reviewedDraftTitles,
    message: pieces.length ? `Source: ${pieces.join(", ")}.` : "Source: no reviewed settings history found yet.",
  };
}

function draftTouchesArea(draft: PendingSettingsDraft, area: "sales" | "product" | "policy" | "communication") {
  if (area === "product") return draft.kind === "product" && Boolean(draft.products?.length);
  return Boolean(draft.fields?.some((field) => field.area === area) || draft[area]);
}

function draftFieldCount(draft: PendingSettingsDraft, area: "sales" | "product" | "policy" | "communication") {
  if (area === "product") return draft.products?.length || 0;
  const fieldCount = draft.fields?.filter((field) => field.area === area).length || 0;
  return fieldCount || countFilledSettingsFields((draft[area] || {}) as JsonRecord);
}

function countProductSettingsFields(settings: ProductSettings) {
  return settings.products.reduce((total, product) => total + countFilledSettingsFields(product as unknown as JsonRecord), 0);
}

function countFilledSettingsFields(settings: JsonRecord) {
  return Object.entries(settings)
    .filter(([key, value]) => !["id", "workspaceId", "createdAt", "updatedAt"].includes(key) && hasSettingValue(value))
    .length;
}

function hasSettingValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some(hasSettingValue);
  if (typeof value === "object") return Object.values(value as JsonRecord).some(hasSettingValue);
  return String(value).trim().length > 0;
}
