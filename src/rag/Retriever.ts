import type { KnowledgeBaseChunk } from "@/lib/types";

export type RetrievalResult = Array<KnowledgeBaseChunk & { score: number; documentTitle?: string }>;

export type RetrieveOptions = {
  limit?: number;
};

export interface Retriever {
  retrieve(workspaceId: string, query: string, options?: RetrieveOptions): Promise<RetrievalResult>;
}

