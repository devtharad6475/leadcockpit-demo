import { createJsonRepositories } from "./json";
import { createPrismaRepositories } from "./prisma";
import type { RepositoryBundle } from "./interfaces";

export type { RepositoryBundle } from "./interfaces";
export type PersistenceProvider = "json" | "prisma";

export function getPersistenceProvider(): PersistenceProvider {
  return process.env.PERSISTENCE_PROVIDER === "prisma" ? "prisma" : "json";
}

export function createRepositories(provider: PersistenceProvider = getPersistenceProvider()): RepositoryBundle {
  if (provider === "prisma") {
    return createPrismaRepositories();
  }

  return createJsonRepositories();
}

export const repositories = createRepositories();
