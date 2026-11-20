import { NeedsActionError } from "@/lib/user-errors";
import { timestamp, uid } from "@/lib/db";
import type { HumanFallbackTask, KnowledgeEntry } from "@/lib/types";
import { getKnowledgeQuestion } from "@/knowledge/knowledge-question-framework";
import { createRepositories, type RepositoryBundle } from "@/repositories";

export type UpsertKnowledgeEntryInput = {
  workspaceId: string;
  questionKey: string;
  answer: string;
  domainKey?: string;
  taskId?: string;
};

export type UpsertKnowledgeEntryResult = {
  success: true;
  entry: KnowledgeEntry;
  resolvedTask?: HumanFallbackTask;
  mode: "created" | "updated";
};

function parseQuestionId(input: UpsertKnowledgeEntryInput) {
  if (input.domainKey) {
    return { domainKey: input.domainKey, questionKey: input.questionKey.replace(`${input.domainKey}/`, "") };
  }
  const [domainKey, ...rest] = input.questionKey.split("/");
  if (!domainKey || rest.length === 0) {
    throw new NeedsActionError("questionKey must be formatted as domainKey/questionKey when domainKey is not supplied.", 400);
  }
  return { domainKey, questionKey: rest.join("/") };
}

export async function upsertKnowledgeEntry(input: UpsertKnowledgeEntryInput, repos: RepositoryBundle = createRepositories()): Promise<UpsertKnowledgeEntryResult> {
  const workspaceId = input.workspaceId;
  const answer = input.answer.trim();
  if (!workspaceId) throw new NeedsActionError("workspaceId is required.", 400);
  if (!answer) throw new NeedsActionError("answer is required.", 400);

  const { domainKey, questionKey } = parseQuestionId(input);
  const questionDef = getKnowledgeQuestion(domainKey, questionKey);
  if (!questionDef) throw new NeedsActionError(`Invalid question key: ${domainKey}/${questionKey}`, 400);

  return repos.mutateAll!((data) => {
    data.knowledgeEntries ||= [];
    data.humanFallbackTasks ||= [];
    const questionId = `${domainKey}/${questionKey}`;
    const existingIndex = data.knowledgeEntries.findIndex((item) => item.workspaceId === workspaceId && item.questionId === questionId);
    const now = timestamp();
    const entry: KnowledgeEntry = {
      id: existingIndex >= 0 ? data.knowledgeEntries[existingIndex].id : uid("knowledge_entry"),
      workspaceId,
      questionId,
      questionText: questionDef.question,
      answer,
      domain: domainKey,
      confidence: 1,
      createdAt: existingIndex >= 0 ? data.knowledgeEntries[existingIndex].createdAt : now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      data.knowledgeEntries[existingIndex] = entry;
    } else {
      data.knowledgeEntries.push(entry);
    }

    let resolvedTask: HumanFallbackTask | undefined;
    if (input.taskId) {
      const taskIndex = data.humanFallbackTasks.findIndex((task) => task.workspaceId === workspaceId && task.id === input.taskId);
      if (taskIndex >= 0) {
        resolvedTask = {
          ...data.humanFallbackTasks[taskIndex],
          status: "RESOLVED",
          resolvedAt: now,
          updatedAt: now,
        };
        data.humanFallbackTasks[taskIndex] = resolvedTask;
      }
    }

    return {
      success: true,
      entry,
      resolvedTask,
      mode: existingIndex >= 0 ? "updated" : "created",
    };
  });
}
