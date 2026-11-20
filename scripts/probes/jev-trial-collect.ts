/**
 * jev-trial-collect.ts — step 1 of the Jev trial (docs/planning/JEV_TRIAL.md).
 * Pulls real businesses from Google Maps through the product's own search
 * path (ProspectingService.searchGoogleMaps), so every record has exactly the
 * shape the product screens. Saves nothing to the database.
 *
 * Phone numbers and the WhatsApp copy are dropped: they play no part in "is
 * this business a fit", and the saved file is kept in the repo.
 *
 * COST: one paid SerpApi search per query (8). Run once:
 *   npx tsx scripts/probes/jev-trial-collect.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
process.env.PERSISTENCE_PROVIDER = "json";

const QUERIES = [
  "embroidery job work unit Surat",
  "saree manufacturer Surat",
  "lehenga manufacturer Delhi",
  "lace and trims wholesaler Mumbai",
  "textile wholesaler Ahmedabad",
  "zari work Varanasi",
  "bridal boutique Jaipur",
  "tailor shop Pune",
];

// Set 2 (2026-09-25): a HELD-OUT set — different cities and searches, collected
// after the built-in rule was rewritten, so the rule is measured on businesses
// it was never adjusted against. Run with JEV_TRIAL_SET=2.
const SET_2 = process.env.JEV_TRIAL_SET === "2";
if (SET_2) {
  QUERIES.splice(0, QUERIES.length,
    "embroidery unit Mumbai",
    "garment manufacturer Tiruppur",
    "saree wholesaler Kolkata",
    "kurti manufacturer Jaipur",
    "textile trader Ludhiana",
    "lehenga shop Lucknow",
    "boutique Chandigarh",
    "ladies tailor Hyderabad",
  );
}
export const TRIAL_FILE = path.join(process.cwd(), `scripts/probes/_receipts/jev-trial-businesses${SET_2 ? "-2" : ""}.json`);

(async () => {
  if (fs.existsSync(TRIAL_FILE)) {
    console.log("Already collected — not spending again:", TRIAL_FILE);
    process.exit(0);
  }
  const { ProspectingService } = await import("@/services/ProspectingService");
  const service = new ProspectingService();
  const seen = new Set<string>();
  const businesses: Array<Record<string, unknown>> = [];
  for (const query of QUERIES) {
    const result = await service.searchGoogleMaps(query, 20);
    if (result.mode !== "live_google_maps") {
      console.error(`Search for "${query}" was not live (${result.mode}): ${result.warning}. Stopping.`);
      process.exit(1);
    }
    for (const c of result.candidates) {
      const key = `${c.companyName}|${c.address}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      businesses.push({
        id: `b${String(businesses.length + 1).padStart(3, "0")}`,
        query,
        companyName: c.companyName,
        buyerType: c.buyerType,
        industry: c.industry,
        discoveredInfo: c.discoveredInfo,
        address: c.address,
        city: c.city,
        websiteUrl: c.websiteUrl,
      });
    }
    console.log(`${query}: ${result.candidates.length} found`);
  }
  fs.mkdirSync(path.dirname(TRIAL_FILE), { recursive: true });
  fs.writeFileSync(TRIAL_FILE, JSON.stringify({ collectedAt: new Date().toISOString(), queries: QUERIES, businesses }, null, 2));
  console.log(`Saved ${businesses.length} businesses.`);
  process.exit(0);
})();
