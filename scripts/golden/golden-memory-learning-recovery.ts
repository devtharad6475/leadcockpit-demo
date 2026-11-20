import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { considerLearning, LEARNING_CHECK_JOB, type ProposalCall } from "@/services/LearnedRuleService";
import { LLMService } from "@/llm/LLMService";

const repos = createJsonRepos();
const topic = "delivery_question";
let sequence = 0;
const valid: ProposalCall = async () => ({ found: true, question: "When do you dispatch?", answer: "Dispatch takes five working days." });
function failedCreate<T extends object>(repository: T, message: string): T {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "create") return async () => { throw new Error(message); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixture() {
  const workspaceId = `ws_memory_recovery_${Date.now()}_${sequence++}`;
  for (let i = 0; i < 3; i++) await repos.autoReplyLog.create(workspaceId, {
    channel: "manual", incomingMessage: "When do you dispatch?", classification: topic,
    generatedReply: "Dispatch takes five working days from our warehouse.",
    aiDraft: "We can ship your products tomorrow with free express delivery.",
    ownerEdited: true, status: "approved", canAutoSend: false, needsHumanReview: false,
  });
  return workspaceId;
}

async function checks() {
  const createFailure = await fixture();
  const brokenQueue = { ...repos, unknownQuestion: failedCreate(repos.unknownQuestion, "injected queue write outage") };
  assert.equal((await considerLearning(createFailure, topic, brokenQueue, { propose: valid })).reason, "failed");
  assert.equal((await repos.jobRun.listByWorkspace(createFailure)).filter((j) => j.jobType === LEARNING_CHECK_JOB).length, 0);
  assert.equal((await considerLearning(createFailure, topic, repos, { propose: valid })).reason, "proposed");
  assert.equal((await repos.unknownQuestion.listByWorkspace(createFailure)).length, 1);
  console.log("PASS 1: failed proposal write keeps corrections retryable");

  const receiptFailure = await fixture();
  const brokenReceipt = { ...repos, jobRun: failedCreate(repos.jobRun, "injected receipt write outage") };
  assert.equal((await considerLearning(receiptFailure, topic, brokenReceipt, { propose: valid })).reason, "failed");
  const [saved] = await repos.unknownQuestion.listByWorkspace(receiptFailure);
  assert.ok(saved, "the proposal exists before its receipt");
  await repos.unknownQuestion.update(receiptFailure, saved.id, { status: "ignored" });
  let repeatedCalls = 0;
  assert.equal((await considerLearning(receiptFailure, topic, repos, { propose: async () => { repeatedCalls++; return valid([], topic); } })).reason, "not_enough_corrections");
  assert.equal(repeatedCalls, 0);
  assert.equal((await repos.unknownQuestion.listByWorkspace(receiptFailure)).length, 1);
  console.log("PASS 2: saved proposal prevents repeat billing after receipt failure and dismissal");

  const malformed = await fixture();
  assert.equal((await considerLearning(malformed, topic, repos, { propose: async () => ({ found: true, question: "", answer: "" }) })).reason, "failed");
  assert.equal((await repos.jobRun.listByWorkspace(malformed)).length, 0);
  assert.equal((await considerLearning(malformed, topic, repos, { propose: valid })).reason, "proposed");
  console.log("PASS 3: incomplete AI suggestion remains retryable");

  const negative = await fixture();
  assert.equal((await considerLearning(negative, topic, repos, { propose: async () => ({ found: false }) })).reason, "no_consistent_rule");
  assert.equal((await considerLearning(negative, topic, repos, { propose: async () => { throw new Error("negative result must not be billed twice"); } })).reason, "not_enough_corrections");
  assert.equal((await repos.unknownQuestion.listByWorkspace(negative)).length, 0);
  console.log("PASS 4: valid negative result closes only its own check");

  const original = LLMService.prototype.runTask;
  try {
    for (const mode of ["mock", "fallback"] as const) {
      const unavailable = await fixture();
      LLMService.prototype.runTask = (async () => ({ output: { found: false }, mode, fallbackUsed: mode === "fallback" })) as unknown as typeof original;
      assert.equal((await considerLearning(unavailable, topic, repos)).reason, "failed");
      assert.equal((await repos.jobRun.listByWorkspace(unavailable)).length, 0);
      assert.equal((await considerLearning(unavailable, topic, repos, { propose: valid })).reason, "proposed");
    }
  } finally { LLMService.prototype.runTask = original; }
  console.log("PASS 5: mock and fallback results are not completed learning checks");
}

void checks().then(() => console.log("PASS: memory learning recovery (5 cases)")).catch((error) => { console.error(error); process.exitCode = 1; });
