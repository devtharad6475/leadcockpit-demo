/**
 * SSRF (Server-Side Request Forgery) guard.
 *
 * Session 4 audit fix: the website crawler and the LLM provider `baseUrl`
 * previously called fetch() on user-controlled URLs with no filtering. An
 * attacker could point them at internal services (e.g. the cloud metadata
 * endpoint 169.254.169.254, localhost ports, private network ranges) to steal
 * credentials or probe the internal network.
 *
 * This module resolves a URL's host and rejects anything that points at:
 *   - non-http(s) schemes (blocks file://, gopher://, data:, etc.)
 *   - loopback / localhost (127.0.0.0/8, ::1, "localhost")
 *   - link-local (169.254.0.0/16 — includes AWS/GCP/Azure metadata)
 *   - private ranges (10/8, 172.16/12, 192.168/16, fc00::/7)
 *   - multicast / unspecified addresses
 *
 * DNS rebinding caveat: we resolve the hostname once here. A determined
 * attacker could flip DNS between this check and the actual fetch (TOCTOU).
 * For full protection the fetch itself should pin the resolved IP; that is a
 * larger change tracked separately. This guard closes the trivial/obvious
 * SSRF vectors (hardcoded internal IPs, localhost, metadata endpoints) which
 * is the realistic threat for this product.
 */
import { lookup } from "node:dns/promises";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT (incl. 100.100.100.200 metadata)
  if (a === 0) return true;                         // unspecified
  if (a >= 224) return true;                        // multicast / reserved
  return false;
}

/** "::ffff:7f00:1" → [0,0,0,0,0,0xffff,0x7f00,1]; undefined if not an IPv6 literal. */
function ipv6Hextets(ip: string): number[] | undefined {
  let text = ip.toLowerCase().split("%")[0];
  // A trailing dotted IPv4 ("::ffff:127.0.0.1") becomes two hextets.
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const parts = dotted[2].split(".").map(Number);
    if (parts.some((p) => p > 255)) return undefined;
    text = `${dotted[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return undefined;
  return all.map((h) => parseInt(h, 16));
}

function embeddedIpv4(high: number, low: number): string {
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/**
 * 2026-09-27 (break test L3): "::ffff:127.0.0.1" and "::ffff:a9fe:a9fe" (the
 * metadata address written as IPv6) passed, because only the literal "::1",
 * "fc", "fd" and "fe80" prefixes were checked. Addresses that carry an IPv4
 * address inside them are now unwrapped and checked as IPv4.
 */
function isPrivateIpv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true;                                    // unspecified ::
  if (zeros(7) && h[7] === 1) return true;                      // loopback ::1
  if (zeros(5) && h[5] === 0xffff) return isPrivateIpv4(embeddedIpv4(h[6], h[7])); // IPv4-mapped ::ffff:a.b.c.d
  if (zeros(4) && h[4] === 0xffff && h[5] === 0) return isPrivateIpv4(embeddedIpv4(h[6], h[7])); // ::ffff:0:a.b.c.d
  if (zeros(6)) return isPrivateIpv4(embeddedIpv4(h[6], h[7])); // IPv4-compatible ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateIpv4(embeddedIpv4(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(h[1], h[2])); // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return true;                  // unique local fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true;                  // link-local fe80::/10
  if ((h[0] & 0xff00) === 0xff00) return true;                  // multicast ff00::/8
  return false;
}

function isPrivateHost(rawHost: string): boolean {
  // URL keeps the brackets on an IPv6 hostname ("[::1]"); strip them.
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  // Map common localhost names.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":") && isPrivateIpv6(host)) return true;
  return false;
}

export type UrlSafetyResult =
  | { safe: true; url: URL }
  | { safe: false; reason: string };

/**
 * Validate that a URL is safe for server-side fetching. Returns a discriminated
 * union so callers can branch without try/catch. Performs a DNS lookup to catch
 * hostnames that resolve to private IPs.
 */
export async function assertSafeFetchUrl(rawUrl: string): Promise<UrlSafetyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Invalid URL." };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { safe: false, reason: `Scheme "${url.protocol}" is not allowed. Only http and https are permitted.` };
  }

  const hostname = url.hostname.toLowerCase();

  // Quick reject: literal private IPs and localhost (no DNS needed).
  if (isPrivateHost(hostname)) {
    return { safe: false, reason: `Hostname "${hostname}" resolves to a private, loopback, or link-local address.` };
  }

  // DNS resolve to catch hostnames that point at internal IPs.
  try {
    const records = await lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateHost(record.address)) {
        return { safe: false, reason: `Hostname "${hostname}" resolves to a private address (${record.address}).` };
      }
    }
  } catch {
    // If DNS fails, let the downstream fetch fail naturally — we don't block
    // unknown hostnames, only known-private ones.
  }

  return { safe: true, url };
}

/** Convenience: throws on unsafe URLs. Use in paths that already throw. */
export async function requireSafeFetchUrl(rawUrl: string): Promise<URL> {
  const result = await assertSafeFetchUrl(rawUrl);
  if (!result.safe) throw new SsrfError(result.reason);
  return result.url;
}

/**
 * Fetch a URL that came from outside (a lead's website, a crawled link) with
 * the SSRF check on EVERY hop (2026-09-27, break test L3).
 *
 * fetch() follows redirects by itself, so checking only the first URL let a
 * public page answer "302 → http://169.254.169.254/" and have the server read
 * the metadata endpoint for it. Redirects are followed here by hand, each
 * Location re-checked, up to `maxRedirects` (default 3). Throws SsrfError when
 * a hop is refused; returns the final response and the URL it came from.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<{ response: Response; url: string }> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const url = await requireSafeFetchUrl(current);
    const response = await fetch(url.toString(), {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10000),
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { response, url: url.toString() };
    if (hop >= maxRedirects) throw new SsrfError(`Too many redirects (more than ${maxRedirects}).`);
    try {
      current = new URL(location, url).toString();
    } catch {
      throw new SsrfError("Redirected to an invalid address.");
    }
  }
}
