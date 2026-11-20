import { NeedsActionError } from "@/lib/user-errors";
import { crawlWebsite } from "@/lib/crawler";
import { timestamp, uid } from "@/lib/db";
import type { AppData, KnowledgeExtractionSource, KnowledgeExtractionSourceBundle } from "@/lib/types";
import { routeModelSelection } from "@/llm/ModelRouter";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { answerDocumentQuestions } from "@/services/DocumentQuestionAnsweringService";
import { indexSourcesIntoKnowledgeBase } from "@/services/KnowledgeSourceIndexingService";
import { routeExtractedFactsToBusinessProfile, routeExtractedFactsToSettings } from "@/services/ExtractionRoutingService";

export type UploadedSourceInput = {
  fileName: string;
  fileType?: string;
  extractedText: string;
  size?: number;
  warning?: string;
};

export type UnifiedKnowledgeExtractionInput = {
  workspaceId: string;
  websiteUrl?: string;
  websiteConsent?: boolean;
  files?: UploadedSourceInput[];
  pastedText?: string;
  pageLimit?: number;
};

export async function extractCompanyKnowledgeFromSourceBundle(input: UnifiedKnowledgeExtractionInput, repos: RepositoryBundle = createRepositories()) {
  const hasWebsite = Boolean(input.websiteUrl?.trim());
  const readableFiles = (input.files || []).filter((file) => file.extractedText?.trim());
  const hasPastedText = Boolean(input.pastedText?.trim());
  if (!hasWebsite && !readableFiles.length && !hasPastedText) {
    throw new NeedsActionError("Add a website URL or upload at least one document first.", 400);
  }
  if (hasWebsite && !input.websiteConsent) {
    // Name the site. The old message said only "Website scan requires
    // permission before crawling", which is unreadable when the URL in the box
    // is not one the operator put there — the field used to ship pre-filled
    // with https://example.com, so a document-only run failed pointing at a
    // website nobody had typed. Say which URL, and say the other way out.
    throw new NeedsActionError(
      `Website scan requires permission before crawling ${input.websiteUrl!.trim()}. `
      + "Tick the permission box to include it, or clear the Website URL field to extract from the uploaded documents only."
    );
  }

  const runningExtraction = await findActiveExtraction(input.workspaceId, repos);
  if (runningExtraction) {
    throw new NeedsActionError(`Company knowledge extraction is already running (${runningExtraction.processedQuestions || 0} of ${runningExtraction.totalQuestions || "all"} questions done). Please wait for it to finish before starting another extraction.`, 409);
  }

  const routes = await repos.llmModelRouting.listByWorkspace(input.workspaceId);
  const routedModel = routeModelSelection("document_extraction_mapping", routes);
  // N-BUG (2026-09-07) — this used to also treat "no saved daily_workhorse slot
  // row" as mock. That is not what a missing row means. routeModelSelection
  // already falls back to the platform default for the slot, and
  // platformSlotDefaults() only returns `mock` when no platform provider key is
  // set — so an operator who never opened AI Settings still gets a real model
  // whenever the deployment has one. On this deployment that produced a run
  // that spent 262,994 real DeepSeek tokens and then labelled itself
  // "Demo/mock extraction completed for preview", telling the operator to go
  // and configure the model that had just done the work. The routed provider is
  // the thing that actually decides which model answers, so ask only that.
  const usingMockExtraction = routedModel.provider === "mock";

  const bundle = await createBundle(input.workspaceId, input.websiteUrl, repos);
  const sources: KnowledgeExtractionSource[] = [];

  if (hasWebsite) {
    await updateBundleStatus(input.workspaceId, bundle.id, "crawling_website", {}, repos);
    try {
      const pages = await crawlWebsite(input.websiteUrl!, input.pageLimit || 8);
      const websiteText = pages.map((page) => [
        `Page: ${page.title}`,
        `URL: ${page.url}`,
        page.text,
      ].filter(Boolean).join("\n")).join("\n\n");
      sources.push(await addSource({
        workspaceId: input.workspaceId,
        bundleId: bundle.id,
        sourceType: "website",
        sourceTitle: `Website scan: ${input.websiteUrl}`,
        sourceUrl: input.websiteUrl,
        extractedText: websiteText,
        metadataJson: { pages: pages.map((page) => ({ url: page.url, title: page.title, textLength: page.text.length, emails: page.emails, phones: page.phones, socials: page.socials, catalogues: page.catalogues })) },
        status: "ready",
      }, repos));
    } catch (error) {
      sources.push(await addSource({
        workspaceId: input.workspaceId,
        bundleId: bundle.id,
        sourceType: "website",
        sourceTitle: `Website scan: ${input.websiteUrl}`,
        sourceUrl: input.websiteUrl,
        extractedText: "",
        metadataJson: { error: error instanceof Error ? error.message : "Website crawl failed" },
        status: "failed",
      }, repos));
      if (!readableFiles.length && !hasPastedText) throw error;
    }
  }

  await updateBundleStatus(input.workspaceId, bundle.id, "extracting_files", {}, repos);
  for (const file of readableFiles) {
    sources.push(await addSource({
      workspaceId: input.workspaceId,
      bundleId: bundle.id,
      sourceType: "uploaded_file",
      sourceTitle: file.fileName,
      sourceFileName: file.fileName,
      extractedText: file.extractedText,
      metadataJson: { fileType: file.fileType, size: file.size, warning: file.warning },
      status: "ready",
    }, repos));
  }
  if (hasPastedText) {
    sources.push(await addSource({
      workspaceId: input.workspaceId,
      bundleId: bundle.id,
      sourceType: "pasted_text",
      sourceTitle: "Pasted company notes",
      extractedText: input.pastedText!.trim(),
      metadataJson: {},
      status: "ready",
    }, repos));
  }

  const readySources = sources.filter((source) => source.status === "ready" && source.extractedText.trim());
  if (!readySources.length) {
    await updateBundleStatus(input.workspaceId, bundle.id, "failed", { errorMessage: "No readable source text was available for extraction." }, repos);
    throw new NeedsActionError("No readable source text was available for extraction.", 400);
  }

  const combinedText = buildCombinedSourceText(readySources);
  await updateBundleStatus(input.workspaceId, bundle.id, "running_extraction", { sourceCount: readySources.length, combinedTextLength: combinedText.length }, repos);
  let questionAnswering;
  try {
    questionAnswering = await answerDocumentQuestions({
      workspaceId: input.workspaceId,
      documentId: bundle.id,
      documentText: combinedText,
      documentMetadata: { title: `Combined onboarding sources (${readySources.length})`, sourceType: "manual_text" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Company knowledge extraction failed.";
    await updateBundleStatus(input.workspaceId, bundle.id, message.toLowerCase().includes("canceled") ? "canceled" : "failed", {
      sourceCount: readySources.length,
      combinedTextLength: combinedText.length,
      errorMessage: message,
    }, repos);
    throw error;
  }

  // 2026-09-18 (session 57): the uploaded documents themselves become
  // searchable, not only the answers the framework produced from them. 424
  // questions cannot cover a company; the sentence a customer asks about is
  // often in the PDF and was, until now, in no index at all. Runs AFTER the
  // answers are saved and never throws: indexing is an improvement to search,
  // not a condition of the extraction the owner just paid for.
  let indexedSources;
  try {
    indexedSources = await indexSourcesIntoKnowledgeBase(input.workspaceId, readySources, repos);
  } catch (error) {
    console.warn(`[bundle] source indexing failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Route extracted structured facts into Settings
  let routingResult;
  let profileRoutingResult;
  let profileRoutingError: string | undefined;
  try {
    const data = await repos.readAll!();
    const answers = (data.knowledgeQuestionAnswers || []).filter((a) => a.workspaceId === input.workspaceId);
    routingResult = await routeExtractedFactsToSettings(
      input.workspaceId,
      answers,
      `onboarding_bundle:${bundle.id}`,
    );
    // N-BUG (2026-09-07) — the profile the rest of the product is gated on.
    // Without this, a document-only onboarding leaves BusinessProfile null and
    // Ideal Customers / Campaign / Discovery stay disabled forever, with no UI
    // anywhere that can create one. Its failure is reported rather than
    // swallowed: a silently missing profile is what made this bug invisible.
    try {
      profileRoutingResult = await routeExtractedFactsToBusinessProfile(
        input.workspaceId,
        answers,
        `onboarding_bundle:${bundle.id}`,
      );
    } catch (error) {
      profileRoutingError = error instanceof Error ? error.message : "Business profile routing failed.";
    }
  } catch {
    routingResult = undefined;
  }

  const finalStatus = questionAnswering.run.status === "completed" ? "completed" : questionAnswering.run.status === "failed" ? "failed" : "partial";
  const updatedBundle = await updateBundleStatus(input.workspaceId, bundle.id, finalStatus, {
    sourceCount: readySources.length,
    combinedTextLength: combinedText.length,
    extractionRunId: questionAnswering.run.id,
    errorMessage: usingMockExtraction ? "Demo/mock extraction completed for preview. Configure a real Daily Workhorse model before production use." : undefined,
  }, repos);
  return { bundle: updatedBundle, sources, readySources, questionAnswering, routingResult, profileRoutingResult, profileRoutingError, indexedSources };
}

async function findActiveExtraction(workspaceId: string, repos: RepositoryBundle) {
  const data = await repos.readAll!();
  return (data.knowledgeExtractionRuns || []).find((run) =>
    run.workspaceId === workspaceId &&
    ["pending", "running"].includes(run.status)
  );
}

export function buildCombinedSourceText(sources: KnowledgeExtractionSource[]) {
  return sources.map((source) => [
    `[Source: ${source.sourceType === "website" ? source.sourceTitle : `File - ${source.sourceFileName || source.sourceTitle}`}]`,
    source.sourceUrl ? `[URL: ${source.sourceUrl}]` : "",
    source.extractedText,
  ].filter(Boolean).join("\n")).join("\n\n---\n\n");
}

async function createBundle(workspaceId: string, websiteUrl: string | undefined, repos: RepositoryBundle) {
  return repos.mutateAll!((data) => {
    data.knowledgeExtractionSourceBundles ||= [];
    const now = timestamp();
    const bundle: KnowledgeExtractionSourceBundle = {
      id: uid("ksb"),
      workspaceId,
      status: "preparing_sources",
      websiteUrl,
      uploadedDocumentIdsJson: { values: [] },
      sourceCount: 0,
      combinedTextLength: 0,
      createdAt: now,
      updatedAt: now,
    };
    data.knowledgeExtractionSourceBundles.push(bundle);
    return bundle;
  });
}

async function addSource(source: Omit<KnowledgeExtractionSource, "id" | "createdAt" | "updatedAt">, repos: RepositoryBundle) {
  return repos.mutateAll!((data) => {
    data.knowledgeExtractionSources ||= [];
    const now = timestamp();
    const item: KnowledgeExtractionSource = { id: uid("kxs"), ...source, createdAt: now, updatedAt: now };
    data.knowledgeExtractionSources.push(item);
    return item;
  });
}

async function updateBundleStatus(workspaceId: string, bundleId: string, status: KnowledgeExtractionSourceBundle["status"], patch: Partial<KnowledgeExtractionSourceBundle>, repos: RepositoryBundle) {
  return repos.mutateAll!((data: AppData) => {
    data.knowledgeExtractionSourceBundles ||= [];
    const bundle = data.knowledgeExtractionSourceBundles.find((item) => item.workspaceId === workspaceId && item.id === bundleId);
    if (!bundle) throw new Error("Knowledge source bundle not found");
    Object.assign(bundle, patch, { status, updatedAt: timestamp() });
    return bundle;
  });
}
