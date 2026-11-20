/**
 * golden-repo-filter-parity.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * On the live Postgres deployment the Settings → Conflicts tab kept a red "5"
 * badge and kept rendering five review cards after all five had been resolved.
 * The same build on the JSON substrate showed zero.
 *
 * StructuredSettings.tsx asks for open conflicts only:
 *
 *     api("/api/settings/conflicts?status=open")
 *
 * the route forwards it:
 *
 *     repos.settingsConflict.listByWorkspace(workspaceId, { status, settingsArea })
 *
 * the interface declares it:
 *
 *     listByWorkspace(workspaceId, filters?: { status?; settingsArea? })
 *
 * and the JSON repository honours it. The Prisma one was written
 * `listByWorkspace(workspaceId: string)` — the second argument simply had
 * nowhere to land, so Postgres returned every conflict ever created and
 * TypeScript never said a word: a method that accepts fewer parameters than its
 * interface declares is assignable, by design.
 *
 * That is the shape of the whole bug family this session kept finding — the
 * Prisma path quietly disagreeing with the JSON path, while a golden suite that
 * runs on JSON stays green. So this golden checks BOTH substrates behave the
 * same, and then checks the source of both repositories for the structural
 * fault that made it possible, because a behavioural test can only cover the
 * repository someone remembered to write a test for.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — filtering by status returns only that status. Three conflicts,
 *   one resolved, one ignored, one open → `{ status: "open" }` yields exactly
 *   the open one. This is the badge count.
 *
 *   CASE B — filtering by settingsArea narrows to that area, and the two
 *   filters compose.
 *
 *   CASE C — no filters still returns everything. The resolved-conflict
 *   history has to remain readable.
 *
 *   CASE D — STRUCTURAL. Every repository method whose interface declares an
 *   optional filter object must accept that parameter in BOTH the Prisma and
 *   the JSON implementation. This is the check that would have caught the
 *   original defect: it was invisible behaviourally on the substrate the
 *   goldens run on.
 *
 *   CASE E — STRUCTURAL. Accepting the parameter is not using it. Every key
 *   the filter object declares must be read in the method body, so a filter
 *   cannot be silently half-applied.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { readSource } from "./_helpers/read-source";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_filterparity_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function seedThree(repos: ReturnType<typeof createJsonRepos>, ws: string) {
  const open = await repos.settingsConflict.create(ws, {
    settingsArea: "policy", fieldKey: "paymentPolicy",
    existingValue: "", extractedValue: "Net-30", extractedSource: "golden", status: "open",
  });
  const resolved = await repos.settingsConflict.create(ws, {
    settingsArea: "sales", fieldKey: "defaultMOQ",
    existingValue: "100", extractedValue: "200", extractedSource: "golden", status: "resolved",
  });
  const ignored = await repos.settingsConflict.create(ws, {
    settingsArea: "policy", fieldKey: "returnPolicy",
    existingValue: "14 days", extractedValue: "30 days", extractedSource: "golden", status: "ignored",
  });
  return { open, resolved, ignored };
}

test("CASE A — `status: open` returns only the open conflict (this is the badge count)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  const { open } = await seedThree(repos, WS);

  const rows = await repos.settingsConflict.listByWorkspace(WS, { status: "open" });
  assert.strictEqual(rows.length, 1, `three conflicts, one open — got ${rows.length}. On Postgres this returned 3 and the badge read "5" over an empty queue`);
  assert.strictEqual(rows[0].id, open.id);
});

test("CASE B — settingsArea narrows, and the two filters compose", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  await seedThree(repos, WS);

  const policy = await repos.settingsConflict.listByWorkspace(WS, { settingsArea: "policy" });
  assert.strictEqual(policy.length, 2, `two policy conflicts, got ${policy.length}`);

  const both = await repos.settingsConflict.listByWorkspace(WS, { settingsArea: "policy", status: "open" });
  assert.strictEqual(both.length, 1, `one open policy conflict, got ${both.length}`);
  assert.strictEqual(both[0].fieldKey, "paymentPolicy");
});

test("CASE C — no filters still returns the whole history", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  await seedThree(repos, WS);
  const all = await repos.settingsConflict.listByWorkspace(WS);
  assert.strictEqual(all.length, 3, "resolved and ignored conflicts stay readable when nothing is filtered");
});

// --- STRUCTURAL ---------------------------------------------------------------
// A behavioural test can only cover the substrate it runs on, and this defect
// existed only on the other one. These two parse both repositories instead.

type Impl = { cls: string; body: string };

function classesByInterface(source: string): Map<string, Impl> {
  const out = new Map<string, Impl>();
  const re = /^export class (\w+) implements (\w+)/gm;
  const starts: Array<{ cls: string; iface: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) starts.push({ cls: m[1], iface: m[2], at: m.index });
  starts.forEach((s, i) => {
    out.set(s.iface, { cls: s.cls, body: source.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : source.length) });
  });
  return out;
}

/** Interface methods that declare an optional filter/options object. */
function filteredMethods(source: string): Array<{ iface: string; method: string; params: string }> {
  const found: Array<{ iface: string; method: string; params: string }> = [];
  const ifaceRe = /^export interface (\w+Repository) \{([\s\S]*?)\n\}/gm;
  let i: RegExpExecArray | null;
  while ((i = ifaceRe.exec(source))) {
    const methodRe = /^ {2}(\w+)\(([^\n]*?)\):\s*Promise</gm;
    let m: RegExpExecArray | null;
    while ((m = methodRe.exec(i[2]))) {
      if (/\w+\?:\s*\{/.test(m[2])) found.push({ iface: i[1], method: m[1], params: m[2] });
    }
  }
  return found;
}

function implSignature(impl: Impl, method: string): string | undefined {
  const m = impl.body.match(new RegExp(`\\n {2}(?:async )?${method}\\(([^)]*)\\)`));
  return m ? m[1] : undefined;
}

function paramCount(params: string): number {
  const trimmed = params.trim();
  if (!trimmed) return 0;
  // Split on commas that are not inside an inline object type.
  return trimmed.split(/,(?![^{]*\})/).length;
}

test("CASE D — every declared filter parameter is accepted by BOTH repositories", async () => {
  const interfaces = readSource("src/repositories/interfaces.ts");
  const prisma = classesByInterface(readSource("src/repositories/prisma/index.ts"));
  const json = classesByInterface(readSource("src/repositories/json/index.ts"));

  const methods = filteredMethods(interfaces);
  assert.ok(methods.length >= 9, `expected the known filtered methods to still be found, got ${methods.length} — this golden's source parse needs updating`);
  assert.ok(
    methods.some((m) => m.iface === "SettingsConflictRepository" && m.method === "listByWorkspace"),
    "the method this defect was found in must be among them",
  );

  const dropped: string[] = [];
  for (const { iface, method, params } of methods) {
    const declared = paramCount(params);
    for (const [label, map] of [["prisma", prisma], ["json", json]] as const) {
      const impl = map.get(iface);
      assert.ok(impl, `no ${label} class implements ${iface}`);
      const sig = implSignature(impl!, method);
      assert.ok(sig !== undefined, `could not locate ${label} ${impl!.cls}.${method}() — this golden's source parse needs updating`);
      if (paramCount(sig!) < declared) {
        dropped.push(`${impl!.cls}.${method}(${sig}) accepts ${paramCount(sig!)} of ${declared} declared parameters [${label}]`);
      }
    }
  }
  assert.deepStrictEqual(
    dropped,
    [],
    `a method that accepts fewer parameters than its interface declares still type-checks, and silently ignores every argument past the last one it names:\n  ${dropped.join("\n  ")}`,
  );
});

test("CASE E — every declared filter key is actually read in the method body", async () => {
  const ignored: string[] = [];
  for (const file of ["src/repositories/prisma/index.ts", "src/repositories/json/index.ts"]) {
    const source = readSource(file);
    const re = /\n {2}(?:async )?(\w+)\((?:[^)]*?)filters[?:][^)]*\{([^)]*)\}[^)]*\)\s*\{([\s\S]*?)\n {2}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const [, method, keyBlock, body] = m;
      const keys = [...keyBlock.matchAll(/(\w+)\??:/g)].map((k) => k[1]);
      for (const key of keys) {
        if (!new RegExp(`filters\\.${key}\\b`).test(body)) ignored.push(`${file} ${method}() never reads filters.${key}`);
      }
    }
  }
  assert.deepStrictEqual(ignored, [], `a filter key that is accepted but never read is the same defect wearing a correct signature:\n  ${ignored.join("\n  ")}`);
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-repo-filter-parity — N-BUG (a filter the caller passes must reach the query, on BOTH substrates)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`repo-filter-parity: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
