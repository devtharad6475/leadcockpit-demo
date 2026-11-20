/** Destructive failure-injection checks must never target a hosted/customer DB. */
export function assertDisposableReadinessDatabase(rawUrl: string | undefined, ci: string | undefined): void {
  let url: URL;
  try { url = new URL(rawUrl || ""); }
  catch { throw new Error("An explicit disposable readiness database is required"); }
  const postgres = url.protocol === "postgres:" || url.protocol === "postgresql:";
  const localProof = url.hostname === "127.0.0.1" && url.port === "54389" && /^\/readiness(?:_\w+)?$/.test(url.pathname);
  const isolatedCi = ci === "true" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "5432" && url.pathname === "/leadgen_ci";
  if (!postgres || !(localProof || isolatedCi)) {
    throw new Error("Disposable database required: local readiness on 127.0.0.1:54389, or CI=true with loopback:5432/leadgen_ci");
  }
}
