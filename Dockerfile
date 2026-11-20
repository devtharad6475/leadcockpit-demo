# syntax=docker/dockerfile:1.7
# Stage D.2 — Production Dockerfile for LeadCockpit.
#
# One image, three runtime roles (web / worker / scheduler) — selected by
# the docker-compose service's `command`. See docker-compose.yml.
#
# Multi-stage build:
#   1. deps   — install production + dev deps (full node_modules for build)
#   2. builder— prisma generate + next build → produces .next/standalone
#   runtime-deps — production libraries plus locked runtime CLI tools.
#   runner — standalone server + runtime dependencies, without npm caches.
#            Non-root user; no dependency installation in the final image.
#
# Locked decisions (D-2026-07-27-2):
#   - Built for Hetzner Cloud Mumbai (ap-south-1) VPS, x86_64.
#   - Node 20 LTS Alpine (small base; matches Next.js 16 requirements).
#   - Non-root runtime user (nextjs:nodejs) — security best practice.

# =============================================================================
# Stage 1: deps — install all dependencies (needed for build)
# =============================================================================
FROM node:20-alpine AS deps

# libc6-compat is required by some Next.js native deps on Alpine.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy only manifests first → better layer caching.
COPY package.json package-lock.json* ./

# Install ALL deps (including devDeps — we need them for the build).
RUN npm ci

# The worker/scheduler and migration entrypoint need tsx and Prisma even
# though they are development dependencies in the application manifest.
# Retain the production libraries as well as those two tools before pruning.
# Worker/scheduler source imports are not traced by the standalone web build;
# they need the complete production dependency graph (including adapter-pg).
# This keeps the lockfile-installed versions and root security overrides,
# without reinstalling the whole app over the bundle in large runner layers.
FROM deps AS runtime-deps
RUN node -e 'const fs=require("fs"); const p=require("./package.json"); p.dependencies={...p.dependencies,tsx:p.devDependencies.tsx,prisma:p.devDependencies.prisma}; p.devDependencies={}; fs.writeFileSync("package.json",JSON.stringify(p));' \
 && npm prune --omit=dev --offline --ignore-scripts \
 && npm cache clean --force

# =============================================================================
# Stage 2: builder — generate Prisma client + build Next.js
# =============================================================================
FROM node:20-alpine AS builder

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Disable telemetry during build (cleaner logs, no data sent to Vercel).
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time env: standalone build, production mode. The actual runtime
# secrets (DATABASE_URL etc.) are NOT needed at build time — Prisma generate
# uses a placeholder, Next build is independent of the DB.
# DATABASE_URL must still be set because prisma.config.ts reads it; we use
# the placeholder that prisma.config.ts already falls back to.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/leadgen_placeholder"
ENV PERSISTENCE_PROVIDER="json"
ENV AUTH_MODE="demo"
ENV NODE_ENV="production"

# Generate the Prisma client (writes to src/generated/prisma/*).
RUN npx prisma generate

# Build Next.js → produces .next/standalone/, .next/static/, .next/server/
RUN npm run build

# 2026-09-27 (CEO: the demo site runs on built-in sample data, no database).
# The sample company (scripts/seed-demo.ts) is built here, offline, into a
# template the runner copies on first start when PERSISTENCE_PROVIDER=json.
# .leadgen-data is never copied into the image; this file is generated fresh.
RUN LEADGEN_DATA_DIR=/app/demo-seed PLATFORM_DEEPSEEK_API_KEY= npx tsx scripts/seed-demo.ts --force

# Merge the web trace with the complete worker/scheduler libraries before the
# final copy. Two overlapping COPY layers retain both copies in the image even
# when files are identical. The merged stage preserves every runtime dependency
# while storing the shared packages only once in the final image.
FROM runtime-deps AS runtime-bundle
COPY --from=builder /app/.next/standalone ./
# Keep the runtime manifest/lock (including the locked CLI tools) after the
# web trace overlay. npm retains Next's optional testing peer even with dev
# dependencies omitted. That branch is not used by the production app.
COPY --from=runtime-deps /app/package.json /app/package-lock.json ./
RUN node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = require('./package.json');
const packages = require('./package-lock.json').packages;
const branch = ['@playwright/test', 'playwright', 'playwright-core'];
const next = require('./node_modules/next/package.json');
if (next.peerDependenciesMeta?.['@playwright/test']?.optional !== true
    || branch.some(name => root.dependencies?.[name])) {
  throw new Error('Browser-test branch is no longer an optional development dependency');
}
// Refuse trimming if another dependency starts using any branch member.
const allowed = new Set([
  'node_modules/next:peerDependencies:@playwright/test',
  'node_modules/@playwright/test:dependencies:playwright',
  'node_modules/playwright:dependencies:playwright-core',
]);
for (const [location, pkg] of Object.entries(packages)) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of branch) {
      if (pkg[field]?.[name] && !allowed.has(`${location}:${field}:${name}`)) {
        throw new Error(`Production dependency uses browser-test branch: ${location}:${name}`);
      }
    }
  }
}
for (const command of ['playwright', 'playwright-core']) {
  const bin = path.join('node_modules/.bin', command);
  if (fs.existsSync(bin) && fs.lstatSync(bin).isSymbolicLink()) {
    const target = path.resolve(path.dirname(bin), fs.readlinkSync(bin));
    if (branch.some(name => target.startsWith(path.resolve('node_modules', name) + path.sep))) fs.unlinkSync(bin);
  }
}
for (const name of branch) fs.rmSync(path.join('node_modules', name), { recursive: true, force: true });
console.log('Removed only the verified optional browser-test dependency branch');
NODE
# Dependency maps are diagnostic metadata, not executable libraries. Remove
# only recognized external v3 JavaScript maps before the final COPY; deleting
# them in the runner would leave their bytes in an earlier image layer.
# Application maps, JS/WASM/native code, PDF workers, fonts and licenses stay.
# Vendor stack frames remain available but lose optional source remapping.
RUN node -e 'const fs=require("node:fs"),path=require("node:path");let files=0,bytes=0;function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile() && /\.(?:js|mjs|cjs)\.map$/.test(entry.name)){let map;try{map=JSON.parse(fs.readFileSync(file,"utf8"));}catch{continue;}if(map && map.version===3 && Array.isArray(map.sources) && typeof map.mappings==="string"){bytes+=fs.statSync(file).size;fs.unlinkSync(file);files++;}}}}walk("node_modules");console.log("Removed dependency source-map metadata:",files,"files,",bytes,"bytes; executable files and application maps retained");'

# =============================================================================
# Stage 3: runner — minimal runtime image
# =============================================================================
FROM node:20-alpine AS runner

RUN apk add --no-cache libc6-compat wget

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user — security best practice. Next.js official images use this
# convention; we recreate it on Alpine.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Copy the merged server and full runtime dependency graph in one layer.
COPY --from=runtime-bundle --chown=nextjs:nodejs /app ./
# Static assets are NOT in standalone — copy separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Public folder (favicon, robots.txt, etc.) — copy if present.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma migrations — needed for `prisma migrate deploy` at deploy time.
# (The generated Prisma client is already in .next/standalone/node_modules
# because Next.js traces the import. But the migrations folder is not traced.)
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# Entrypoint scripts for the worker + scheduler roles. The web role uses
# the standalone server.js directly (no script needed).
# These TypeScript entrypoints run independently of the web bundle and
# require their source imports and path aliases, including lazy imports.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --chown=nextjs:nodejs scripts/worker-entrypoint.ts ./scripts/worker-entrypoint.ts
COPY --chown=nextjs:nodejs scripts/scheduler-entrypoint.ts ./scripts/scheduler-entrypoint.ts

# Runtime agent + policy files (loaded at runtime by AgentInstructionLoader).
# These are not JS-traceable (they're .md files read via fs at runtime).
COPY --chown=nextjs:nodejs agents ./agents
COPY --chown=nextjs:nodejs policies ./policies

# 2026-09-17 (session 56): the PDF worker. `extractTextFromBuffer` hands
# pdf-parse this file by PATH (process.cwd()/node_modules/pdfjs-dist/legacy/
# build/pdf.worker.mjs) instead of importing it, so standalone tracing never
# copies it — and under Turbopack `outputFileTracingIncludes` did not add it
# either (verified: absent from the image). Without it every PDF upload failed
# with "Cannot find module .../pdf.worker.mjs" and the screen blamed the user's
# file. The worker is a single self-contained bundle; pdf-parse 2.4.5 and
# pdfjs-dist 5.4.296 are the pair in package-lock. Copied after the CLI tools
# so the worker remains present at the exact runtime path.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs ./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs

# Migrations run before the server starts. See scripts/docker-entrypoint.sh —
# it applies them only on the Prisma substrate, and fails the boot rather than
# serving traffic against a schema this build does not match.
COPY --chown=nextjs:nodejs scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
# The sample-data template for the JSON demo (see the builder stage).
COPY --from=builder --chown=nextjs:nodejs /app/demo-seed/app-data.json ./demo-seed/app-data.json
RUN chmod +x ./scripts/docker-entrypoint.sh

USER nextjs

EXPOSE 3000

# Default command = web role. docker-compose.yml overrides this for worker
# and scheduler services.
CMD ["./scripts/docker-entrypoint.sh"]
