import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { updateModelSlots } from "@/services/AISettingsService";
import { resolveEffectiveModelName } from "@/llm/ModelRouter";

const repos = createJsonRepos();
const workspaceId = `ws_service_change_${Date.now()}`;
const cases: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });
let primaryId: string;
let backupId: string;
const slot = () => ({ slotId: "daily_workhorse", provider: "openai", modelName: "gpt-4o-mini", credentialId: primaryId, fallbackProvider: "anthropic", fallbackModelName: "claude-haiku-4.5", fallbackCredentialId: backupId });

test("same-service primary and backup saved keys are retained", async () => {
  primaryId = (await repos.llmProviderCredential.create(workspaceId, { provider: "openai", encryptedApiKey: "synthetic-never-called", status: "not_connected" })).id;
  backupId = (await repos.llmProviderCredential.create(workspaceId, { provider: "anthropic", encryptedApiKey: "synthetic-never-called", status: "not_connected" })).id;
  const result = await updateModelSlots(workspaceId, [slot()], repos);
  const saved = result.find(item => item.slotId === "daily_workhorse")!;
  assert.equal(saved.credentialId, primaryId);
  assert.equal(saved.fallbackCredentialId, backupId);
  assert.equal(saved.modelName, "gpt-4o-mini");
  assert.equal(saved.fallbackModelName, "claude-haiku-4.5");
});

test("changing the primary service refuses its stale saved key and preserves the route", async () => {
  const before = await repos.llmModelRouting.listByWorkspace(workspaceId);
  await assert.rejects(updateModelSlots(workspaceId, [{ ...slot(), provider: "gemini" }], repos), /saved key does not belong.*AI service/);
  assert.deepEqual(await repos.llmModelRouting.listByWorkspace(workspaceId), before);
});

test("changing the backup service refuses its stale saved key", async () => {
  await assert.rejects(updateModelSlots(workspaceId, [{ ...slot(), fallbackProvider: "deepseek" }], repos), /saved key does not belong.*backup AI service/);
});

test("another company's key is refused even for the same service", async () => {
  const foreign = await repos.llmProviderCredential.create(`${workspaceId}_other`, { provider: "openai", encryptedApiKey: "synthetic-never-called", status: "not_connected" });
  await assert.rejects(updateModelSlots(workspaceId, [{ ...slot(), credentialId: foreign.id }], repos), /saved key does not belong/);
});

test("a later invalid slot is caught before any new key is created", async () => {
  const beforeKeys = await repos.llmProviderCredential.listByWorkspace(workspaceId);
  const beforeRoutes = await repos.llmModelRouting.listByWorkspace(workspaceId);
  await assert.rejects(updateModelSlots(workspaceId, [
    { slotId: "fast_customer_reply", provider: "openai", modelName: "gpt-4o-mini", apiKey: "synthetic-key-not-to-be-written" },
    { ...slot(), provider: "gemini" },
  ], repos), /saved key does not belong/);
  assert.deepEqual(await repos.llmProviderCredential.listByWorkspace(workspaceId), beforeKeys);
  assert.deepEqual(await repos.llmModelRouting.listByWorkspace(workspaceId), beforeRoutes);
});

test("changing services without stale references remains valid", async () => {
  const result = await updateModelSlots(workspaceId, [{ ...slot(), provider: "mock", modelName: "mock-balanced", credentialId: undefined, fallbackProvider: "mock", fallbackModelName: "mock-fast", fallbackCredentialId: undefined }], repos);
  const saved = result.find(item => item.slotId === "daily_workhorse")!;
  assert.equal(saved.provider, "mock");
  assert.equal(saved.credentialId, undefined);
  assert.equal(saved.fallbackModelName, "mock-fast");
});

test("custom selections use the exact-name field; listed models keep their selected name", async () => {
  assert.equal(resolveEffectiveModelName("gpt-4o-mini", "not-the-selected-model"), "gpt-4o-mini");
  assert.equal(resolveEffectiveModelName("ollama-custom", "qwen3:8b"), "qwen3:8b");
  assert.equal(resolveEffectiveModelName("custom-openai-compatible", "vendor/model"), "vendor/model");
  assert.throws(() => resolveEffectiveModelName("ollama-custom", ""), /Custom model name is required/);
});

(async () => {
  let passed = 0;
  for (const item of cases) {
    await item.run();
    passed++;
    console.log(`PASS ${item.name}`);
  }
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
