import { NeedsActionError } from "@/lib/user-errors";
import * as cheerio from "cheerio";
import { safeFetch, SsrfError } from "./ssrf-guard";

const importantPagePattern = /(about|product|service|catalog|contact|industr|application|client|faq)/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const phonePattern = /(?:\+?\d[\d\s().-]{7,}\d)/g;

/**
 * M3.8 / O9 audit fix: private/sensitive URL pattern. Even when the customer
 * consented to "crawl my site," the crawler must not fetch pages that look
 * like admin panels, source-control metadata, environment files, or other
 * non-public content. The customer's consent covers their public site, not
 * every URL the crawler happens to find. Same-origin is enforced separately
 * by prioritizeLinks; this filter catches sensitive paths on the same origin.
 */
const SENSITIVE_URL_PATTERN = /(\/admin\b|\/wp-admin\b|\/_internal\b|\/private\b|\/\.git\b|\/\.env\b|\/\.aws\b|\/\.ssh\b|\/node_modules\b|\/cgi-bin\b|\/phpinfo\b|\/server-status\b|\/xmlrpc\.php\b|\/config\b|\/backup\b|\/dump\b)/i;

export type CrawledPage = {
  url: string;
  title: string;
  text: string;
  links: string[];
  emails: string[];
  phones: string[];
  socials: string[];
  catalogues: string[];
};

export async function crawlWebsite(inputUrl: string, pageLimit = 12): Promise<CrawledPage[]> {
  const base = normalizeUrl(inputUrl);
  // M3.8: fetch and parse robots.txt for the seed origin once, then respect
  // Disallow rules per page. Previously the crawler only checked consent for
  // the seed URL and then visited any same-origin page it found, ignoring
  // robots.txt and any sensitive URL pattern.
  const robots = await fetchRobots(base);
  const homepage = await fetchPage(base, robots);
  const candidates = prioritizeLinks(homepage.links, base)
    .filter((link) => !isSensitiveUrl(link))
    .filter((link) => !isDisallowedByRobots(link, robots))
    .slice(0, pageLimit - 1);
  const results = [homepage];

  for (const link of candidates) {
    try {
      results.push(await fetchPage(link, robots));
    } catch {
      // Individual pages can fail without killing the crawl job.
    }
  }

  return results;
}

/** Returns true when the URL matches a known-sensitive path. Exported for tests. */
export function isSensitiveUrl(url: string): boolean {
  try {
    return SENSITIVE_URL_PATTERN.test(new URL(url).pathname.toLowerCase());
  } catch {
    return false;
  }
}

export type RobotsRules = { entries: Array<{ userAgent: string; disallowPaths: string[]; allowPaths: string[] }> };

async function fetchRobots(baseUrl: string): Promise<RobotsRules> {
  try {
    const origin = new URL(baseUrl).origin;
    // 2026-09-27 (break test L3): redirects are followed by hand, each hop
    // re-checked (safeFetch) — fetch() used to follow them unchecked.
    const { response } = await safeFetch(`${origin}/robots.txt`, {
      headers: { "user-agent": "LeadGenPlatform crawler; respectful low-volume website reader" },
    }, { timeoutMs: 5000 });
    if (!response.ok) return { entries: [] };
    const text = await response.text();
    return parseRobots(text);
  } catch {
    return { entries: [] };
  }
}

export function parseRobots(text: string): RobotsRules {
  const entries: RobotsRules["entries"] = [];
  let currentUserAgents: string[] = [];
  let currentEntry: { userAgent: string; disallowPaths: string[]; allowPaths: string[] } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (currentEntry && currentUserAgents.length) {
        for (const ua of currentUserAgents) entries.push({ ...currentEntry, userAgent: ua });
      }
      currentUserAgents = [value];
      currentEntry = { userAgent: value, disallowPaths: [], allowPaths: [] };
    } else if ((key === "disallow" || key === "allow") && currentEntry) {
      if (value === "") continue;
      if (key === "disallow") currentEntry.disallowPaths.push(value);
      else currentEntry.allowPaths.push(value);
    }
  }
  if (currentEntry && currentUserAgents.length) {
    for (const ua of currentUserAgents) entries.push({ ...currentEntry, userAgent: ua });
  }
  return { entries };
}

export function isDisallowedByRobots(url: string, robots: RobotsRules): boolean {
  try {
    const path = new URL(url).pathname;
    // Apply "*" rules and "leadgenplatform" rules (case-insensitive). If no
    // specific rule matches, default to allowed.
    const applicable = robots.entries.filter((entry) => entry.userAgent === "*" || entry.userAgent.toLowerCase() === "leadgenplatform");
    for (const entry of applicable) {
      for (const allowed of entry.allowPaths) {
        if (path.startsWith(allowed)) return false;
      }
    }
    for (const entry of applicable) {
      for (const disallowed of entry.disallowPaths) {
        if (path.startsWith(disallowed)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function normalizeUrl(input: string) {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

async function fetchPage(url: string, _robots: RobotsRules = { entries: [] }): Promise<CrawledPage> {
  // Session 4 audit fix: block SSRF. Reject private/loopback/link-local IPs
  // and non-http(s) schemes before fetching. Without this, a user-controlled
  // websiteUrl could reach the cloud metadata endpoint or internal services.
  // 2026-09-27 (break test L3): the check ran on the first URL only and fetch()
  // then followed any redirect — to 127.0.0.1 or the metadata address — by
  // itself. safeFetch re-checks every hop.
  let response: Response;
  try {
    ({ response } = await safeFetch(url, {
      headers: {
        "user-agent": "LeadGenPlatform MVP crawler; respectful low-volume website reader",
      },
    }, { timeoutMs: 12000 }));
  } catch (error) {
    if (error instanceof SsrfError) throw new NeedsActionError(`Refused to crawl unsafe URL: ${error.message}`, 400);
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  $("script, style, nav, footer, noscript").remove();
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || url;
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 18000);
  const links = $("a[href]").map((_, element) => absolutize($(element).attr("href") || "", url)).get().filter(Boolean);
  const emails = Array.from(new Set((html.match(emailPattern) || []).map((item) => item.toLowerCase())));
  const phones = Array.from(new Set((text.match(phonePattern) || []).map((item) => item.trim())));
  const socials = links.filter((link) => /(linkedin|instagram|facebook|wa\.me|whatsapp|x\.com|twitter)/i.test(link));
  const catalogues = links.filter((link) => /(catalog|catalogue|brochure|\.pdf)/i.test(link));

  return { url, title, text, links, emails, phones, socials, catalogues };
}

function absolutize(href: string, base: string) {
  try {
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return "";
    return new URL(href, base).toString().split("#")[0];
  } catch {
    return "";
  }
}

export function prioritizeLinks(links: string[], base: string) {
  const origin = new URL(base).origin;
  const internal = Array.from(new Set(links.filter((link) => link.startsWith(origin))));
  const important = internal.filter((link) => importantPagePattern.test(link));
  const fallback = internal.filter((link) => !importantPagePattern.test(link));
  return [...important, ...fallback];
}
