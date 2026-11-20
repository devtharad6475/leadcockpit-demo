/**
 * RBAC role map — the single source of truth for "which role can hit which route".
 *
 * Extracted from src/app/api/[[...path]]/route.ts on 2026-07-27 (audit S6 S-1/S-2)
 * so the contract can be golden-pinned (scripts/golden/golden-rbac-map.ts) and
 * the route imports it (build-right Phase 3d — one chokepoint for cross-cutting
 * rules; no second copy).
 *
 * Role ladder: viewer < sales_member < admin < owner. A route's required role
 * is the MINIMUM role that may call it; higher roles inherit access.
 *
 * Mutating routes (POST/PUT/DELETE) pass through requiredRoleForPath(). GET
 * reads have no role gate here beyond the authenticated-session check (finer
 * GET redaction is handled in the response layer).
 */

export type MinRole = "viewer" | "sales_member" | "admin" | "owner";

export const ROLE_RANK: Record<MinRole, number> = {
  viewer: 0,
  sales_member: 1,
  admin: 2,
  owner: 3,
};

/** Route prefixes whose mutation requires the OWNER role. */
export const OWNER_ONLY_PREFIXES = new Set<string>([
  // Settings, credentials, integrations, AI provider config — billing/keys/safety.
  "ai", "agent-autonomous", "integrations",
  // Customer-facing sends + destructive cascades + tenant creation.
  "price-change",      // R6 — sends WhatsApp to customers (owner-approved)
  "erasure",           // R5 — hard-delete cascade of all customer data
  "workspaces",        // creating a new workspace = creating a new tenant
  // S6 S-1/S-2: customer-facing SEND/APPROVE family — owner-approved per policy.
  "auto-reply-logs",   // /approve dispatches a real WhatsApp send
  "messages",          // /:id/approve is the manual-send approval step
  // F-RBAC-1 (2026-08-04 build-right audit): WhatsApp templates are the messages
  // sent OUTSIDE the 24h customer-service window — they reach customers cold.
  // The route comment at the approve handler literally says "owner confirms Meta
  // approved it." These must be owner-only like the rest of the send family;
  // previously they fell through to the sales_member default (a sales_member
  // could create + approve templates). Same threat model as auto-reply-logs.
  "whatsapp-templates",
  // Owner Copilot (2026-08-01) — acts on the owner's behalf (drafts/approves
  // quotes, tickets, replies). Owner-only per design §10. The 5-tier router
  // already deflects dangerous intents; RBAC here adds the role gate on top.
  "copilot",
  // 2026-09-28 — the owner's own WhatsApp number + morning summary + alerts.
  // Only the owner may point these messages at a number.
  "owner-alerts",
]);

/** Route prefixes whose mutation requires at least ADMIN (admin or owner). */
export const ADMIN_REQUIRED_PREFIXES = new Set<string>([
  // Workspace-wide configuration: review thresholds, WhatsApp mode, extraction
  // routing, knowledge framework admin.
  "lead-review", "settings", "whatsapp-agent",
  // Workspace-wide controls affecting every staff member + customer.
  "workspace", // kill-switch, autoSendToggle, insights
  "consent",   // DPDPA consent basis changes — legal significance
  // Cluster 1 (2026-07-26): workspace-identity configuration must not be
  // writable by sales_member.
  "onboarding",       // extract-company-knowledge rewrites profile + KB + ICPs
  "business-profile", // the workspace's public identity + funnel gate
  "crawl",            // fans out web fetches + rewrites the business profile
  "media",            // destructive write path (archive)
  // S6 S-2: outreach/mark-sent logs manual outreach. Operational, so admin+
  // (a sales lead can log their team's outreach); bare sales_member cannot
  // self-mark sends.
  "outreach",
  // Stage 5 / WP3 (2026-07-28) — platform tickets: a workspace user opening a
  // support ticket to the SaaS operator. LOGIC.md: owner/admin only (sales_member
  // + viewer cannot flood the operator's support inbox).
  "platform-tickets",
  // ── 2026-08-05 (audit finding F-6) ────────────────────────────────────────
  // The five prefixes below were NEVER classified. They reached sales_member
  // only because that was the old fall-through default, not because anyone
  // decided they were day-to-day CRM work. Under default-deny they need an
  // explicit home, and each belongs with the other workspace-configuration
  // routes already in this set:
  "knowledge",        // writes the Knowledge Base that grounds EVERY AI answer
                      // — same blast radius as "onboarding"/"business-profile"
  "documents",        // uploads + extraction feeding that same Knowledge Base
  "icp",              // icp/generate rewrites the workspace's ICPs wholesale
  "extraction-runs",  // cancels in-flight workspace extraction jobs
  "team",             // 2026-09-28 (S3): remove a member / change a role.
                      // The service adds the finer rules (admins cannot touch
                      // owners, nobody changes themselves, last owner stays).
  // 2026-09-28 — the activity log ("who did what"). Read-only, but it shows
  // every person's actions, so only owner/admin may read it (sensitive GET).
  "activity",
  "invites",          // creates workspace USERS. The handler already calls
                      // requireRole(request, "admin") inline (route.ts:1811);
                      // listing it here makes the map agree with the code
                      // instead of relying on a check the map didn't know about.
]);

/**
 * Route prefixes that day-to-day CRM staff (sales_member and above) may mutate.
 *
 * 2026-08-05 (audit finding F-6): this set is NEW, and it exists so that
 * `requiredRoleForPath` can DENY BY DEFAULT. Previously the function ended in
 * `return "sales_member"`, which meant every route prefix added to route.ts in
 * the future was silently member-mutable until somebody remembered to come
 * here and restrict it. The failure mode was quiet and in the wrong direction:
 * forget the map, get an open route.
 *
 * Now the default is "owner" (the most restrictive), so forgetting the map
 * produces a 403 that shows up the first time the feature is exercised —
 * annoying, visible, and safe — instead of an unguarded endpoint nobody
 * notices.
 *
 * NOTE: "tickets", "orders" and "quotes" are deliberately here per operator
 * decision 2026-07-21 — "all staff" work operational records.
 */
export const SALES_MEMBER_PREFIXES = new Set<string>([
  "analytics",              // campaign analytics reads/recomputes
  "campaigns",              // running campaigns is core sales work
  "fallback",               // resolving a human-fallback task
  "human-fallback-tasks",   // same family
  "leads",                  // the core CRM record
  "new-buyers",             // 2026-09-28 — "Today's new buyers" (read-only list; its GET also requires sales_member)
  "orders",                 // operator decision 2026-07-21
  "quotes",                 // operator decision 2026-07-21
  "replies",                // working the customer inbox
  "tickets",                // operator decision 2026-07-21 — all staff
  "unknown-questions",      // answering a question the AI could not
]);

/**
 * Prefixes that carry NO workspace role gate, for structural reasons.
 *
 * These are documented here rather than left implicit, because under
 * default-deny an unlisted prefix now resolves to "owner" — and a reader needs
 * to be able to tell "deliberately ungated" from "nobody classified it yet".
 *
 * - `auth`    — login/signup/logout/reset must work with NO session at all.
 * - `inbound` — the WhatsApp webhook. Authenticated by HMAC signature
 *               (X-Hub-Signature-256), not by a user session.
 *
 * Both are matched and returned by the route handler BEFORE the workspace auth
 * gate runs, so in practice `requiredRoleForPath` is never consulted for them.
 * They are listed anyway so that if the ordering in route.ts ever changes,
 * this file fails safe and readably rather than by accident.
 *
 * `admin` (the SaaS-operator console) is deliberately NOT here. It has its own
 * platform-admin auth (PlatformAdminAuthService + its own CSRF check) and also
 * returns before this gate — but if that ordering ever changed, "ungated" would
 * be the worst possible fallback for the operator console. Leaving it
 * unclassified means it lands on the default-deny "owner" branch instead.
 */
export const UNGATED_PREFIXES = new Set<string>(["auth", "inbound"]);

/**
 * The minimum role required to MUTATE (POST/PUT/DELETE) the given route path.
 *
 * DEFAULT-DENY (2026-08-05, audit F-6): an unrecognised prefix requires
 * "owner". See SALES_MEMBER_PREFIXES above for why.
 */
export function requiredRoleForPath(path: string[], _verb: string): MinRole {
  // An empty path cannot be a real mutation; require the highest role rather
  // than falling through to something permissive.
  if (path.length === 0) return "owner";
  const head = path[0];
  if (UNGATED_PREFIXES.has(head)) return "viewer";
  if (OWNER_ONLY_PREFIXES.has(head)) return "owner";
  if (ADMIN_REQUIRED_PREFIXES.has(head)) return "admin";
  if (SALES_MEMBER_PREFIXES.has(head)) return "sales_member";
  // Unclassified. Deny by default: require owner. If you are reading this
  // because a new feature is 403ing, the fix is to add its prefix to exactly
  // one of the sets above — that is the intended workflow, not a bug.
  return "owner";
}

/** True iff the given user role satisfies the required role for the path. */
export function roleCanMutate(userRole: MinRole, path: string[], verb: string): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[requiredRoleForPath(path, verb)];
}

/**
 * Prefixes that require admin to WRITE but stay VISIBLE to a tour viewer.
 *
 * 2026-08-05 (audit F-6 follow-on): TOUR_HIDDEN_TAB_PREFIXES is derived from
 * the mutation-role sets, which silently conflates two different questions:
 *
 *     "who may CHANGE this?"   vs   "who may LOOK at this?"
 *
 * They coincided until now. When F-6 moved `knowledge`, `documents` and `icp`
 * into ADMIN_REQUIRED_PREFIXES (they were previously unclassified), the derived
 * tour list would have swallowed them too — quietly deleting the Knowledge
 * Base, Documents and Ideal Customers tabs from the PUBLIC DEMO. That is a
 * product regression caused entirely by a permissions refactor, which is
 * exactly the kind of accident this codebase's chokepoint rule is meant to
 * prevent.
 *
 * These three expose no secrets and a viewer cannot mutate them (the RBAC 403
 * is the real gate), so they stay on show. `extraction-runs` and `invites`
 * are NOT here — they are genuinely operational and stay hidden.
 */
export const TOUR_VISIBLE_DESPITE_ADMIN_WRITE: ReadonlySet<string> = new Set([
  "knowledge",   // the Knowledge Base is one of the best things to demo
  "documents",   // source documents behind the KB
  "icp",         // Ideal Customers — a headline feature of the product
]);

/**
 * CP-20 (2026-08-02) — Route prefixes a read-only TOUR visitor must NOT see,
 * because they expose secrets/config/PII OR are admin/owner-only operations
 * that make no sense for an anonymous evaluator. The backend already 403s a
 * viewer on these (sensitive GET gate + the prefix sets above); this export is
 * the single source the UI uses to decide which sidebar TABS to hide in tour
 * mode (no second copy of the list). Derived from OWNER_ONLY_PREFIXES ∪
 * ADMIN_REQUIRED_PREFIXES plus the sensitive-GET set in route.ts.
 */
export const TOUR_HIDDEN_TAB_PREFIXES: ReadonlySet<string> = new Set([
  ...OWNER_ONLY_PREFIXES,
  ...ADMIN_REQUIRED_PREFIXES,
  // Sensitive GETs (route.ts GET gate) not already in the prefix sets above:
  "health",        // /health/deep exposes internal diagnostics
  "data",          // /data/export dumps the whole workspace
].filter((prefix) => !TOUR_VISIBLE_DESPITE_ADMIN_WRITE.has(prefix)));

/**
 * CP-20 — map an in-app tab id (the SPA's internal tab key, e.g. "ai",
 * "integrations") to whether it should be hidden from a tour viewer. Tab ids
 * align with the route prefix head for the screens that touch config/secrets.
 */
export function isTabHiddenForTour(tabId: string): boolean {
  // Direct prefix match (most tabs share their id with the route head).
  if (TOUR_HIDDEN_TAB_PREFIXES.has(tabId)) return true;
  // A few tab ids differ from their route prefix — map them explicitly so the
  // list stays in ONE place (this file), not scattered in the UI.
  const tabToPrefix: Record<string, string> = {
    agentInstructions: "ai",       // Agent Instructions edits the AI prompts
    compliance: "consent",         // Compliance = DPDPA consent basis config
    catalogue: "media",            // Catalogue manages media/product assets
    whatsapp: "whatsapp-agent",    // WhatsApp Agent tab = whatsapp-agent config
    profile: "business-profile",   // Profile tab = business-profile config
    commandCenter: "copilot",      // Command Center = the master AI (owner-only)
  };
  const mapped = tabToPrefix[tabId];
  return Boolean(mapped && TOUR_HIDDEN_TAB_PREFIXES.has(mapped));
}
