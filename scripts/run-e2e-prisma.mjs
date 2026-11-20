/**
 * run-e2e-prisma.mjs — `npm run test:e2e:prisma`.
 *
 * Sets E2E_TARGET=prisma and hands off to Playwright. It exists because Next 16
 * allows only one dev server per project directory, so the JSON suite and the
 * prod-prisma smoke have to be separate invocations (see e2e/helpers/e2e-target.ts),
 * and there is no cross-platform way to set one environment variable inline in an
 * npm script without adding a dependency for it.
 *
 * Extra arguments are forwarded, so `npm run test:e2e:prisma -- --headed` works.
 */
import { spawn } from "node:child_process";

// shell:true is required on Windows — Node refuses to spawn a .cmd shim
// directly (EINVAL) since the 2024 argument-injection hardening.
const child = spawn(
  "npx",
  ["playwright", "test", ...process.argv.slice(2)],
  { stdio: "inherit", shell: true, env: { ...process.env, E2E_TARGET: "prisma" } },
);
child.on("exit", (code) => process.exit(code ?? 1));
