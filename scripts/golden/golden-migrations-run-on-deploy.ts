/**
 * Golden test — a deploy applies its own migrations, and refuses to serve
 * traffic if it cannot.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * The image ran `CMD ["node", "server.js"]`. Nothing else. So Prisma
 * migrations never ran on deploy, on any environment, and every schema change
 * depended on somebody remembering to apply it by hand against the right
 * database at the right moment.
 *
 * That had already gone wrong: `20260908090000_order_quote_lead_optional`
 * (dropping NOT NULL from `orders.lead_id` and `quotes.lead_id`) was sitting
 * unapplied against the live demo database while the code that needs those
 * columns nullable was deployed and running. Production had the same gap. The
 * deploy reported success; the mismatch only shows up when a customer takes
 * the path that touches the column.
 *
 * The CLI could not have run even if something had called it: `prisma` is a
 * devDependency, and the Next.js standalone output does not carry it, so
 * `prisma migrate deploy` was not present in the runtime image at all.
 *
 *   CASE A — the container does not boot straight into the server. Something
 *     runs first.
 *
 *   CASE B — that something applies migrations with `migrate deploy`, the one
 *     Prisma command that only applies already-committed migrations. `migrate
 *     dev` generates and can reset; `db push` skips the migration history
 *     entirely. Neither belongs on a production boot.
 *
 *   CASE C — a failed migration FAILS THE BOOT. Serving traffic against a
 *     schema the build does not match is the outcome this whole change exists
 *     to prevent, and a migration step that logs an error and carries on would
 *     reintroduce it while looking like a fix.
 *
 *   CASE D — the Prisma CLI is actually present in the runtime image. Without
 *     it the entrypoint is a script that cannot do its job.
 *
 *   CASE E — migrations are skipped on the JSON substrate, which has no
 *     database, and a Prisma deploy with no DATABASE_URL stops rather than
 *     silently starting with nothing configured.
 *
 *   CASE F — the entrypoint keeps LF line endings. This repo is developed on
 *     Windows with core.autocrlf=true, and a CRLF shebang fails inside the
 *     container as "no such file or directory" — a long way from its cause.
 *
 * Substrate: static read of the Dockerfile, the entrypoint and .gitattributes.
 * No repository, no network, no AI, no Docker daemon.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const DOCKERFILE = "Dockerfile";
const ENTRYPOINT = "scripts/docker-entrypoint.sh";
const GITATTRIBUTES = ".gitattributes";

function main() {
  console.log("=== GOLDEN: a deploy applies its own migrations ===\n");

  const dockerfile = readSource(DOCKERFILE);
  const entrypoint = readSource(ENTRYPOINT);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      !/CMD \["node", "server\.js"\]/.test(dockerfile),
      `CASE A: ${DOCKERFILE} boots straight into the server, so nothing applies migrations on deploy`,
    );
    assert(
      /CMD \["\.\/scripts\/docker-entrypoint\.sh"\]/.test(dockerfile),
      `CASE A: ${DOCKERFILE} must boot through the entrypoint that applies migrations`,
    );
    assert(
      /COPY .*scripts\/docker-entrypoint\.sh/.test(dockerfile),
      `CASE A: the entrypoint is never copied into the image`,
    );
    assert(
      /exec node server\.js/.test(entrypoint),
      `CASE A: ${ENTRYPOINT} must still hand off to the server (exec, so signals reach it)`,
    );
    console.log("✅ CASE A — the container runs the entrypoint, which then runs the server");
  }

  // ---------------------------------------------------------------- CASE B
  {
    assert(
      /prisma migrate deploy/.test(entrypoint),
      `CASE B: ${ENTRYPOINT} does not apply migrations`,
    );
    for (const forbidden of ["migrate dev", "migrate reset", "db push"]) {
      assert(
        !new RegExp(forbidden).test(entrypoint),
        `CASE B: ${ENTRYPOINT} uses "${forbidden}" on a production boot — it can generate or destroy, which migrate deploy cannot`,
      );
    }
    console.log("✅ CASE B — migrate deploy only: never dev, reset or db push");
  }

  // ---------------------------------------------------------------- CASE C
  {
    assert(/set -e/.test(entrypoint), `CASE C: ${ENTRYPOINT} does not stop on error`);
    // The failure branch must leave, not fall through to the server.
    const failureBranch = entrypoint.slice(entrypoint.indexOf("Migration failed"));
    assert(
      /exit 1/.test(failureBranch),
      `CASE C: a failed migration must fail the boot — serving against a mismatched schema is the defect this prevents`,
    );
    console.log("✅ CASE C — a failed migration fails the boot instead of serving anyway");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /FROM deps AS runtime-deps/.test(dockerfile)
        && /p\.dependencies\s*=\s*\{\s*\.\.\.p\.dependencies\s*,/.test(dockerfile)
        && /p\.dependencies\s*=\s*\{[^}]*prisma\s*:\s*p\.devDependencies\.prisma/.test(dockerfile)
        && /npm prune --omit=dev/.test(dockerfile)
        && /FROM runtime-deps AS runtime-bundle/.test(dockerfile)
        && /COPY --from=builder \/app\/\.next\/standalone \.\//.test(dockerfile)
        && /COPY --from=runtime-bundle --chown=nextjs:nodejs \/app \.\//.test(dockerfile),
      `CASE D: pruning must retain production libraries plus the locked Prisma CLI and copy them into the runtime image`,
    );
    assert(
      /COPY .*\/app\/prisma \.\/prisma/.test(dockerfile),
      `CASE D: the migrations folder must be in the image for migrate deploy to have anything to apply`,
    );
    console.log("✅ CASE D — locked CLI tools and migrations are packaged; the Docker gate executes the CLI");
  }

  // ---------------------------------------------------------------- CASE E
  {
    assert(
      /PERSISTENCE_PROVIDER" = "prisma"/.test(entrypoint),
      `CASE E: ${ENTRYPOINT} must only migrate on the substrate that has a database`,
    );
    assert(
      /skipping migrations/.test(entrypoint),
      `CASE E: the JSON substrate has no database and must be skipped, not failed`,
    );
    const noUrlBranch = entrypoint.slice(entrypoint.indexOf('-z "$DATABASE_URL"'));
    assert(
      /exit 1/.test(noUrlBranch.slice(0, 300)),
      `CASE E: a Prisma deploy with no DATABASE_URL must stop, not start with nothing configured`,
    );
    console.log("✅ CASE E — skipped on JSON, refused when Prisma has no database");
  }

  // ---------------------------------------------------------------- CASE F
  {
    assert(
      !entrypoint.includes("\r\n"),
      `CASE F: ${ENTRYPOINT} has CRLF endings — the shebang would fail in the container as "no such file or directory"`,
    );
    const attributes = readSource(GITATTRIBUTES);
    assert(
      /\*\.sh\s+text\s+eol=lf/.test(attributes),
      `CASE F: ${GITATTRIBUTES} must pin shell scripts to LF; this repo is developed on Windows with core.autocrlf=true`,
    );
    console.log("✅ CASE F — the entrypoint keeps LF endings, and git is told to keep them");
  }

  // ---------------------------------------------------------------- CASE G
  {
    // Found on 2026-09-09 by pushing CASE A-F to production. Every assertion
    // above passed and the deploy still died in thirty seconds:
    //
    //   COPY --chown=nextjs:nodejs scripts/docker-entrypoint.sh ...
    //   ERROR: failed to calculate checksum ... "/scripts/docker-entrypoint.sh": not found
    //
    // `.dockerignore` excludes ALL of `scripts/` (N-BUILD-2, deliberately) and
    // re-admits named files. The entrypoint was added to the Dockerfile and
    // never added to that allow-list, so the file every other case in this
    // golden reads off disk was not in the build context at all. Nothing local
    // reproduces it — the file is right there — and the whole point of this
    // golden is that migrations run ON DEPLOY, which is precisely the thing
    // that could not happen.
    //
    // So: every path the Dockerfile copies FROM THE BUILD CONTEXT (no
    // `--from=`, which reads an earlier stage instead) must survive
    // `.dockerignore`. Last matching rule wins, as Docker does it.
    const dockerignore = readSource(".dockerignore");
    const rules = dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    const matches = (rule: string, filePath: string): boolean => {
      const pattern = rule.replace(/^!/, "").replace(/^\.\//, "").replace(/\/$/, "");
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      // A rule naming a directory excludes everything beneath it.
      return new RegExp(`^${escaped}(/.*)?$`).test(filePath);
    };

    const excluded = (filePath: string): boolean => {
      let verdict = false;
      for (const rule of rules) {
        if (matches(rule, filePath)) verdict = !rule.startsWith("!");
      }
      return verdict;
    };

    const contextCopies = dockerfile
      .split(/\r?\n/)
      .filter((line) => /^COPY\s/.test(line.trim()) && !/--from=/.test(line))
      .map((line) => line.trim().replace(/^COPY\s+/, "").replace(/--\S+\s+/g, "").split(/\s+/))
      .flatMap((parts) => parts.slice(0, -1)) // the last argument is the destination
      .filter((src) => src !== "." && !src.includes("*"));

    assert(
      contextCopies.includes(ENTRYPOINT),
      `CASE G: setup — ${DOCKERFILE} no longer copies ${ENTRYPOINT} from the build context`,
    );
    for (const src of contextCopies) {
      assert(
        !excluded(src),
        `CASE G: ${DOCKERFILE} copies "${src}", and .dockerignore excludes it. The build ` +
        `cannot see the file and dies with '"/${src}": not found' — a failure that cannot ` +
        `reproduce locally, because the file is present on disk.`,
      );
    }
    console.log(`✅ CASE G — all ${contextCopies.length} context copies survive .dockerignore`);
  }

  console.log("\n=== GOLDEN PASSED (A-G) ===");
}

main();
