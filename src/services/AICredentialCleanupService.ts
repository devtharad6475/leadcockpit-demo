/**
 * AICredentialCleanupService — see which saved AI keys are in use, and remove
 * one that is not (2026-09-24).
 *
 * WHY. Production held a saved DeepSeek key marked demo-only, never connected,
 * and pointed at by no AI slot (the slots use the platform key). The owner
 * asked for it to be deleted, and the product had no way to do it: the AI
 * settings screen can add a key but not remove one.
 *
 * THE RULES.
 *   - AI-model keys only. The same table also holds integration keys (web
 *     search, WhatsApp); those have their own screens and are never touched
 *     here.
 *   - A key an AI slot is set to use is refused, and the refusal names the
 *     slots. Removing it would silently move those slots onto another key.
 *   - Keys are never returned, not even masked beyond what the row already
 *     shows; the listing carries the provider, status and dates only.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { PLATFORM_KEY_ENV } from "@/llm/platform-defaults";

const AI_PROVIDERS = new Set<string>([...Object.keys(PLATFORM_KEY_ENV), "ollama", "openai_compatible"]);

export type AICredentialView = {
  id: string;
  provider: string;
  displayName?: string;
  status: string;
  demoOnly: boolean;
  createdAt: string;
  /** The AI slots set to use this key. Empty means nothing uses it. */
  usedBy: string[];
};

export async function listAICredentials(workspaceId: string, repos: RepositoryBundle): Promise<AICredentialView[]> {
  const [credentials, routes] = await Promise.all([
    repos.llmProviderCredential.listByWorkspace(workspaceId),
    repos.llmModelRouting.listByWorkspace(workspaceId),
  ]);
  return credentials
    .filter((credential) => AI_PROVIDERS.has(credential.provider))
    .map((credential) => ({
      id: credential.id,
      provider: credential.provider,
      displayName: credential.displayName,
      status: credential.status,
      demoOnly: credential.config?.demoOnly === true,
      createdAt: credential.createdAt,
      usedBy: routes.filter((route) => route.config?.credentialId === credential.id).map((route) => route.taskName),
    }));
}

export async function removeUnusedAICredential(
  workspaceId: string,
  credentialId: string,
  repos: RepositoryBundle,
): Promise<{ removed: true } | { removed: false; reason: string }> {
  const all = await listAICredentials(workspaceId, repos);
  const target = all.find((credential) => credential.id === credentialId);
  if (!target) {
    const exists = (await repos.llmProviderCredential.listByWorkspace(workspaceId)).some((c) => c.id === credentialId);
    return { removed: false, reason: exists ? "That key belongs to an integration, not an AI model. Remove it from its own screen." : "That saved key does not exist." };
  }
  if (target.usedBy.length) {
    return { removed: false, reason: `This key is in use by: ${target.usedBy.join(", ")}. Point those slots at another key first.` };
  }
  const removed = await repos.llmProviderCredential.delete(workspaceId, credentialId);
  return removed ? { removed: true } : { removed: false, reason: "That saved key does not exist." };
}
