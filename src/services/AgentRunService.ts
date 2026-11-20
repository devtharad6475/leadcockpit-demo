import { AGENT_NAMES } from "@/constants/agents";
import { defaultWorkspaceId, timestamp } from "@/lib/db";
import type { JsonRecord } from "@/lib/types";
import { createRepositories } from "@/repositories";

export type AgentRunServiceInput = {
  workspaceId?: string;
  agentName: string;
  agentVersion?: string;
  entityType?: string;
  entityId?: string;
  inputJson?: JsonRecord;
  outputJson?: JsonRecord;
  promptText?: string;
  modelName?: string;
  errorMessage?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costEstimate?: number;
};

export class AgentRunService {
  constructor(private readonly repos = createRepositories()) {}

  async startAgentRun(input: AgentRunServiceInput) {
    return this.repos.agentRun.create({
      workspaceId: input.workspaceId || defaultWorkspaceId,
      agentName: normalizeAgentName(input.agentName),
      input: {
        agentVersion: input.agentVersion,
        entityType: input.entityType,
        entityId: input.entityId,
        inputJson: input.inputJson || {},
        promptText: input.promptText,
        modelName: input.modelName,
        tokensInput: input.tokensInput,
        tokensOutput: input.tokensOutput,
        costEstimate: input.costEstimate,
      },
      status: "running",
      startedAt: timestamp(),
    });
  }

  async completeAgentRun(workspaceId: string, agentRunId: string, output: JsonRecord = {}) {
    return this.repos.agentRun.update(workspaceId, agentRunId, {
      status: "completed",
      output,
      completedAt: timestamp(),
    });
  }

  async failAgentRun(workspaceId: string, agentRunId: string, error: unknown) {
    return this.repos.agentRun.update(workspaceId, agentRunId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      completedAt: timestamp(),
    });
  }

  async logAgentRun<T>(input: AgentRunServiceInput, handler: () => Promise<T>) {
    const run = await this.startAgentRun(input);
    try {
      const output = await handler();
      await this.completeAgentRun(run.workspaceId, run.id, { result: output as JsonRecord });
      return output;
    } catch (error) {
      await this.failAgentRun(run.workspaceId, run.id, error);
      throw error;
    }
  }
}

function normalizeAgentName(agentName: string) {
  return AGENT_NAMES.includes(agentName as (typeof AGENT_NAMES)[number]) ? agentName : agentName;
}
