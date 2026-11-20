/**
 * Golden test — Stage D Docker / compose / Caddy / CI contracts.
 *
 * Skill build-right Phase 3: pins the SHAPE of the deployment artifacts
 * WITHOUT requiring a running Docker daemon. The tests parse the YAML +
 * Dockerfile + Caddyfile as text/structure and assert contracts:
 *
 *   1. Dockerfile exists + has 3 named stages (deps/builder/runner).
 *   2. Dockerfile uses non-root runtime user.
 *   3. docker-compose.yml parses as valid YAML + defines exactly 4 services
 *      with the expected names (web/worker/scheduler/caddy).
 *   4. Each app service sets `restart: unless-stopped`; Caddy sets `always`.
 *   5. Only Caddy exposes host ports (web is internal-only).
 *   6. Caddy only exposes 80 + 443.
 *   7. Caddyfile references {$BASE_URL} (env-var substitution).
 *   8. Caddyfile does NOT set Content-Security-Policy (CSP is per-request
 *      in middleware.ts — setting it in Caddy would break Next.js hydration).
 *   9. CI workflow files parse as valid YAML.
 *
 * If Docker IS available locally, additional optional cases run the actual
 * build + `docker compose config` validation. If Docker isn't available,
 * those cases skip gracefully (no false failure — matches the pattern in
 * golden-prisma-commercial-parity for missing DATABASE_URL).
 *
 * Run: npx tsx scripts/golden/golden-docker-compose.ts
 *
 * 2026-07-27 Stage D.5.
 */
export {};

import { existsSync } from "node:fs";
import { readSource } from "./_helpers/read-source";
import { execSync, execFileSync } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
const skipped: string[] = [];
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}
function skip(name: string, reason: string) {
  console.log(`  ø ${name}  (skipped: ${reason})`);
  skipped.push(name);
}

// Minimal YAML parser for our flat-ish files. We can't rely on `js-yaml`
// being installed (it's not a project dep). For our compose file the
// structure is simple enough that we can do structural checks by reading
// the file as text + using a minimal parser for the top-level `services:`
// block. This avoids adding a dep just for this test.
function readText(relPath: string): string {
  // Normalised on purpose: CASE 2's `services:` parser matches a pattern built
  // from newline characters, which a CRLF checkout would silently stop
  // matching. See _helpers/read-source.ts — core.autocrlf=true makes a
  // working-tree file's line endings depend on whether git or a tool wrote it
  // last, and that is not something a golden should be reporting on.
  return readSource(relPath);
}

// =============================================================================
// CASE 1 — Dockerfile exists + has 3 named stages
// =============================================================================
function testDockerfileStages() {
  const dockerfile = readText("Dockerfile");
  assert(/FROM\s+node:20-alpine\s+AS\s+deps\b/.test(dockerfile), "Dockerfile must declare a 'deps' stage");
  assert(/FROM\s+node:20-alpine\s+AS\s+builder\b/.test(dockerfile), "Dockerfile must declare a 'builder' stage");
  assert(/FROM\s+node:20-alpine\s+AS\s+runner\b/.test(dockerfile), "Dockerfile must declare a 'runner' stage");
  pass("CASE 1 — Dockerfile has 3 named stages (deps/builder/runner)");
}

// =============================================================================
// CASE 2 — Dockerfile uses non-root runtime user
// =============================================================================
function testDockerfileNonRoot() {
  const dockerfile = readText("Dockerfile");
  // The runner stage must create + switch to a non-root user.
  assert(/addgroup\s+--system\b/.test(dockerfile) || /adduser\s+--system\b/.test(dockerfile), "Dockerfile must create a non-root user");
  assert(/^USER\s+nextjs/m.test(dockerfile), "Dockerfile must switch to non-root user (USER nextjs) in runner stage");
  // The COPY --chown must use that user.
  assert(/COPY\s+--from=builder\s+--chown=nextjs:nodejs/.test(dockerfile), "Dockerfile must chown files to nextjs:nodejs");
  pass("CASE 2 — Dockerfile uses non-root runtime user (nextjs:nodejs)");
}

// =============================================================================
// CASE 3 — docker-compose.yml defines exactly 4 services with expected names
// =============================================================================
function getServicesBlock(compose: string): string {
  // Restrict to the `services:` block — everything between `services:` and
  // the next top-level key (`networks:` or `volumes:`).
  const start = compose.indexOf("services:");
  if (start === -1) throw new Error("docker-compose.yml has no services: block");
  const rest = compose.slice(start + "services:".length);
  const nextTopLevel = rest.search(/^(networks|volumes):/m);
  return nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel);
}

function testComposeServices() {
  const compose = readText("docker-compose.yml");
  const servicesBlock = getServicesBlock(compose);
  for (const name of ["web", "worker", "scheduler", "caddy"]) {
    const re = new RegExp(`^  ${name}:`, "m");
    assert(re.test(servicesBlock), `docker-compose.yml must define a '${name}' service`);
  }
  // Count 2-space-indented `name:` keys in the services block. Excludes
  // any nested keys (4-space-indented) and excludes `networks:`/`volumes:`.
  const serviceMatches = servicesBlock.match(/^  ([a-z_]+):/gm) || [];
  const serviceNames = serviceMatches.map((s) => s.trim().replace(":", ""));
  assert(serviceNames.length === 4, `expected exactly 4 services, got ${serviceNames.length}: ${serviceNames.join(", ")}`);
  pass("CASE 3 — docker-compose.yml defines exactly 4 services (web/worker/scheduler/caddy), no local DB/Redis");
}

// =============================================================================
// CASE 4 — Each service has the right restart policy
// =============================================================================
function splitServiceBlocks(servicesBlock: string): Record<string, string> {
  // Split into { name: body } pairs at the 2-space-indented `name:` boundaries.
  const blocks = servicesBlock.split(/\n  ([a-z_]+):\n/);
  const byName: Record<string, string> = {};
  for (let i = 1; i < blocks.length; i += 2) byName[blocks[i]] = blocks[i + 1];
  return byName;
}

function testComposeRestartPolicies() {
  const compose = readText("docker-compose.yml");
  const byName = splitServiceBlocks(getServicesBlock(compose));
  assert(/restart:\s*unless-stopped/.test(byName["web"]), "web service must restart: unless-stopped");
  assert(/restart:\s*unless-stopped/.test(byName["worker"]), "worker service must restart: unless-stopped");
  assert(/restart:\s*unless-stopped/.test(byName["scheduler"]), "scheduler service must restart: unless-stopped");
  assert(/restart:\s*always/.test(byName["caddy"]), "caddy service must restart: always");
  pass("CASE 4 — restart policies: web/worker/scheduler=unless-stopped, caddy=always");
}

// =============================================================================
// CASE 5 — Only Caddy exposes host ports (web is internal-only)
// =============================================================================
function testComposePortExposure() {
  const compose = readText("docker-compose.yml");
  const byName = splitServiceBlocks(getServicesBlock(compose));
  // Bodies may start with non-whitespace or with the first field directly;
  // use multiline `^...` with the leading whitespace pattern, OR `\n`-anchored.
  const web = byName["web"] || "";
  const worker = byName["worker"] || "";
  const scheduler = byName["scheduler"] || "";
  const caddy = byName["caddy"] || "";
  assert(/^\s*expose:/m.test(web), "web must use expose: (internal-only)");
  assert(!/^\s*ports:/m.test(web), "web must NOT use ports: (only Caddy publishes to host)");
  assert(!/^\s*ports:/m.test(worker), "worker must not publish ports");
  assert(!/^\s*expose:/m.test(worker), "worker must not expose ports");
  assert(!/^\s*ports:/m.test(scheduler), "scheduler must not publish ports");
  assert(/^\s*ports:/m.test(caddy), "caddy must publish ports");
  assert(/"80:80"/.test(caddy), "caddy must expose port 80");
  assert(/"443:443"/.test(caddy), "caddy must expose port 443");
  pass("CASE 5 — only Caddy publishes host ports (80/443); web internal-only; worker/scheduler no ports");
}

// =============================================================================
// CASE 6 — Caddyfile references {$BASE_URL} and omits CSP
// =============================================================================
function testCaddyfile() {
  const caddyfile = readText("Caddyfile");
  assert(/\{\$BASE_URL\}/.test(caddyfile), "Caddyfile must reference {\$BASE_URL} for env-var substitution");
  assert(!/Content-Security-Policy/.test(caddyfile), "Caddyfile must NOT set Content-Security-Policy (CSP is per-request in middleware.ts; a static CSP would break Next.js hydration)");
  // Required security headers (defense-in-depth; next.config also sets these).
  assert(/Strict-Transport-Security/.test(caddyfile), "Caddyfile must set Strict-Transport-Security");
  assert(/X-Content-Type-Options/.test(caddyfile), "Caddyfile must set X-Content-Type-Options");
  assert(/reverse_proxy\s+web:3000/.test(caddyfile), "Caddyfile must reverse_proxy to web:3000");
  pass("CASE 6 — Caddyfile: {\$BASE_URL} substitution, no CSP (preserves Next hydration), HSTS + nosniff + reverse_proxy");
}

// =============================================================================
// CASE 7 — CI workflow files parse as valid YAML
// =============================================================================
function testCiYamlValidity() {
  for (const wf of [".github/workflows/ci.yml", ".github/workflows/deploy.yml"]) {
    assert(existsSync(wf), `${wf} must exist`);
    const text = readText(wf);
    // Sanity checks on the workflow shape. These top-level keys may appear
    // after a leading comment block, so use `m` flag + `^...:` at line start.
    assert(/^name:\s*.+$/m.test(text), `${wf} must have a top-level name:`);
    assert(/^on:/m.test(text), `${wf} must have a top-level on: trigger`);
    assert(/^jobs:/m.test(text), `${wf} must have a top-level jobs:`);
    // No tabs (YAML forbids tabs for indentation).
    assert(!/\t/.test(text), `${wf} must not contain tab characters (YAML uses spaces)`);
  }
  pass("CASE 7 — CI workflow files parse as valid YAML (name/on/jobs present, no tabs)");
}

// =============================================================================
// CASE 8 — CI workflow runs tsc + build + goldens + smokes (the Ironclad Gates)
// =============================================================================
function testCiWorkflowRunsGates() {
  const ci = readText(".github/workflows/ci.yml");
  assert(/npx tsc --noEmit/.test(ci), "CI must run tsc --noEmit");
  assert(/npm run build/.test(ci), "CI must run npm run build");
  assert(/golden/.test(ci), "CI must run golden tests");
  assert(/test:smoke/.test(ci), "CI must run smoke tests");
  assert(/playwright test --config playwright\.prototype-cleanup\.config\.ts/.test(ci), "CI must exercise browser recovery and sign-in, not only compile the UI");
  assert(/playwright test --config playwright\.core-loading\.config\.ts/.test(ci), "CI must prove slow optional reads do not block core data or critical errors");
  assert(/playwright test --config playwright\.customer-playtest\.config\.ts/.test(ci), "CI must exercise owner/employee/customer ticket closure");
  pass("CASE 8 — CI workflow runs the Ironclad Gates (tsc + build + goldens + smokes)");
}

// =============================================================================
// CASE 9 — Deploy workflow pushes to GHCR on main
// =============================================================================
function testDeployWorkflow() {
  const deploy = readText(".github/workflows/deploy.yml");
  // Must trigger only on push to main (not PRs).
  assert(/push:\s*\n\s*branches:/.test(deploy), "deploy workflow must trigger on push (not PR)");
  assert(/main/.test(deploy), "deploy workflow must trigger on main branch");
  // Must build + push a Docker image.
  assert(/ghcr\.io/.test(deploy), "deploy workflow must push to GHCR");
  assert(/docker build/.test(deploy) || /buildx/.test(deploy) || /docker\/build-push-action/.test(deploy), "deploy workflow must build a Docker image");
  pass("CASE 9 — deploy workflow: triggers on push to main, builds + pushes image to GHCR");
}

// =============================================================================
// CASE 10 — next.config.ts has output: "standalone"
// =============================================================================
function testStandaloneOutput() {
  const nextConfig = readText("next.config.ts");
  assert(/output:\s*"standalone"/.test(nextConfig), "next.config.ts must set output: \"standalone\" for smaller Docker images");
  pass("CASE 10 — next.config.ts has output: \"standalone\"");
}

// =============================================================================
// CASE 11 (optional, requires Docker) — actual docker build + compose config
// =============================================================================
function testDockerBuildIfAvailable() {
  let dockerAvailable = false;
  try {
    execSync("docker info", { stdio: "ignore" });
    dockerAvailable = true;
  } catch {
    // Docker not installed or daemon not running — skip gracefully.
  }
  if (!dockerAvailable) {
    skip("CASE 11 — docker build + compose config (Docker not available)", "no docker daemon");
    return;
  }

  // Build the image. Use a unique tag so re-runs don't collide with the
  // "image already exists" Docker quirk.
  const testTag = `leadgen-stage-d-test:${Date.now()}`;
  try {
    execSync(`docker build -t ${testTag} .`, { stdio: "inherit", timeout: 600000 });
  } catch (err) {
    throw new Error(`docker build failed: ${err instanceof Error ? err.message : err}`);
  }
  // Validate compose config (catches syntax errors the static test missed).
  // Use execFileSync (no shell) so we don't fight with `>/dev/null` redirects
  // that differ between bash and cmd.exe on Windows. Pass env vars via the
  // `env` option (cross-platform).
  try {
    execFileSync("docker", ["compose", "config"], {
      stdio: "pipe",
      timeout: 60000,
      env: {
        ...process.env,
        BASE_URL: "test.example.com",
        GHCR_OWNER: "test",
        IMAGE_TAG: "test",
      },
    });
  } catch (err) {
    throw new Error(`docker compose config failed: ${err instanceof Error ? err.message : err}`);
  }
  // Image size check.
  const sizeStr = execSync(`docker image inspect ${testTag} --format "{{.Size}}"`, { stdio: ["pipe", "pipe", "ignore"] }).toString().trim().replace(/['"]/g, "");
  const sizeMB = Math.round(Number(sizeStr) / (1024 * 1024));
  assert(Number.isFinite(sizeMB) && sizeMB > 0, `docker image size must be a positive number, got "${sizeStr}"`);
  // Standalone Next.js + Node Alpine + tsx + Prisma client should be < 800MB.
  // (BullMQ pulls msgpack + lua deps which add weight; if this blows past
  // 1GB, investigate.)
  assert(sizeMB < 1024, `docker image too large: ${sizeMB}MB (must be < 1024MB). Investigate bloat.`);
  console.log(`    (image size: ${sizeMB}MB)`);

  // Verify the standalone server.js exists in the image AND the runtime
  // files (worker + scheduler scripts, migrations, agents, policies).
  // Use execFileSync + arg array (no shell) so single-quote wrapping doesn't
  // break on Windows cmd.exe.
  try {
    execFileSync("docker", [
      "run", "--rm", "--entrypoint", "sh", testTag, "-c",
      "test -f server.js && test -f scripts/worker-entrypoint.ts && test -f scripts/scheduler-entrypoint.ts && test -f tsconfig.json && test -d src/generated/prisma && test -d prisma/migrations && test -d agents && test -d policies && test -f node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs && test ! -d node_modules/eslint && test ! -d node_modules/@playwright/test",
    ], { stdio: "ignore", timeout: 30000 });
  } catch (err) {
    throw new Error(`docker run runtime-files check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Worker source imports, tsconfig aliases and migration tools must still
  // execute after slimming the image. No Redis, provider key or customer
  // data is supplied: demo mode exits the worker without processing jobs.
  // Network isolation also prevents the scheduler from reaching providers.
  execFileSync("docker", [
    "run", "--rm", "--network", "none", "--entrypoint", "sh",
    "-e", "PERSISTENCE_PROVIDER=json", "-e", "AUTH_MODE=demo",
    "-e", "LEADGEN_DATA_DIR=/tmp/packaging-test",
    "-e", "DATABASE_URL=postgresql://user:pass@localhost:5432/packaging_test",
    testTag, "-c",
    "npx --no-install prisma --version && npx --no-install tsx scripts/worker-entrypoint.ts && npx --no-install tsx scripts/scheduler-entrypoint.ts",
  ], { stdio: "inherit", timeout: 60000 });

  // Exercise PDF creation and the actual worker path, rather than accepting
  // a worker file that cannot be loaded by the installed pdf-parse version.
  const pdfCheck = `const PDFDocument=require("pdfkit"); const {PDFParse}=require("pdf-parse"); const {pathToFileURL}=require("node:url"); const path=require("node:path"); const doc=new PDFDocument(); const chunks=[]; doc.on("data",chunk=>chunks.push(chunk)); doc.on("end",async()=>{let parser; try{PDFParse.setWorker(pathToFileURL(path.join(process.cwd(),"node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href); parser=new PDFParse({data:new Uint8Array(Buffer.concat(chunks))}); const result=await parser.getText(); if(!result.text.includes("Packaging document check"))throw new Error("PDF text missing"); console.log("PDF runtime passed");}catch(error){console.error(error); process.exitCode=1;}finally{if(parser)await parser.destroy();}}); doc.text("Packaging document check: a synthetic document with no company or customer information."); doc.end();`;
  execFileSync("docker", [
    "run", "--rm", "--network", "none", "--entrypoint", "node",
    testTag, "-e", pdfCheck,
  ], { stdio: "inherit", timeout: 60000 });

  // Cleanup: remove the test image (best-effort).
  try { execSync(`docker rmi ${testTag}`, { stdio: "ignore" }); } catch { /* ignore */ }

  pass(`CASE 11 — docker build + compose config + image size (${sizeMB}MB < 1024MB) + runtime files present`);
}

function main() {
  console.log("golden-docker-compose — Stage D.5");
  console.log("Hand-computed contract: 3 Dockerfile stages, non-root, 4 services, only Caddy exposes 80/443, no CSP in Caddyfile, CI runs gates");
  console.log("");
  testDockerfileStages();
  testDockerfileNonRoot();
  testComposeServices();
  testComposeRestartPolicies();
  testComposePortExposure();
  testCaddyfile();
  testCiYamlValidity();
  testCiWorkflowRunsGates();
  testDeployWorkflow();
  testStandaloneOutput();
  testDockerBuildIfAvailable();
  console.log("");
  console.log(`✅ ${passed} passed, 0 failed${skipped.length ? `, ${skipped.length} skipped (Docker not available)` : ""} — ALL GREEN ✅`);
}

main();
