/**
 * nav.ts — open a tab through the real sidebar.
 *
 * WHY THIS EXISTS (2026-08-19, CEO-loop session 7).
 *
 * On 2026-08-17 the navigation was redesigned (src/app/page.tsx, "Operator
 * Dashboard UI Redesign", option 1b): the flat list of 26 tabs became one
 * always-visible leaf ("Needs you") plus five drawers that START COLLAPSED —
 * Conversations, Customers, Prospecting, Knowledge, Controls. Several tabs were
 * also renamed: "Commercial" is now "Quotes & Orders", "CRM" is now "Leads".
 *
 * Every e2e spec written before that date clicks the OLD labels. Playwright's
 * `getByRole("button", { name: /Commercial/i })` simply matches nothing, the
 * `.catch(() => {})` fallbacks swallow it, and the test then either times out
 * or — worse — asserts against whatever screen it was already on and passes.
 * The prod-prisma smoke did both: two tests timed out and two went green
 * without ever leaving the landing screen.
 *
 * So a spec must now say WHICH DRAWER a tab lives in, and the drawer has to be
 * opened first. That is what this helper does, in one place, so the next
 * navigation change is one file to update instead of every spec.
 *
 * Everything is scoped to the "Main navigation" landmark. Without that scope,
 * `name: "Leads"` also matches the "Leads to review" card on the Needs-you
 * landing screen, and the test clicks a card instead of a tab.
 */
import { PAGE_INTROS } from "../../src/app/page-intros";
import type { Page } from "@playwright/test";

/**
 * The drawers, exactly as src/app/page.tsx `tabGroups` declares them.
 *
 * 2026-08-31 (N-UI-7) - "Controls" held eleven unrelated screens and its name
 * said nothing about any of them. It is now three groups: "Business
 * performance", "AI & channels", "Workspace & admin". `navigation.spec.ts`
 * compares this list against the sidebar the app really renders, so this
 * comment cannot quietly go stale.
 */
export type NavGroup =
  | "Conversations"
  | "Customers"
  | "Prospecting"
  | "Knowledge"
  | "Business performance"
  | "AI & channels"
  | "Workspace & admin";

/**
 * Open `tabLabel`, expanding `group` first if the drawer is still closed.
 *
 * Throws rather than swallowing: a tab that cannot be found is a broken spec or
 * a broken app, and both are things a run should report, not skip past.
 */
export async function openTab(page: Page, group: NavGroup, tabLabel: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  // 2026-08-20 (N-TEST-15) — `{ name: tabLabel }` is a SUBSTRING match in
  // Playwright, and `.first()` then silently picks the wrong tab whenever one
  // label contains another. "Settings" matches "AI Settings", which is rendered
  // first, so every openTabByLabel(page, "Settings") in the suite opened the AI
  // Settings screen and asserted against it. It was invisible because the tab
  // DOES open and the screen DOES render — the visual sweep only gave it away by
  // producing two byte-identical screenshots (settings.png == ai-settings.png).
  // Nav labels are the entire button text (page.tsx:678), so exact is safe.
  const leaf = nav.getByRole("button", { name: tabLabel, exact: true }).first();

  // After a reload the shell has not mounted yet. Reading leaf visibility
  // then clicking an auto-waiting group button would close the group that
  // authentication has just opened. Inspect the rendered drawer first.
  const drawer = nav.getByRole("button", { name: group, exact: true }).first();
  await drawer.waitFor({ state: "visible", timeout: 20_000 });
  if (await drawer.getAttribute("aria-expanded") !== "true") await drawer.click();
  await leaf.waitFor({ state: "visible", timeout: 15_000 });
  await leaf.click();
}

/** Where each tab this suite touches lives, so specs don't hard-code the IA. */
export const TAB: Record<string, { group: NavGroup; label: string }> = {
  leads: { group: "Customers", label: "Leads" },
  quotesAndOrders: { group: "Customers", label: "Quotes & Orders" },
  replies: { group: "Conversations", label: "Replies" },
  dashboard: { group: "Business performance", label: "Dashboard" },
};

/**
 * Every tab, and the drawer it lives in — a transcription of `tabGroups` in
 * src/app/page.tsx.
 *
 * Kept as data rather than looked up at run time on purpose: if the app stops
 * offering a tab, a spec asking for it should fail loudly here with a message
 * naming the tab, not quietly find nothing and time out thirty seconds later on
 * an unrelated assertion. `readNavMap()` below is what keeps this
 * honest against the real sidebar.
 */
export const TAB_GROUP: Record<string, NavGroup> = {
  // Conversations
  Replies: "Conversations",
  Messages: "Conversations",
  Tickets: "Conversations",
  "AI Drafts": "Conversations",
  // Customers
  Leads: "Customers",
  "Quotes & Orders": "Customers",
  // Prospecting
  "Ideal Customers": "Prospecting",
  Campaign: "Prospecting",
  Discovery: "Prospecting",
  "Lead Review": "Prospecting",
  // Knowledge
  Onboarding: "Knowledge",
  Profile: "Knowledge",
  "Knowledge Base": "Knowledge",
  Catalogue: "Knowledge",
  "Questions from AI": "Knowledge",
  // Business performance
  Dashboard: "Business performance",
  Analytics: "Business performance",
  // AI & channels
  "AI Settings": "AI & channels",
  "WhatsApp Agent": "AI & channels",
  "Agent Instructions": "AI & channels",
  Integrations: "AI & channels",
  // Workspace & admin
  Workspace: "Workspace & admin",
  Activity: "Workspace & admin",
  Compliance: "Workspace & admin",
  Settings: "Workspace & admin",
  "Export / Backup": "Workspace & admin",
  "Help & Support": "Workspace & admin",
};

/**
 * Labels that specs written before 2026-08-17 still use, mapped to what the tab
 * is called now.
 *
 * This is a translation table, not a compatibility shim: the old names are gone
 * from the product and are not coming back. It exists so that retargeting forty
 * specs is a mechanical edit against one list rather than forty judgement calls
 * about which new screen the author meant.
 */
export const RENAMED_TABS: Record<string, string> = {
  Commercial: "Quotes & Orders",
  "Orders & Quotes": "Quotes & Orders",
  CRM: "Leads",
  "Leads / CRM": "Leads",
  "Knowledge base": "Knowledge Base",
  ICP: "Ideal Customers",
  "ICP Builder": "Ideal Customers",
  "Review Queue": "AI Drafts",
  "Unknown Questions": "Questions from AI",
};

/**
 * Open a tab by its label alone, working out the drawer from TAB_GROUP.
 *
 * This is the entry point specs should use. `openTab()` remains for callers
 * that want to state the drawer explicitly (and to keep the existing
 * prod-prisma smoke readable).
 */
export async function openTabByLabel(page: Page, label: string): Promise<void> {
  const current = RENAMED_TABS[label] ?? label;
  const group = TAB_GROUP[current];
  if (!group) {
    throw new Error(
      `openTabByLabel("${label}") — no such tab. ` +
        (current !== label ? `It was renamed to "${current}", which is also not in TAB_GROUP. ` : "") +
        `Known tabs: ${Object.keys(TAB_GROUP).join(", ")}. ` +
        `If the app really does offer this tab, add it to TAB_GROUP in e2e/helpers/nav.ts.`,
    );
  }
  await openTab(page, group, current);
}

/**
 * Read the sidebar the app ACTUALLY renders, as {tab label -> drawer}.
 *
 * The whole reason this suite was worthless for two days is that it described a
 * navigation the product had stopped having, and nothing anywhere noticed.
 * TAB_GROUP above is a hard-coded transcription with exactly that failure mode,
 * so `navigation.spec.ts` compares this against it: a renamed or moved tab then
 * shows up as one failing assertion with a readable diff, instead of forty
 * tests timing out somewhere unrelated.
 */
export async function readNavMap(page: Page): Promise<Record<string, NavGroup>> {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const groups: NavGroup[] = ["Conversations", "Customers", "Prospecting", "Knowledge", "Business performance", "AI & channels", "Workspace & admin"];
  const map: Record<string, NavGroup> = {};
  for (const group of groups) {
    // Open this drawer and close the previous one — the labels visible in
    // between are the ones that belong to it.
    await nav.getByRole("button", { name: group }).first().click();
    const labels = await nav.getByRole("button").allInnerTexts();
    for (const raw of labels) {
      const label = raw.trim().split("\n")[0].trim();
      if (!label) continue;
      if (groups.includes(label as NavGroup)) continue;
      if (label === "Needs you" || label.startsWith("Needs you")) continue;
      // Assistant (the Command Center until 2026-09-25) is the second always-visible leaf, like
      // Needs you: it sits outside every drawer, so it belongs to none.
      if (label === "Assistant") continue;
      if (map[label]) continue;
      map[label] = group;
    }
    await nav.getByRole("button", { name: group }).first().click();
  }
  return map;
}

/**
 * The tab id behind each sidebar label, so a spec can look up the heading the
 * shell is supposed to render for a screen it just opened.
 *
 * 2026-09-03 (N-UX-10). Until now the shell <h1> WAS the sidebar label, so
 * `ui-value-verification.spec.ts` could confirm a click had landed by matching
 * the h1 against the label it asked for. That invariant was deliberately
 * replaced: the heading now states the JOB ("Answer what the AI couldn't")
 * because the sidebar has already told the operator which item they clicked, so
 * repeating it spent the largest text on the screen saying nothing.
 *
 * The check is NOT loosened to "any heading" — that would stop detecting a
 * click that landed on the wrong screen, which is the whole reason it exists.
 * It still asserts one exact string; the expected value now comes from the
 * app's own PAGE_INTROS table, so the spec cannot drift from the product.
 *
 * Only this label -> id mapping is hand-transcribed, in the same spirit as
 * TAB_GROUP above, and `navigation.spec.ts` checks every entry resolves.
 */
export const TAB_ID_BY_LABEL: Record<string, string> = {
  "Needs you": "needsYou",
  "Assistant": "commandCenter",
  "Dashboard": "dashboard",
  "Onboarding": "onboarding",
  "Profile": "profile",
  "Knowledge Base": "knowledge",
  "Ideal Customers": "icp",
  "Campaign": "campaign",
  "Discovery": "discovery",
  "Lead Review": "review",
  "Leads": "crm",
  "Messages": "messages",
  "Replies": "replies",
  "Tickets": "tickets",
  "Quotes & Orders": "commercial",
  "Catalogue": "catalogue",
  "Workspace": "workspace",
  "Activity": "activity",
  "Compliance": "compliance",
  "Analytics": "analytics",
  "WhatsApp Agent": "whatsapp",
  "Questions from AI": "unknown",
  "AI Drafts": "reviewQueue",
  "AI Settings": "ai",
  "Agent Instructions": "agentInstructions",
  "Integrations": "integrations",
  "Settings": "settings",
  "Export / Backup": "exportBackup",
  "Help & Support": "help",
};

/**
 * The exact <h1> the shell must render for a tab, by sidebar label.
 *
 * `needsYou` is the one screen whose heading is a live count ("6 things need
 * you" / "Nothing needs you") rather than a fixed string, so it has no fixed
 * expectation here and callers fall back to the count pattern.
 */
export function expectedHeadingFor(label: string): string | null {
  if (label === "Needs you") return null;
  const id = TAB_ID_BY_LABEL[label];
  if (!id) {
    throw new Error(
      `expectedHeadingFor("${label}") — no tab id known for that label. ` +
        `Add it to TAB_ID_BY_LABEL in e2e/helpers/nav.ts.`,
    );
  }
  const intro = PAGE_INTROS[id];
  if (!intro) {
    throw new Error(
      `expectedHeadingFor("${label}") — tab id "${id}" has no entry in ` +
        `src/app/page-intros.ts. Every screen must have a heading and a blurb ` +
        `(pinned by golden:page-intros).`,
    );
  }
  return intro.heading;
}
