import "../golden/_helpers/isolate-standalone";
import { createJsonRepos } from "../golden/_helpers/provider";
import { MIGRATION_RULES } from "@/migration/migration-rules";

(async () => {
  const repos = createJsonRepos();
  const ws = `ws_rules_${Date.now()}`;
  await repos.workspace.create({ id: ws, name: "rules probe", status: "active" });
  const snap = (await repos.readAll?.()) || {};
  const keys = Object.keys(snap).filter((k) => Array.isArray((snap as Record<string, unknown>)[k]));
  const missing = keys.filter((k) => !(k in MIGRATION_RULES));
  console.log("collections in snapshot:", keys.length);
  console.log("declared in MIGRATION_RULES:", Object.keys(MIGRATION_RULES).length);
  console.log("MISSING RULE:", JSON.stringify(missing, null, 1));
})();
