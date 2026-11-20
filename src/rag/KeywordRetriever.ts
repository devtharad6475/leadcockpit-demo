import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Retriever, RetrieveOptions } from "./Retriever";

export class KeywordRetriever implements Retriever {
  constructor(private readonly repos: RepositoryBundle = createRepositories()) {}

  retrieve(workspaceId: string, query: string, options: RetrieveOptions = {}) {
    return this.repos.knowledgeBaseChunk.searchByKeyword(workspaceId, query, options.limit || 5);
  }
}

