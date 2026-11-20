import type { RetrievalResult, Retriever } from "./Retriever";

export class EmbeddingRetriever implements Retriever {
  async retrieve(): Promise<RetrievalResult> {
    throw new Error("Embedding retrieval is not implemented in the MVP. Use KeywordRetriever until vector storage is added.");
  }
}

