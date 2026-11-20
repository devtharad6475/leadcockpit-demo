/**
 * N-AI-2 proof probe — does a BRAND-NEW workspace answer a customer with the
 * real model, with nobody ever opening AI Settings?
 *
 * Before the fix the answer was no: six mock slots, no route rows, mock reply.
 * This runs the real inbound WhatsApp path on a workspace that has never been
 * configured, and prints the provider/mode the reply actually came from.
 *
 * Isolated: own workspace id, JSON substrate, temp data dir (force-json-provider).
 */
import { createJsonRepos } from "../golden/_helpers/provider";
import { createKnowledgeDocument, chunkKnowledgeDocument } from "@/services/KnowledgeBaseService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { routeModelSelection } from "@/llm/ModelRouter";
import { resolvePlatformDefaultProvider } from "@/llm/platform-defaults";

const WS = `ws_freshai_${process.pid}`;

async function main() {
  console.log(`platform default provider resolved: ${resolvePlatformDefaultProvider() ?? "(none — no key in env)"}`);

  const repos = createJsonRepos();
  await repos.workspace.create({ id: WS, name: "Fresh install probe", status: "active" });

  // Deliberately NOT creating any llmModelRouting rows. This is what a brand-new
  // workspace looks like: nobody has opened AI Settings.
  const routes = await repos.llmModelRouting.listByWorkspace(WS);
  console.log(`routing rows in this workspace: ${routes.length} (must be 0 for this probe to mean anything)`);

  const route = routeModelSelection("whatsapp_reply", routes);
  console.log(`resolved route: ${route.provider}/${route.modelName} · source=${route.routeSource} · mockFallback=${route.enableMockFallback}`);

  const doc = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Pricing",
    contentText: "Standard service visit: 2400 INR per call-out.\n\nAnnual maintenance contract: 18000 INR per machine per year.",
    documentType: "pricing",
    source: "manual",
    status: "active",
  }, repos);
  await chunkKnowledgeDocument(WS, doc.id, repos);

  const result = await handleIncomingWhatsAppMessage({
    workspaceId: WS,
    phone: "+91 00000 00042",
    rawText: "What do you charge for a service visit?",
    providerMessageId: `probe-${Date.now()}`,
  }, repos, {});

  console.log("\n--- reply ---");
  console.log(result.suggestedReply);
  console.log("--- provenance ---");
  console.log(`provider=${result.llm?.provider} model=${result.llm?.modelName} mode=${result.llm?.mode} fallbackUsed=${result.llm?.fallbackUsed}`);
  console.log(`canAutoSend=${result.canAutoSend} needsHumanReview=${result.needsHumanReview}`);

  const verdict = result.llm?.mode === "real" && result.llm?.provider !== "mock"
    ? "VERDICT: PASS — a workspace nobody configured answered on the REAL model."
    : "VERDICT: FAIL — a fresh workspace is still answering on mock.";
  console.log(`\n${verdict}`);

  await repos.workspace.delete(WS);
}

main().catch((err) => { console.error("PROBE FAILED:", err); process.exit(1); });
