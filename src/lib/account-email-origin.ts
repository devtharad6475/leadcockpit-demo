/** One canonical origin for account links. Never silently email localhost in production. */
export function accountEmailOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") throw new Error("The public account email address is not configured. Ask your administrator to set the application origin.");
    return "http://localhost:3000";
  }
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("The public account email address is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("The public account email address must be an HTTP or HTTPS origin without a path.");
  }
  if (process.env.NODE_ENV === "production" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "https:")) {
    throw new Error("Account email needs the public HTTPS application origin before sending.");
  }
  return url.origin;
}
