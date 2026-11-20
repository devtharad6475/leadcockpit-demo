/**
 * golden-crawler.ts — pins the website crawler's PURE LOGIC (Stage 6 / 2026-07-31).
 *
 * WHY THIS TEST EXISTS (closing a long-deferred DARK corner):
 *   The crawler (src/lib/crawler.ts) was one of 2 external-I/O units that had
 *   NO golden test (deferred since Session 7 because it "needs heavier mocking
 *   infra"). The bug risk of leaving it dark: the crawler decides which pages
 *   to visit + which to SKIP. Two of its rules are safety-critical:
 *     1. isSensitiveUrl — must block /admin, /.env, /.git, etc. even on a
 *        consented site (M3.8 audit fix). A regression that admits /.env would
 *        leak secrets.
 *     2. isDisallowedByRobots — must respect robots.txt Disallow. A regression
 *        that ignores robots would crawl pages the site owner forbade (a
 *        compliance + reputational risk).
 *   Both are PURE functions (no network) — perfect golden candidates. This
 *   test exercises them + parseRobots + prioritizeLinks + normalizeUrl with
 *   hand-computed expected values. The fetch-dependent crawlWebsite/fetchPage
 *   are covered indirectly via the SSRF golden (assertSafeFetchUrl) + the
 *   knowledge smokes (real crawl of the demo site); this golden covers the
 *   DECISION logic that decides what to crawl.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — these are the RULES, written before
 * looking at the code's runtime output):
 *
 *   CASE A — normalizeUrl: adds https:// when missing; keeps http(s):// as-is.
 *   CASE B — isSensitiveUrl: blocks the documented sensitive paths
 *     (/admin, /.env, /.git, /wp-admin, /backup, /config, /server-status);
 *     ALLOWS a normal public path (/products, /about, /contact).
 *   CASE C — parseRobots: parses a real robots.txt into entries with user-agent
 *     + disallow/allow lists. Hand-computed for a 2-group sample.
 *   CASE D — isDisallowedByRobots: a path under a "*" Disallow rule is blocked;
 *     a path under an "Allow" rule is allowed (Allow wins per the parser);
 *     an unmapped path is allowed (default-open within consent).
 *   CASE E — prioritizeLinks: same-origin important links (about/product/
 *     service/contact) come FIRST, then same-origin fallback; cross-origin
 *     links are dropped entirely.
 *
 * Run: npx tsx scripts/golden/golden-crawler.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  normalizeUrl,
  isSensitiveUrl,
  parseRobots,
  isDisallowedByRobots,
  prioritizeLinks,
  type RobotsRules,
} from "@/lib/crawler";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// ─── CASE A: normalizeUrl ───────────────────────────────────────────────────
test("CASE A — normalizeUrl adds https:// when missing; preserves http(s)://", async () => {
  assert.strictEqual(normalizeUrl("example.com"), "https://example.com", "bare domain gets https://");
  assert.strictEqual(normalizeUrl("www.example.com/about"), "https://www.example.com/about", "bare path gets https://");
  assert.strictEqual(normalizeUrl("http://example.com"), "http://example.com", "existing http:// preserved");
  assert.strictEqual(normalizeUrl("https://example.com/x"), "https://example.com/x", "existing https:// preserved");
});

// ─── CASE B: isSensitiveUrl (the M3.8 safety gate) ──────────────────────────
test("CASE B — isSensitiveUrl blocks sensitive paths; allows normal public paths", async () => {
  // Blocked (the documented sensitive set — a regression that admits any of these
  // could leak secrets or hit admin panels on a consented site).
  const blocked = [
    "https://example.com/admin",
    "https://example.com/admin/users",
    "https://example.com/wp-admin",
    "https://example.com/.env",
    "https://example.com/.git/config",
    "https://example.com/config/settings",
    "https://example.com/backup/db.sql",
    "https://example.com/server-status",
    "https://example.com/cgi-bin/script",
    "https://example.com/node_modules/pkg",
  ];
  for (const url of blocked) {
    assert.strictEqual(isSensitiveUrl(url), true, `must block sensitive path: ${url}`);
  }
  // Allowed (normal public site pages the customer consented to crawl).
  const allowed = [
    "https://example.com/",
    "https://example.com/products",
    "https://example.com/about-us",
    "https://example.com/contact",
    "https://example.com/catalog/zari-thread",
  ];
  for (const url of allowed) {
    assert.strictEqual(isSensitiveUrl(url), false, `must allow normal public path: ${url}`);
  }
});

// ─── CASE C: parseRobots ────────────────────────────────────────────────────
test("CASE C — parseRobots parses a 2-group robots.txt into entries", async () => {
  const sample = [
    "User-agent: *",
    "Disallow: /private/",
    "Disallow: /search",
    "",
    "User-agent: BadBot",
    "Disallow: /",
    "",
    "# a comment line",
    "Allow: /public/allowed",
  ].join("\n");
  const rules = parseRobots(sample);
  // Hand-computed: 2 user-agent groups → 2 entries (BadBot + *). The '*' group
  // has 2 disallows; BadBot has 1 disallow (/). The trailing Allow attaches to
  // the BadBot group (the last currentEntry). Comments + blanks ignored.
  assert.strictEqual(rules.entries.length, 2, "2 user-agent groups → 2 entries");
  const star = rules.entries.find((e) => e.userAgent === "*");
  assert.ok(star, "must have a '*' entry");
  assert.deepEqual(star!.disallowPaths.sort(), ["/private/", "/search"], "'*' disallow paths");
  const badBot = rules.entries.find((e) => e.userAgent === "BadBot");
  assert.ok(badBot, "must have a 'BadBot' entry");
  assert.deepEqual(badBot!.disallowPaths, ["/"], "BadBot disallows everything");
  assert.deepEqual(badBot!.allowPaths, ["/public/allowed"], "the Allow rule attaches to BadBot (last group)");
});

// ─── CASE D: isDisallowedByRobots ───────────────────────────────────────────
test("CASE D — isDisallowedByRobots: Disallow blocks; Allow wins; unmapped default-allowed", async () => {
  const robots: RobotsRules = parseRobots([
    "User-agent: *",
    "Disallow: /private/",
    "Allow: /private/public/",
  ].join("\n"));
  // Blocked: path under a Disallow rule.
  assert.strictEqual(isDisallowedByRobots("https://x.com/private/secret.pdf", robots), true, "Disallow blocks");
  // Allowed: Allow wins over Disallow (the parser checks Allow first).
  assert.strictEqual(isDisallowedByRobots("https://x.com/private/public/page", robots), false, "Allow wins over Disallow");
  // Default-open: an unmapped path is allowed (the customer consented to crawl).
  assert.strictEqual(isDisallowedByRobots("https://x.com/products", robots), false, "unmapped path is allowed");
});

// ─── CASE E: prioritizeLinks ────────────────────────────────────────────────
test("CASE E — prioritizeLinks: same-origin important first, then fallback; cross-origin dropped", async () => {
  const base = "https://example.com";
  const links = [
    "https://other.com/external", // cross-origin → dropped
    "https://example.com/random/blog", // same-origin, not "important" → fallback
    "https://example.com/about", // same-origin important → first
    "https://example.com/products", // same-origin important → first
    "https://example.com/about", // duplicate → deduped
    "https://example.com/contact", // same-origin important → first
  ];
  const result = prioritizeLinks(links, base);
  // Hand-computed: cross-origin dropped; important links (about, products,
  // contact) deduped + first in source order; then the fallback (random/blog).
  // important = matches /(about|product|service|catalog|contact|industr|application|client|faq)/i
  assert.ok(!result.includes("https://other.com/external"), "cross-origin link must be dropped");
  // The 3 important links come before the fallback.
  const aboutIdx = result.indexOf("https://example.com/about");
  const productsIdx = result.indexOf("https://example.com/products");
  const contactIdx = result.indexOf("https://example.com/contact");
  const fallbackIdx = result.indexOf("https://example.com/random/blog");
  assert.ok(aboutIdx >= 0 && productsIdx >= 0 && contactIdx >= 0 && fallbackIdx >= 0, "all same-origin links present");
  assert.ok(aboutIdx < fallbackIdx && productsIdx < fallbackIdx && contactIdx < fallbackIdx, "important links precede fallback");
  // Dedup: only one 'about' occurrence.
  assert.strictEqual(result.filter((l) => l === "https://example.com/about").length, 1, "duplicate 'about' deduped");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
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
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-crawler FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-crawler ALL GREEN ✅");
  process.exit(0);
})();
