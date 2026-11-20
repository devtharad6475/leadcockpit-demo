/**
 * probe-user-identity.ts — read-only. Compares the owner user row on both
 * substrates and checks what the login credential is keyed on, because the
 * migration plan wants to overwrite `users/user_owner` while deliberately
 * NOT migrating `userCredentials`. If login resolves by email and the two
 * disagree, that overwrite locks the demo account out.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { readData } from "@/lib/db";

async function main() {
  const json = (await readData()) as any;
  const { createRepositories } = await import("@/repositories");
  const pg = await createRepositories().readAll!() as any;

  const show = (label: string, u: any) =>
    console.log(`${label.padEnd(10)} id=${u?.id} email=${u?.email} name=${JSON.stringify(u?.name)} role=${u?.role} ws=${u?.workspaceId} createdAt=${u?.createdAt}`);

  console.log("=== users ===");
  for (const u of json.users ?? []) show("JSON", u);
  for (const u of pg.users ?? []) show("POSTGRES", u);

  console.log("\n=== userCredentials (email + linkage only, never the hash) ===");
  for (const c of json.userCredentials ?? [])
    console.log(`JSON       id=${c.id} email=${c.email} userId=${c.userId} ws=${c.workspaceId} hash=<${String(c.passwordHash ?? "").length} chars, not printed>`);
  for (const c of pg.userCredentials ?? [])
    console.log(`POSTGRES   id=${c.id} email=${c.email} userId=${c.userId} ws=${c.workspaceId} hash=<${String(c.passwordHash ?? "").length} chars, not printed>`);

  console.log("\n=== workspaceMembers ===");
  for (const m of json.workspaceMembers ?? []) console.log(`JSON       ${m.id} user=${m.userId} ws=${m.workspaceId} role=${m.role} status=${m.status}`);
  for (const m of pg.workspaceMembers ?? []) console.log(`POSTGRES   ${m.id} user=${m.userId} ws=${m.workspaceId} role=${m.role} status=${m.status}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
