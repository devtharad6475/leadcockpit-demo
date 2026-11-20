"use client";

import { formatDate as formatDateShared } from "@/lib/format-date";
import React, { useEffect, useRef, useState } from "react";
import { Panel, Row, Empty, StatusPill, Field, Chips, ProfileRows, LeadScoreChip } from "@/components/ui/primitives";
// 2026-07-21 (M1) — new design system primitives. Existing screens still
// use the legacy primitives above; new + rebuilt screens use these.
import { Card, Badge, EmptyState, useToast, Modal, PromptModal, ConfirmModal, Drawer, DrawerBody, DrawerFooter, Dropdown, DropdownItem, DropdownSeparator, Checkbox, Button, Tabs, TabPanel, ActionBar } from "@/components/ui";
// 2026-08-05 (UX Fix 6) — Skeleton for loading states (was built but never used).
import { Skeleton, Spinner } from "@/components/ui";
// 2026-07-21 (M2) — single source of truth for backend code → label.
import { enrichmentLabel, type EnrichmentLookupStatus } from "@/lib/enrichment-label";
import { campaignStatusLine } from "@/lib/campaign-status-line";
import { accountSummaryRows } from "@/lib/account-summary";
import { isAiScored } from "@/lib/lead-rules";
import { knowledgeAreaName } from "@/lib/knowledge-area-names";
import { displayLabel, displayLeadStatus, displayLeadStatusTone, displayCampaignStatus, displayCampaignApprovalStatus, displayReplyClassification, displayReviewStatus, displayLeadSource, leadScoreText, LEAD_SCORE_MAX } from "@/lib/display-labels";
// 2026-07-21 (M6/M7) — new screens live in their own files.
import { Tickets as TicketsSection } from "@/app/sections/Tickets";
import { StaffConversations } from "@/app/sections/StaffConversations";
import { Commercial as CommercialSection } from "@/app/sections/Commercial";
import { Catalogue as CatalogueSection } from "@/app/sections/Catalogue";
import { WorkspaceSettings as WorkspaceSection } from "@/app/sections/WorkspaceSettings";
import { Compliance as ComplianceSection } from "@/app/sections/Compliance";
import { Help as HelpSection } from "@/app/sections/Help";
import { IntegrationsSection } from "@/app/sections/IntegrationsSection";
import { StructuredSettingsPanel } from "@/app/sections/StructuredSettings";
import { QuestionsFromAI } from "@/app/sections/QuestionsFromAI";
import { WhatsAppAgentSettingsView } from "@/app/sections/WhatsAppAgentSettings";
import { AISettings } from "@/app/sections/AISettingsSection";
import { KnowledgeBase } from "@/app/sections/KnowledgeBaseSection";
// 2026-08-17 — operator-first shell (design project "Operator Dashboard UI
// Redesign", option 1b): one "Needs you" queue instead of 26 tabs to choose
// between, plus the AI's autonomy state pinned where it's always visible.
import { ManualCustomerForm } from "@/app/sections/ManualCustomerForm";
import { NeedsYou } from "@/app/sections/NeedsYou";
import { AutoReplyMark } from "@/app/sections/AutoReplyMark";
import { Assistant } from "@/app/sections/Assistant";
import { AIStatusChip } from "@/app/sections/AIStatusChip";
import { WhatTheBuyerToldUs } from "@/app/sections/BuyerFacts";
import {
  AlertTriangle, BarChart3, BookOpen, Bot, Brain, Check, Clipboard, Download, Eye, FileText, Globe, HelpCircle, Inbox, Layers3, Link2, LogOut,
  MessageCircle, MousePointer2, Network, RefreshCw, Search, Send, ShieldCheck, Sparkles,
  Plug, Settings, Upload, UserCircle, Users, Workflow, X,
  Package, AlertCircle, Trash2, Plus, ShoppingBag, Zap, Ticket as TicketIcon,
  MoreHorizontal, Compass, ChevronRight, ChevronLeft, Mail, History
} from "lucide-react";
import { ActivitySection } from "@/app/sections/Activity";
import { AgentGuidance } from "@/app/sections/AgentGuidance";
import { Analytics } from "@/app/sections/Analytics";
// Stage A+ / Cluster 10a (P2-3 + P2-4): shared api() + apiForm() chokepoints
// — replaces the 6 divergent local copies. P2-4: apiForm now parses error
// bodies (was throwing generic "Request failed (status)" with no server msg).
import { api, apiForm, getTruncations, clearTruncations, isRateLimitError } from "@/lib/api-client";
import { PAGE_INTROS } from "@/app/page-intros";

import type { MinRole } from "@/lib/rbac-map";
import { canReadWorkspacePath, canViewWorkspaceTab, workspaceLandingTab } from "@/lib/workspace-ui-access";
import { copyToClipboard } from "@/lib/clipboard";
import { replyDeliveryState, type ReplyDeliveryTone } from "@/lib/reply-delivery-state";
import { ownerFacingFailureText } from "@/llm/provider-failure";
import { PIPELINE_STAGES, statusesForStage, stageKeyForStatus } from "@/lib/lead-pipeline";
import type { AutoReplyLog, BusinessProfile, Campaign, DashboardIntelligence, ICP, Lead, LeadActivityEvent, LeadReviewDecision, MediaCatalogItem, MessageTemplate, Reply } from "@/lib/types";

type DashboardState = {
  workspace: { name: string; businessName?: string };
  profile?: BusinessProfile;
  activeCampaigns: Campaign[];
  totalLeads: number;
  hotLeads: number;
  pendingReviews: number;
  followUpsDue: number;
  recentReplies: Reply[];
  recommendedNextAction: string;
  agentRuns: { id: string; agentName: string; status: string }[];
};

type FollowupRadarLead = Lead & { daysSinceContact: number };
type FollowupRadarResponse = { count: number; leads: FollowupRadarLead[] };
type LeadActivityTimeline = { leadId: string; events: LeadActivityEvent[] };

/**
 * WHICH CUSTOMER THIS BROWSER IS LOOKING AT (P0-TENANT, 2026-08-24).
 *
 * THE BUG THIS CLOSES - and it was not a small one.
 * ------------------------------------------------
 * This was `export const workspaceId = "workspace_demo"`, with a TODO next to it
 * saying it should come from the session one day. Ninety call sites across the
 * screens send that value in the body of a write.
 *
 * Meanwhile July's Cluster B fix taught the server to REJECT, with 403, any
 * write whose body names a workspace different from the session's. That fix is
 * correct. Together the two halves destroy each other. Measured against the real
 * resolver, with a real customer's session:
 *
 *   body "workspace_demo" + session ws_acme_pipes
 *     -> {"ok":false,"status":403,"code":"FORBIDDEN"}
 *   body "ws_acme_pipes"  + session ws_acme_pipes
 *     -> {"ok":true,"workspaceId":"ws_acme_pipes"}
 *
 * So with AUTH_MODE=production - which is exactly what shipping to a client
 * means - every save, approve, send, edit and delete from the screens was
 * refused. All ninety of them. The first paying customer would have met a
 * completely broken product on their first click.
 *
 * Why a month of testing never saw it: `.env` says AUTH_MODE="demo", and demo
 * mode deliberately bypasses the check, which makes the hardcoded value correct
 * by accident. We had been testing the one configuration in which the bug cannot
 * appear. Hence the standing rule that came out of this: every test that CAN run
 * in production auth mode MUST also run in production auth mode.
 *
 * HOW THIS WORKS NOW
 * ------------------
 * `let`, not `const`, and deliberately so. ES modules export LIVE bindings, so
 * the eight section files that `import { workspaceId }` see the real value the
 * moment boot sets it - no prop-drilling through ninety call sites, no context
 * provider wrapped around a 4,762-line component, no rewrite of code that is
 * about to be reviewed screen by screen in Stage 4 anyway.
 *
 * Two rules make that safe, and both are enforced below rather than trusted:
 *   1. Only `adoptWorkspaceId` may write it. One writer, one place to audit.
 *   2. Nothing may READ it before boot has set it. Every one of the ninety
 *      call sites lives in an event handler or an effect, and the shell does not
 *      render its sections until `workspaceReady` is true, so no handler can
 *      fire against a stale value.
 *
 * The starting value is still the demo workspace, because in demo mode that IS
 * the right answer and the server ignores the body anyway. It is a default, not
 * an assumption: in production it is overwritten from the session before
 * anything renders, and if the session carries no workspace we refuse to
 * continue rather than quietly writing into the demo tenant.
 *
 * Pinned by scripts/golden/golden-tenant-identity.ts.
 */
export const DEMO_WORKSPACE_ID = "workspace_demo";

// eslint-disable-next-line prefer-const -- deliberately reassignable; see above.
export let workspaceId: string = DEMO_WORKSPACE_ID;

/**
 * The ONLY writer of `workspaceId`. Takes what /api/auth/status reported for the
 * signed-in user and adopts it as this browser's identity.
 *
 * Returns false when production mode produced no workspace at all. The caller
 * MUST treat that as a hard stop: falling back to the demo workspace there would
 * point a real customer's writes at demo data, which is the exact cross-tenant
 * accident the 403 exists to prevent.
 */
export function adoptWorkspaceId(
  sessionWorkspaceId: string | undefined,
  authMode: string,
): boolean {
  if (typeof sessionWorkspaceId === "string" && sessionWorkspaceId.trim()) {
    workspaceId = sessionWorkspaceId.trim();
    return true;
  }
  // Demo and local have no session; the demo workspace is the correct answer.
  if (authMode !== "production") {
    workspaceId = DEMO_WORKSPACE_ID;
    return true;
  }
  return false;
}

const tabs = [
  // 2026-08-17 — the landing screen. Everything genuinely waiting on a human,
  // in one queue. See src/app/sections/NeedsYou.tsx.
  ["needsYou", "Needs you", Inbox],
  // 2026-09-24 — the master AI's own page. See src/app/sections/Assistant.tsx.
  ["commandCenter", "Assistant", Network],
  ["dashboard", "Dashboard", BarChart3],
  ["onboarding", "Onboarding", Globe],
  ["profile", "Profile", FileText],
  ["knowledge", "Knowledge Base", BookOpen],
  ["icp", "Ideal Customers", Users],
  ["campaign", "Campaign", Workflow],
  ["discovery", "Discovery", Search],
  ["review", "Lead Review", ShieldCheck],
  ["crm", "Leads", Layers3],
  ["messages", "Messages", MessageCircle],
  ["replies", "Replies", Mail],
  ["tickets", "Tickets", AlertCircle],
  ["commercial", "Quotes & Orders", ShoppingBag],
  ["catalogue", "Catalogue", Package],
  ["workspace", "Workspace", Zap],
  // 2026-09-28 — "who did what" (owner/admin). See src/app/sections/Activity.tsx.
  ["activity", "Activity", History],
  ["compliance", "Compliance", ShieldCheck],
  ["analytics", "Analytics", BarChart3],
  ["whatsapp", "WhatsApp Agent", MessageCircle],
  ["unknown", "Questions from AI", AlertTriangle],
  ["reviewQueue", "AI Drafts", ShieldCheck],
  ["ai", "AI Settings", Brain],
  ["agentInstructions", "Agent Instructions", Bot],
  ["integrations", "Integrations", Plug],
  ["settings", "Settings", Settings],
  ["exportBackup", "Export / Backup", Download],
  ["help", "Help & Support", HelpCircle],
] as const;

export type TabId = (typeof tabs)[number][0];

/**
 * 2026-08-17 — Navigation IA, second pass.
 *
 * Supersedes the 2026-07-21 (M3) five-group layout. That version was an
 * improvement on a flat 26-item list, but it still put 26 links on screen at
 * once and asked the operator to pick one. The design project "Operator
 * Dashboard UI Redesign" (option 1b) is explicit about the cost: the operator
 * lands and still has to decide where to go, on a product whose whole premise
 * is that the AI decides for them and only interrupts when it must.
 *
 * The shape now:
 *
 *   Needs you   — a LEAF, not a group. The default landing screen and the
 *                 only one an operator has to visit on a normal day.
 *   ...then five collapsed drawers, each opening only when you want it:
 *   Conversations — everything a customer is currently in the middle of
 *   Customers     — the record + the money on it
 *   Prospecting   — finding new customers
 *   Knowledge     — what the AI knows and where it got it
 *   Controls      — numbers, configuration, compliance, export, help
 *
 * No tab was removed: all 26 remain reachable, they're just no longer all
 * shouting at once. The AI-autonomy state that used to be buried at the
 * bottom of Controls → AI Settings is now pinned under the nav (AIStatusCard)
 * because it is the one thing the operator must be able to see and stop
 * without navigating anywhere.
 */
const tabGroups: Array<[string, TabId[], React.ComponentType<{ className?: string }>]> = [
  ["Conversations", ["replies", "messages", "tickets", "reviewQueue"], MessageCircle],
  ["Customers", ["crm", "commercial"], Layers3],
  ["Prospecting", ["icp", "campaign", "discovery", "review"], Workflow],
  ["Knowledge", ["onboarding", "profile", "knowledge", "catalogue", "unknown"], BookOpen],
  // N-UI-7 (2026-08-31, CEO-approved) — "Controls" used to hold ALL ELEVEN of
  // the screens below in one drawer. It was a junk drawer: the name told the
  // operator nothing, so the only way to find out what was inside was to open
  // it and read eleven unrelated labels. Split into three groups whose NAMES
  // carry the information, which is the real fix — the one-line preview added
  // in N-UI-4 was making an unreadable group legible rather than fixing it.
  ["Business performance", ["dashboard", "analytics"], BarChart3],
  ["AI & channels", ["ai", "whatsapp", "agentInstructions", "integrations"], Sparkles],
  ["Workspace & admin", ["workspace", "activity", "compliance", "settings", "exportBackup", "help"], Settings],
];

export default function Home() {
  // 2026-08-17 — the operator lands on their queue, not on a page of numbers.
  const [requestedActive, setActive] = useState<TabId>("needsYou");
  const [authMode, setAuthMode] = useState<"demo" | "local" | "production" | null>(null);
  const [authLoadError, setAuthLoadError] = useState<string | null>(null);
  // CP-20 (2026-08-02) — capture the authed user (role + isTour) so the shell
  // can render read-only tour chrome (banner, hidden tabs, disabled actions)
  // for a public tour visitor. Pre-fix this was discarded; the shell didn't
  // know the role. The backend RBAC 403 is still the real gate.
  const [authUser, setAuthUser] = useState<{ id?: string; role?: MinRole; name?: string; email?: string; isTour?: boolean; workspaceId?: string } | null>(null);
  const authAccessRef = useRef<{ role: MinRole; isTour: boolean }>({ role: 'owner', isTour: false });
  const userRole: MinRole = authUser?.role ?? (authMode === 'production' ? 'viewer' : 'owner');
  const tourSession = authUser?.isTour === true;
  const active: TabId = canViewWorkspaceTab(userRole, requestedActive, tourSession)
    ? requestedActive : workspaceLandingTab(userRole, tourSession);
  const logoutInFlight = useRef(false);
  const activeSectionRef = useRef(active);
  useEffect(() => { activeSectionRef.current = active; }, [active]);
  const autoReplyLoadVersionRef = useRef(0);

  // How many things the queue currently holds. Owned here (not inside the
  // section) so the sidebar badge and the page title show the SAME number as
  // the list itself — a nav badge that disagrees with the screen is worse
  // than no badge. `null` = not counted yet; render nothing rather than "0".
  const [needsYouCount, setNeedsYouCount] = useState<number | null>(null);
  // 2026-08-05 VISUAL REFRESH Round 1 — collapsible nav groups.
  // 2026-08-17: every group now starts collapsed. With "Needs you" as the
  // landing screen the sidebar's job on first paint is to stay quiet — six
  // rows, not twenty-six links. The group containing the ACTIVE tab is still
  // force-expanded below, so navigating anywhere opens the right drawer.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(tabGroups.map(([group]) => group)),
  );
  // The group that contains the currently-active tab. Computed each render.
  const activeGroup = tabGroups.find(([, ids]) => ids.includes(active))?.[0];
  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }
  // N-UI-2 (2026-08-31) — THE BUG THE CEO REPORTED: a group could be opened but
  // never closed. `isGroupExpanded` used to hard-return `true` for the group
  // holding the active tab, so `toggleGroup` flipped the Set underneath and the
  // render ignored it — click, click, click, still open. The intent ("navigating
  // opens the right drawer") was right; expressing it as an override that beats
  // the operator's own click every render was wrong.
  //
  // Now `collapsedGroups` is the ONLY source of truth and the click always wins.
  // Navigation opens the group ONCE, at the moment the active group actually
  // changes — it is never re-asserted on later renders, which is what made the
  // old version unclosable.
  //
  // Why this keys on `activeGroup` and not on a line inside `navTo`: `setActive`
  // is called from 11 places and only 2 go through `navTo` (the rest are the
  // "Open this screen" buttons on the landing page). Keying on the derived group
  // covers all 11 and cannot drift when a 12th is added.
  //
  // Adjusted DURING RENDER rather than in an effect. This is React's documented
  // "adjust state when a value changes" pattern: React discards this render and
  // immediately re-runs it, so the sidebar never paints in the stale state — an
  // effect would paint the closed group first and reopen it a frame later. It
  // also keeps `react-hooks/set-state-in-effect` satisfied honestly rather than
  // by suppression.
  const [lastAutoOpened, setLastAutoOpened] = useState<string | undefined>(activeGroup);
  if (activeGroup !== lastAutoOpened) {
    setLastAutoOpened(activeGroup);
    if (activeGroup && collapsedGroups.has(activeGroup)) {
      const next = new Set(collapsedGroups);
      next.delete(activeGroup);
      setCollapsedGroups(next);
    }
  }
  function isGroupExpanded(group: string) {
    return !collapsedGroups.has(group);
  }
  // 2026-07-21 (Cluster G fix, session 19) — wire the toast system that
  // was mounted in layout.tsx but never used. Errors + successes now flow
  // to stacked toasts (top-right, persistent for errors) instead of the
  // 1-line StatusPill that got overwritten by the next action.
  // Pinned by e2e/toast-wiring.spec.ts.
  const { toast } = useToast();
  // 2026-07-21 (M3) — mobile drawer state. The old UI had 20 tabs in a
  // horizontal scroll on mobile = unusable. Replaced with a hamburger
  // drawer that reveals the same 5 role-based groups as the desktop sidebar.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  // P0-TENANT — false until this browser knows WHICH customer it is. The
  // sections do not render until it is true, so none of the ~90 write call
  // sites can fire against a workspace we have not confirmed.
  const [workspaceReady, setWorkspaceReady] = useState(false);
  // Cluster 8 / P1-14 + 2026-08-05 audit fix (F-UI-25): the mobile nav drawer
  // is role="dialog" aria-modal="true". Pre-F-UI-25 it only handled Escape — a
  // keyboard user could Tab past it into the aria-hidden background content
  // (WCAG 2.4.3 Focus Order). Now mirrors the Modal primitive exactly: focus
  // moves into the drawer on open + is restored to the trigger on close, and
  // Tab/Shift+Tab cycle within the drawer (true focus trap).
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    // Move focus into the drawer + remember the trigger to restore on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = drawer.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !drawer.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !drawer.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = originalOverflow;
      previouslyFocused?.focus();
    };
  }, [drawerOpen]);
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
  const [state, setState] = useState<DashboardState | null>(null);
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [icps, setIcps] = useState<ICP[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<MessageTemplate[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [autoReplyLogs, setAutoReplyLogs] = useState<AutoReplyLog[]>([]);
  const [mediaItems, setMediaItems] = useState<MediaCatalogItem[]>([]);
  const [dashboardIntelligence, setDashboardIntelligence] = useState<DashboardIntelligence | null>(null);
  const [followupRadar, setFollowupRadar] = useState<FollowupRadarResponse>({ count: 0, leads: [] });
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("Ready");
  /**
   * N-SEC-3 — the exact text loadAll last put in the notice strip because the
   * workspace failed to load. Kept so a later SUCCESSFUL load can retract it,
   * and only it: clearing the strip unconditionally would wipe whatever the
   * operator's own last action had reported there.
   */
  const bootNoticeRef = useRef<string | null>(null);
  // 2026-08-02 audit P2-2 fix — "current focus" memory that survives navigation.
  // Pre-fix the Replies section always opened the FIRST approved lead (line ~162)
  // regardless of which lead the operator was viewing, and there was no way to
  // drill from a Lead to its Conversation/Order/Ticket. Now clicking a lead's
  // drill-down button sets focusLeadId + navigates; the destination reads it.
  const [focusLeadId, setFocusLeadId] = useState<string>("");
  const [analyticsCampaignId, setAnalyticsCampaignId] = useState("");
  const [returnToAnalytics, setReturnToAnalytics] = useState(false);
  // FIX #3 (2026-08-02 walkthrough): a CRM status filter that the Dashboard
  // number cards can set, so clicking "Approved: 13" jumps to the CRM already
  // filtered to approved leads (not just the unfiltered list). Mirrors the
  // focusLeadId cross-tab-memory pattern. Cleared when the user picks "All".
  const [crmStatusFilter, setCrmStatusFilter] = useState<string>("");
  const [ticketAssigneeId, setTicketAssigneeId] = useState('');
  const [workspaceInitialSection, setWorkspaceInitialSection] = useState('workspace-messages');
  // Navigate to a section with a lead in focus. The "Everything Connected" rule:
  // jump Lead→Replies/Commercial/Tickets in one click, destination pre-filtered.
  function focusOnLead(leadId: string, section: TabId) {
    if (!canViewWorkspaceTab(userRole, section, tourSession)) { setNotice('Ask your company owner to handle this action.'); return; }
    setTicketAssigneeId('');
    setFocusLeadId(leadId);
    setActive(section);
  }
  // 2026-08-05 N-P2-1: manual nav (sidebar click) clears the lead focus so a
  // stale focusLeadId from a prior drill-down doesn't silently filter the
  // destination screen. Drill-downs use focusOnLead (keeps the focus); manual
  // nav uses navTo (clears it). Without this, "view Commercial" could show
  // only 1 customer's orders with no explanation of why.
  function navTo(section: TabId) {
    setReturnToAnalytics(false);
    if (!canViewWorkspaceTab(userRole, section, tourSession)) { setNotice('Ask your company owner to handle this action.'); return; }
    setTicketAssigneeId('');
    setFocusLeadId("");
    setActive(section);
  }
  // 2026-08-05 UX audit (Place-Preservation): scrolling deep into the CRM table
  // (or any long list) then clicking a nav item left the window stranded at the
  // old scroll offset — the new screen appeared blank or mid-content. Scroll to
  // top on every section switch so each screen opens at its heading.
  useEffect(() => { window.scrollTo({ top: 0, behavior: "auto" }); }, [active]);
  // Cluster 5 P1-11: boot-error escape hatch. If the critical /api/state
  // fetch fails entirely, the dashboard used to stick on "Loading workspace
  // data..." forever (only fired a notice when ≥4 sections failed). Now we
  // track a hard boot error so the Dashboard can swap to "Couldn't load +
  // Retry" instead of an infinite spinner.
  const [bootError, setBootError] = useState<string | null>(null);
  /**
   * Increments once per loadAll attempt. Used only as the remount key for
   * WorkspaceLoadFailed, so its countdown restarts on every attempt — including
   * two consecutive failures that happen to carry the same message.
   */
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadGenerationRef = useRef(0);

  // 2026-08-05 (audit F-8): lists the server had to CAP because this workspace
  // has outgrown the bare-array contract. Several figures on this page are
  // computed by filtering these arrays client-side, so a capped array would
  // render a confidently wrong number. When this is non-empty the shell shows a
  // banner instead of letting the numbers lie. Empty in every normal workspace.
  const [truncatedLists, setTruncatedLists] = useState<Array<{ url: string; returned: number; total: number }>>([]);

  async function loadKnowledge() {
    const generation = loadGenerationRef.current;
    const loadingWorkspace = workspaceId;
    const loadedDocuments = await api<KnowledgeDocument[]>("/api/knowledge/documents");
    if (generation === loadGenerationRef.current && loadingWorkspace === workspaceId) setDocuments(loadedDocuments);
  }

  const selectedIcp = icps.find((icp) => icp.status === "selected") || icps[0];
  // 2026-09-09: was `campaigns[0]` — repository order, so the OLDEST campaign
  // won for the life of the workspace. The ICP is chosen explicitly, the
  // campaign was not chosen at all, and Discovery reads its search phrases off
  // this one. On the live demo that put "Kind of company we want: Surat /
  // Gujarat machine embroidery and job-work units" directly above the phrases
  // "Cloud ERP software for wholesale distributors United States" — the
  // previous tenant's campaign — and a search would have gone looking for the
  // wrong companies on the right screen. A campaign belongs to an ICP, so the
  // one for the chosen ICP wins; failing that, the most recent, because a plan
  // just generated is the one the owner is looking at.
  const newestCampaigns = [...campaigns].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const selectedCampaign = newestCampaigns.find((item) => item.icpId && item.icpId === selectedIcp?.id)
    || newestCampaigns[0];
  // 2026-08-02 audit P2-2: prefer the operator's focused lead (set by a
  // drill-down click); fall back to the first approved lead only when no focus
  // is active. Pre-fix this always returned the first approved lead, so the
  // Replies section never reflected the lead the operator was looking at.
  // 2026-08-05 W-P1-1: the fallback used to pick the first approved lead,
  // which in the demo is "lead_review" — a seed lead with NO companyName. The
  // Copilot then silently bound quotes to a nameless lead with zero feedback.
  // Now the fallback skips leads with no displayable name (companyName OR
  // contactName) so the Copilot context is never a mystery junk lead.
  const selectedLead = (focusLeadId && leads.find((l) => l.id === focusLeadId))
    || leads.find((lead) => lead.reviewStatus === "approved" && (lead.companyName || lead.contactName))
    || leads.find((lead) => lead.companyName || lead.contactName)
    || leads[0];

  // 2026-08-05 (audit U-1) — the lead the owner ACTUALLY chose, with no
  // fallback guessing.
  //
  // `selectedLead` above deliberately falls back so that browsing screens
  // (Replies, Commercial) always have something to show. That is fine for a
  // read-only view and wrong for the Copilot, which BINDS ACTIONS to it: the
  // panel was handing `selectedLead` to the Copilot, so opening it on a fresh
  // session showed "Context: Aarna Bridal Studio" for a lead the owner had
  // never selected. The owner then types "Raj wants a quote for 500m" and the
  // draft attaches to Aarna.
  //
  // The August 5 W-P1-1 fix only stopped the fallback picking a NAMELESS lead;
  // it still picked one. A named wrong customer is arguably worse, because it
  // looks deliberate.
  //
  // OwnerCopilotService already handles an absent leadId by asking which
  // customer this is about (service lines 656/689/702), which is exactly the
  // behaviour the product contract wants — the owner owns every decision.
  const explicitlyFocusedLead = focusLeadId ? leads.find((l) => l.id === focusLeadId) : undefined;
  async function loadAll(tourMode = false) {
    const generation = ++loadGenerationRef.current;
    const replyVersion = ++autoReplyLoadVersionRef.current;
    const loadingWorkspace = workspaceId;
    const access = { ...authAccessRef.current };
    const isCurrentLoad = () => generation === loadGenerationRef.current
      && loadingWorkspace === workspaceId
      && access.role === authAccessRef.current.role
      && access.isTour === authAccessRef.current.isTour;
    setLoadAttempt((n) => n + 1);
    // F-8: reset the truncation ledger so the banner reflects THIS load, not a
    // stale one from before the operator deleted rows.
    clearTruncations();
    // Phase 5.2: use Promise.allSettled instead of Promise.all. A single failed
    // endpoint (e.g. dashboard/intelligence timing out) used to reject the whole
    // Promise.all and leave the dashboard blank. allSettled lets the rest of the
    // sections render even if one fails. We only surface a notice if a majority
    // of the core sections failed — that signals a real connectivity problem.
    //
    // CP-20 (2026-08-02) — a tour viewer is 403'd on several admin/owner GETs
    // (business-profile, media, auto-reply-logs, outreach-queue, messages).
    // Fetching them would log noisy 403s to the console even though the tabs
    // are hidden. Skip them for a tour viewer so the boot is clean (the backend
    // 403 is still the real gate; this just avoids spamming the console with
    // expected rejections). tourMode is passed in (not read from state) because
    // loadAll() is called in the same tick as setAuthUser, before the state
    // update is visible (React stale-closure).
    // For a tour viewer, the sensitive fetches resolve to empty; otherwise
    // they run normally. Keeping a stable shape (never undefined) so the
    // destructure below stays simple.
    const SKIP = Promise.resolve(null);
    const permitted = <T,>(url: string) => canReadWorkspacePath(access.role, url) ? api<T>(url) : SKIP;
    // Each screen can use its own completed read immediately. Retain allSettled
    // for the complete verdict, without making core data wait for optional panels.
    const publish = <T,>(request: Promise<T>, apply: (data: T) => void, failed?: (error: unknown) => void) => request.then(
      data => { if (isCurrentLoad()) { apply(data); setTruncatedLists(getTruncations()); } return data; },
      error => { if (isCurrentLoad()) failed?.(error); throw error; },
    );
    const clearBootFailure = () => {
      setBootError(null);
      if (bootNoticeRef.current) {
        const stale = bootNoticeRef.current;
        bootNoticeRef.current = null;
        setNotice(current => current === stale ? 'Ready' : current);
      }
    };
    const results = await Promise.allSettled([
      publish(api<DashboardState>("/api/state"), data => { setState(data); clearBootFailure(); }, error => {
        setBootError(error instanceof Error ? error.message : "Couldn't load your workspace.");
      }),
      // No workspace id in the path. It used to say "workspace_demo" here, on the
      // first fetch every signed-in customer makes. That worked only because the
      // GET route ignored the segment and answered from the session instead --
      // so a real customer was asking for the demo tenant's profile by name and
      // being saved by the route's laxness. Scoping is session-derived; say so.
      publish(tourMode ? SKIP : permitted<BusinessProfile>("/api/business-profile"), setProfile),
      publish(permitted<ICP[]>("/api/icp"), data => setIcps(data ?? []), () => setIcps([])),
      publish(api<Campaign[]>("/api/campaigns"), setCampaigns, () => setCampaigns([])),
      publish(api<Lead[]>("/api/leads"), setLeads, () => setLeads([])),
      publish(tourMode ? SKIP : permitted<MessageTemplate[]>("/api/messages"), data => setMessages(data ?? []), () => setMessages([])),
      publish(api<Reply[]>("/api/replies"), setReplies, () => setReplies([])),
      publish(tourMode ? SKIP : permitted<AutoReplyLog[]>("/api/auto-reply-logs"), data => { if (replyVersion === autoReplyLoadVersionRef.current) setAutoReplyLogs(data ?? []); }, () => { if (replyVersion === autoReplyLoadVersionRef.current) setAutoReplyLogs([]); }),
      publish(tourMode ? SKIP : permitted<MediaCatalogItem[]>("/api/media"), data => setMediaItems(data ?? []), () => setMediaItems([])),
      publish(api<DashboardIntelligence>("/api/dashboard/intelligence"), setDashboardIntelligence),
      publish(api<FollowupRadarResponse>("/api/followup-radar"), setFollowupRadar),
    ]);
    if (!isCurrentLoad()) return;
    const [stateR, , , campaignR] = results;

    // CP-20 — value() now also falls back when the result is null (a tour-viewer
    // SKIP resolves to null), so the array setters get [] not null.
    const value = <T,>(r: PromiseSettledResult<T | null>, fallback: T): T =>
      r.status === "fulfilled" && r.value !== null ? r.value : fallback;
    const failureReasons = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));

    const campaignData = value(campaignR, []);
    // 2026-09-28 — Needs you v2: the header badge reads the SAME server count
    // as the screen and the morning summary, on every load (it used to appear
    // only after the Needs you screen had been opened).
    if (authAccessRef.current.role === 'owner') void api<{ count: number }>("/api/needs-you?countOnly=1")
      .then((r) => { if (isCurrentLoad()) setNeedsYouCount(r.count); })
      .catch(() => undefined);

    // F-8: read the ledger AFTER all list fetches have settled.
    setTruncatedLists(getTruncations());

    // Record the verdict on THIS load before doing anything else that can fail.
    //
    // N-SEC-3 (2026-09-03) — this block used to sit at the very END of the
    // function, after `await loadKnowledge()`. When the whole workspace was
    // failing, loadKnowledge failed too, threw, and took the rest of loadAll
    // with it — so the one line that records "the workspace did not load" was
    // never reached. The caller's `.catch` put the message in the notice strip
    // and nothing else knew anything had gone wrong, which is how a screen
    // could go on rendering a confident "Nothing needs you" over data it had
    // never received.
    //
    // The rule this encodes: a function that reports a verdict must reach the
    // verdict before it does any further work that can throw.
    //
    // Only /api/state counts — it is the load-bearing fetch nothing else can
    // render without. A single optional endpoint failing still degrades to its
    // own empty state, exactly as before.
    if (stateR.status === "rejected") {
      const reason = stateR.reason instanceof Error ? stateR.reason.message : "Couldn't load your workspace.";
      setBootError(reason);
      if (failureReasons.length >= 4) {
        setNotice(reason);
        bootNoticeRef.current = reason;
      }
    } else {
      // Successful load clears any prior boot error (e.g. after a Retry click).
      setBootError(null);
      // ...and retracts the message that failure left in the notice strip. It
      // is a statement about the system's current condition ("Too many
      // requests, try again in 39s"), so leaving it up after a successful load
      // states something that has stopped being true. Only OUR message is
      // retracted — if the operator has done something since, their result
      // stays.
      if (bootNoticeRef.current) {
        const stale = bootNoticeRef.current;
        bootNoticeRef.current = null;
        setNotice((current) => (current === stale ? "Ready" : current));
      }
    }

    // Everything past here is supplementary: it enriches the screens but its
    // failure must not erase the verdict recorded above, so each part carries
    // its own guard.
    try {
      if (canReadWorkspacePath(access.role, '/api/knowledge/documents')) {
        const loadedDocuments = await api<KnowledgeDocument[]>('/api/knowledge/documents');
        if (isCurrentLoad()) setDocuments(loadedDocuments);
      }
      else setDocuments([]);
    } catch (knowledgeError) {
      // Knowledge documents are their own section with its own empty state.
      // A failure here is not a reason to abandon the rest of the load.
      console.warn("Knowledge documents did not load:", knowledgeError instanceof Error ? knowledgeError.message : knowledgeError);
    }
    if (!isCurrentLoad()) return;
  }

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        // Session 1 audit: detect auth mode + existing session before deciding
        // whether to show the login screen. In production we rely on the signed
        // session cookie; in demo/local the localStorage flag still works.
        const status = await api<{ authMode: string; bootstrapped: boolean; authenticated: boolean; user?: { id?: string; role?: MinRole; name?: string; email?: string; isTour?: boolean; workspaceId?: string } }>("/api/auth/status");
        setAuthMode(status.authMode as "demo" | "local" | "production");
        setBootstrapped(status.bootstrapped);
        // CP-20 — capture the tour flag + role so the UI can adapt.
        setAuthUser(status.user ?? null);
        authAccessRef.current = { role: status.user?.role ?? (status.authMode === 'production' ? 'viewer' : 'owner'), isTour: status.user?.isTour === true };
        if (status.user) setActive(workspaceLandingTab(authAccessRef.current.role, authAccessRef.current.isTour));
        // P0-TENANT — adopt THIS user's workspace before anything renders or
        // loads. Until this line ran, every write the screens made carried the
        // hardcoded demo workspace and was 403'd in production. Ordering is
        // load-bearing: it must precede both setLoggedIn and loadAll, because
        // loadAll immediately issues reads and the sections mount right after.
        // N-AUTH-1 (2026-09-07) — this refusal must only fire for a session
        // that actually EXISTS. `adoptWorkspaceId(undefined, "production")`
        // returns false by design, and a signed-out visitor in production mode
        // has no `status.user` at all — so the guard fired on every first visit,
        // wiped authMode to null, and LoginScreen fell through to its
        // `!isProduction` branch: the demo screen. The owner-setup form could
        // never render, so the first owner could never be created, so nobody
        // could ever authenticate. A closed loop that made a correctly
        // configured production deployment unreachable — /api/auth/status was
        // returning 200 with authMode "production" the whole time.
        //
        // The check below is the one this was always meant to be: signed in,
        // but carrying no workspace. That case still refuses, and still refuses
        // loudly, because falling back to the demo workspace would aim a real
        // customer's writes at demo data.
        const adopted = adoptWorkspaceId(status.user?.workspaceId, status.authMode);
        if (!adopted && status.authenticated) {
          setNotice(
            "Signed in, but this account has no workspace attached. Nothing was loaded. "
            + "Contact your administrator — continuing would risk writing into the wrong account.",
          );
          setAuthMode(null);
          setLoggedIn(false);
          return;
        }
        // Only mark the workspace ready when one was genuinely adopted. A
        // signed-out production visitor has none, and must not be treated as
        // though it does — the login screen renders before the `workspaceReady`
        // gate, so this costs them nothing.
        if (adopted) setWorkspaceReady(true);
        // CP-20 — derive tourMode from the FRESH status (not state, which lags
        // a tick) so loadAll skips the viewer-403 endpoints on the very first boot.
        const freshTour = status.user?.role === "viewer" && status.user?.isTour === true;
        if (status.authMode === "production") {
          if (status.authenticated) {
            setLoggedIn(true);
            await loadAll(freshTour).catch((error) => setNotice(error.message));
          }
          // Otherwise stay on login screen — do NOT auto-load demo data.
        } else {
          if (window.localStorage.getItem("leadcockpit_demo_login") === "true") {
            setLoggedIn(true);
          }
          await loadAll(freshTour).catch((error) => setNotice(error.message));
        }
      } catch (error) {
        // Phase 5.11 audit fix: FAIL CLOSED. The previous behavior fell back to
        // demo mode whenever /api/auth/status itself errored (network blip, 500,
        // etc.). In a production deployment that silently dropped the user into
        // demo mode and auto-loaded demo data — a real information-leak / bypass
        // risk if the status endpoint can be made to fail.
        //
        // Now: if we cannot determine the auth mode, we do NOT assume demo. We
        // surface the error and let the user retry. Demo mode is only entered
        // when the server explicitly reports a non-production authMode.
        // N-SEC-2 (2026-09-03) — "busy" is not "unauthenticated".
        //
        // The fail-closed rule below is right and stays: if we cannot establish
        // the auth mode we must NOT render data. But a 429 is not an unknown
        // auth state — the server knows exactly who we are and is declining
        // volume for a few seconds. Treating it as an auth failure is what made
        // every refresh during a rate-limit block dump the operator on the login
        // screen, losing whatever they were doing. /api/auth/status is now on
        // the edge guard's exempt list so this should be unreachable; this is
        // the second lock on the same door, because the cost of being wrong
        // here is the operator losing their session.
        if (isRateLimitError(error)) {
          const wait = Math.min(Math.max(error.retryAfterSeconds ?? 5, 1), 60);
          setNotice(`The system is busy. Trying again in ${wait} second${wait === 1 ? "" : "s"}…`);
          window.setTimeout(() => window.location.reload(), wait * 1000);
          return;
        }
        const message = error instanceof Error ? error.message : "Could not reach the authentication service.";
        setNotice(`${message} Please check your connection and reload.`);
        setAuthLoadError("We could not check your sign-in. Check your connection and try again.");
        setAuthMode(null);
        setLoggedIn(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function run<T>(label: string, action: () => Promise<T>) {
    setBusy(label);
    setNotice(label);
    let actionResult: T | undefined;
    try {
      actionResult = await action();
    } catch (error) {
      // The ACTION itself failed — this is a real failure.
      const message = error instanceof Error ? error.message : "Something failed";
      setNotice(message);
      toast({ tone: "danger", title: `${label} failed`, description: message });
      setBusy("");
      return undefined;
    }
    // The action succeeded. Now reload dashboard data — if the reload fails,
    // that's NOT an action failure (the data was saved). Surface it honestly
    // as "completed, but couldn't refresh" instead of "{label} failed."
    // 2026-08-05 multi-agent audit E-P1-9: previously a single reload-endpoint
    // 500 among the 12 in loadAll() reported "{label} failed" → owner re-clicks
    // → possible duplicate action.
    setNotice(`${label} completed`);
    toast({ tone: "success", title: `${label} completed` });
    try {
      await loadAll();
    } catch (reloadError) {
      const reloadMsg = reloadError instanceof Error ? reloadError.message : "refresh failed";
      console.warn(`${label} succeeded but dashboard reload failed:`, reloadMsg);
      toast({ tone: "warning", title: "Couldn't auto-refresh", description: `${label} completed, but the workspace didn't refresh. Click the Refresh button to see latest data.` });
    }
    setBusy("");
    return actionResult;
  }

  function demoLogin() {
    try {
      window.localStorage.setItem("leadcockpit_demo_login", "true");
    } catch {
      setNotice("Demo session opened for this tab. Browser storage did not persist the login.");
    }
    // P0-TENANT — the third door, and the one that could hang.
    //
    // On a normal boot the effect above has already opened the gate, so this is
    // redundant. It is not redundant when /api/auth/status FAILED: that path
    // fails closed (authMode null, notice shown) without ever setting
    // workspaceReady, and the login screen still offers this button because it
    // only hides it in production. Clicking it would set loggedIn without the
    // gate ever opening, leaving the operator on "Opening your workspace…"
    // forever. Demo mode has no session, so the demo workspace is the correct
    // answer and adopt always succeeds here.
    adoptWorkspaceId(undefined, "demo");
    setWorkspaceReady(true);
    setLoggedIn(true);
    setNotice("Demo workspace opened");
    loadAll().catch((error) => setNotice(error.message));
  }

  // CP-20 (2026-08-02) — start a public read-only tour session. Calls the
  // production-only POST /api/auth/tour/start, which mints a viewer cookie on
  // workspace_demo. On success we reload so the new session takes effect
  // (the auth-status fetch then reports role:viewer + isTour:true, and the
  // shell renders tour chrome). Errors surface as a notice.
  async function startTour(): Promise<string | null> {
    try {
      const result = await api<{ ok: boolean; error?: { message?: string } }>("/api/auth/tour/start", { method: "POST" });
      if (result && result.ok) {
        // Reload so the tour cookie is picked up by the auth-status check.
        window.location.reload();
        return null;
      }
      const msg = result?.error?.message || "The demo tour couldn't start. Please try again.";
      setNotice(msg);
      return msg;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "The demo tour couldn't start.";
      setNotice(msg);
      return msg;
    }
  }

  /**
   * P0-TENANT — adopt the signed-in user's workspace after an INTERACTIVE login.
   *
   * The boot effect adopts the workspace for a session that already exists. This
   * is the other door: /api/auth/login succeeds and hands back only email + name,
   * so without this step a freshly logged-in production user kept the demo
   * workspace and every write they made was 403'd. Both doors now go through the
   * same adopt call, which is the point of having one.
   *
   * Returns an error message to show, or null on success.
   */
  async function syncSessionWorkspace(): Promise<string | null> {
    const status = await api<{ authMode: string; user?: { id?: string; role?: MinRole; name?: string; email?: string; isTour?: boolean; workspaceId?: string } }>("/api/auth/status");
    setAuthUser(status.user ?? null);
        authAccessRef.current = { role: status.user?.role ?? (status.authMode === 'production' ? 'viewer' : 'owner'), isTour: status.user?.isTour === true };
        if (status.user) setActive(workspaceLandingTab(authAccessRef.current.role, authAccessRef.current.isTour));
    if (!adoptWorkspaceId(status.user?.workspaceId, status.authMode)) {
      return "Signed in, but this account has no workspace attached. Nothing was loaded. "
        + "Contact your administrator — continuing would risk writing into the wrong account.";
    }
    setWorkspaceReady(true);
    return null;
  }

  async function realLogin(email: string, password: string, workspaceId?: string): Promise<LoginOutcome> {
    // Read directly (not through api()): the "which company?" answer is a 409
    // whose list of companies api() would throw away (2026-09-27).
    const response = await fetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(workspaceId ? { email, password, workspaceId } : { email, password }),
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    const result = await response.json().catch(() => null) as { ok: boolean; user?: { email: string; name: string }; chooseCompany?: LoginCompany[]; error?: { message?: string } } | null;
    if (result?.chooseCompany?.length) return { choices: result.chooseCompany };
    if (result && result.ok && result.user) {
      // P0-TENANT — adopt the workspace BEFORE loadAll and before rendering.
      // Order matters: loadAll reads immediately, and the sections mount next.
      const workspaceError = await syncSessionWorkspace();
      if (workspaceError) return workspaceError;
      setLoggedIn(true);
      setNotice(`Welcome, ${result.user.name || result.user.email}`);
      await loadAll().catch((error) => setNotice(error.message));
      return null;
    }
    return result?.error?.message || "Login failed. Check your email and password.";
  }

  async function realBootstrap(email: string, password: string, name: string) {
    const result = await api<{ ok: boolean; user?: { email: string; name: string }; error?: { message?: string } }>("/api/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
      headers: { "Content-Type": "application/json" },
    });
    if (result && result.ok && result.user) {
      // P0-TENANT — same adopt-before-load rule as realLogin.
      const workspaceError = await syncSessionWorkspace();
      if (workspaceError) return workspaceError;
      setLoggedIn(true);
      setNotice(`Owner account created. Welcome, ${result.user.name || result.user.email}`);
      await loadAll().catch((error) => setNotice(error.message));
      return null;
    }
    return result?.error?.message || "Account setup failed.";
  }

  async function logout() {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    if (authMode === "production") {
      try {
        // Finish clearing the old session before offering another sign-in.
        // A late logout response would otherwise clear the new login cookie.
        await api("/api/auth/logout", { method: "POST" });
      } catch {
        logoutInFlight.current = false;
        setNotice("Sign out could not be completed. Please try again.");
        return;
      }
    } else {
      try {
        window.localStorage.removeItem("leadcockpit_demo_login");
      } catch {
        // Demo logout should still reset this tab even if browser storage is blocked.
      }
    }
    // Invalidate every in-flight load before another account can render here.
    loadGenerationRef.current++;
    setState(null); setProfile(null); setIcps([]); setCampaigns([]); setLeads([]);
    setMessages([]); setReplies([]); setAutoReplyLogs([]); setMediaItems([]);
    setDashboardIntelligence(null); setFollowupRadar({ count: 0, leads: [] });
    setDocuments([]); setAnalyticsCampaignId(""); setReturnToAnalytics(false);
    setNeedsYouCount(null); setTruncatedLists([]); setBootError(null);
    bootNoticeRef.current = null;
    setFocusLeadId(''); setCrmStatusFilter(''); setTicketAssigneeId('');
    setLoggedIn(false);
    setActive("dashboard");
    // P0-TENANT — drop this browser's customer identity on the way out, so the
    // next person to sign in on this machine cannot inherit the last one's
    // workspace through the module-level binding.
    adoptWorkspaceId(undefined, "demo");
    setWorkspaceReady(false);
    setNotice("You have been signed out.");
    logoutInFlight.current = false;
  }

  if (!loggedIn) {
    return <LoginScreen authMode={authMode} authLoadError={authLoadError} bootstrapped={bootstrapped} onDemoLogin={demoLogin} onRealLogin={realLogin} onBootstrap={realBootstrap} onStartTour={startTour} />;
  }

  // P0-TENANT — signed in, but this browser does not yet know which customer it
  // is. Render nothing operable. Every one of the ~90 write call sites lives
  // below this line, so this gate is what makes the live `workspaceId` binding
  // safe: no handler can exist to fire against an unconfirmed workspace.
  if (!workspaceReady) {
    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="text-center">
          <Spinner />
          <p className="mt-3 text-sm text-muted-foreground">Opening your workspace…</p>
        </div>
      </main>
    );
  }

  // CP-20 (2026-08-02) — tour-mode derivations. isTour = a public read-only
  // visitor (viewer role + isTour flag from the signed session). canMutate =
  // the user may take mutating actions. The backend RBAC 403 is the real gate;
  // these drive the UI chrome only (banner, hidden tabs, disabled buttons).
  const isTour = authUser?.role === "viewer" && authUser?.isTour === true;
  const canMutate = userRole !== 'viewer';

  /**
   * 2026-08-17 — one nav tree, rendered by both the desktop sidebar and the
   * mobile drawer. These two used to be copy-pasted, so a change to the IA
   * had to be made twice and drifted in between. Written as a plain render
   * helper (not a nested component) so React doesn't remount the whole nav —
   * and lose keyboard focus — on every parent re-render.
   *
   * `onNavigate` lets the mobile drawer close itself after a jump.
   */
  function renderNavTree(onNavigate?: () => void) {
    return (
      <>
        {/* The leaf. Deliberately above the groups and visually distinct:
            on a normal day this is the only row the operator touches. */}
        {canViewWorkspaceTab(userRole, 'needsYou', isTour) ? (() => {
          const isActive = active === "needsYou";
          return (
            <button
              type="button"
              onClick={() => { navTo("needsYou"); onNavigate?.(); }}
              aria-current={isActive ? "page" : undefined}
              className={`mb-3 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition-colors ${isActive ? "bg-primary text-white" : "text-foreground hover:bg-surface-muted"}`}
            >
              <Inbox className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">Needs you</span>
              {needsYouCount !== null && needsYouCount > 0 ? (
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${isActive ? "bg-white text-primary-strong" : "bg-primary-tint text-primary-strong"}`}>
                  {needsYouCount}
                </span>
              ) : null}
            </button>
          );
        })() : null}

        {/* 2026-09-24 — the master AI, as a leaf of its own: it is where the
            owner gives work, not a setting, so it does not belong in a drawer.
            Owner-only on the server (copilot prefix); hidden from a tour. */}
        {canViewWorkspaceTab(userRole, 'commandCenter', isTour) ? (() => {
          const isActive = active === "commandCenter";
          return (
            <button
              type="button"
              onClick={() => { navTo("commandCenter"); onNavigate?.(); }}
              aria-current={isActive ? "page" : undefined}
              className={`mb-3 -mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition-colors ${isActive ? "bg-primary text-white" : "text-foreground hover:bg-surface-muted"}`}
            >
              <Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">Assistant</span>
            </button>
          );
        })() : null}

        {tabGroups.map(([group, ids, GroupIcon]) => {
          // CP-20 — hide secret/config tabs from a tour viewer (single source:
          // isTabHiddenForTour in rbac-map.ts). Empty groups collapse away.
          const visibleIds = ids.filter(id => canViewWorkspaceTab(userRole, id, isTour))
            // 2026-09-28 — the activity log is owner/admin only (the server
            // refuses others); don't offer a screen that can only say no.
            .filter((id) => id !== "activity" || !authUser?.role || authUser.role === "owner" || authUser.role === "admin");
          if (visibleIds.length === 0) return null;
          const expanded = isGroupExpanded(group);
          const holdsActive = visibleIds.includes(active);
          return (
            <div key={group}>
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                aria-expanded={expanded}
                // N-TEST-18 (2026-08-31) — a stable hook for the tests.
                // `full-ui-sweep-v2` found this drawer with
                // `button.textContent.trim() === "Controls"`. The N-UI-4
                // preview line appended the child screen names to that same
                // textContent, so the exact match stopped matching for ALL
                // SEVEN groups and every tab was reported "no drawer to open".
                // Visible prose is not an API: this attribute is, and it does
                // not move when the wording does.
                data-nav-group={group}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${holdsActive ? "text-foreground" : "text-muted-2"} hover:bg-surface-muted`}
              >
                <GroupIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {/* `min-w-0` is load-bearing, not decoration: a flex child's
                    default `min-width:auto` sizes it to its CONTENT, so the
                    `truncate` on the preview line below never engages and the
                    long "Controls" list stretches the row (measured 784px in a
                    256px sidebar) and shoves the chevron out of view. */}
                <span className="min-w-0 flex-1">
                  {group}
                  {/* N-UI-4 (2026-08-31) — the CEO: "for any particular tab I'm
                      not able to check what I will find under that." A group
                      name like "Controls" holding eleven unrelated screens is a
                      junk drawer you have to open to understand. This line names
                      what is inside, in the operator's own words.

                      Rendered ONLY while COLLAPSED: once the group is open the
                      real links are right there, so repeating them would spend
                      sidebar height saying something already on screen — the
                      exact cost that got the autonomy card moved out. */}
                  {!expanded ? (
                    // aria-hidden, deliberately. The accessible NAME of this
                    // button is computed from its text, so without this the
                    // group is announced as "Controls Dashboard · Analytics ·
                    // AI Settings · …" — and `getByRole("button", {name:
                    // "Controls", exact: true})` (e2e/helpers/nav.ts) stops
                    // matching, silently breaking every spec that navigates.
                    // Nothing is lost for a screen-reader user: expanding the
                    // group announces the same screens as real links.
                    <span aria-hidden="true" className="mt-0.5 block truncate text-[11px] font-normal leading-tight text-muted">
                      {visibleIds.map((id) => tabs.find(([tabId]) => tabId === id)![1]).join(" · ")}
                    </span>
                  ) : null}
                </span>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
              </button>
              {expanded && (
                <div className="mt-0.5 mb-1 space-y-0.5 pl-4">
                  {visibleIds.map((id) => {
                    const [, label] = tabs.find(([tabId]) => tabId === id)!;
                    const isActive = active === id;
                    return (
                      <button
                        key={id}
                        onClick={() => { navTo(id); onNavigate?.(); }}
                        aria-current={isActive ? "page" : undefined}
                        className={`flex w-full items-center rounded-md border-l-2 px-3 py-1.5 text-left text-sm transition-colors ${isActive ? "border-primary bg-surface-tint font-semibold text-primary-strong" : "border-border-subtle font-medium text-muted-2 hover:bg-surface-muted hover:text-foreground"}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <main
      className="min-h-screen bg-background text-foreground"
      data-busy={busy ? "true" : undefined}
      // Cluster 3 fix (2026-07-26 audit, P0-6): a CAPTURE-phase click guard
      // that suppresses any click on a `.btn` while an async run() is in
      // flight. This is the single chokepoint that protects ALL ~108 action
      // buttons (and any future ones) from double-click → double-POST,
      // without editing each button. Capture phase runs before the button's
      // own onClick, so we can stop the duplicate before it fires.
      // F-UI-7 (2026-08-04 build-right audit): ALSO suppress clicks on any
      // `[data-busy-locked="true"]` element. This covers section-local async
      // (Tickets/Commercial manage their own `busy`, not page.tsx's) — the
      // <Button> primitive now sets `data-busy-locked` when `loading=true`, so
      // a rapid second click on a section action button is blocked even when
      // the page-level `busy` flag isn't set. This runs unconditionally (not
      // gated on page-level `busy`) so it catches section-internal double-clicks.
      onClickCapture={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-busy-locked="true"]')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (!busy) return;
        if (target.closest(".btn")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {/* CP-20 (2026-08-02) — public read-only tour banner. Shown when the
          visitor is a tour viewer so they always know they're in a shared
          read-only demo + have a one-click path to sign up. */}
      {isTour ? (
        <div className="border-b border-warning-border bg-warning-bg px-4 py-2.5 text-sm text-warning-fg lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><strong>You're exploring a shared read-only demo.</strong> Browse every screen — sign up to get your own workspace and take actions.</span>
            <a href="/signup" className="rounded-md bg-warning-fg px-3 py-1 text-xs font-semibold text-warning-bg hover:opacity-90">Sign up free →</a>
          </div>
        </div>
      ) : null}
      {/* 2026-08-05 (audit F-8) — truncated-list banner.
          This workspace has more rows than the bare list endpoint will return,
          so some on-screen totals are computed from a PARTIAL array and would
          otherwise be silently wrong. Say so rather than show a confident
          number that isn't true. Never appears in a normal workspace. */}
      {truncatedLists.length > 0 ? (
        <div className="border-b border-danger-border bg-danger-bg px-4 py-2.5 text-sm text-danger-fg lg:px-8" role="alert">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong>Some lists are too large to show in full.</strong>
            <span>
              Counts and totals on this screen are calculated from the rows that loaded, so they may be lower than reality:{" "}
              {truncatedLists.map((t) => `${t.url.replace("/api/", "")} (${t.returned.toLocaleString()} of ${t.total.toLocaleString()})`).join(", ")}.
            </span>
            <span>Use the filters on each screen to narrow the list.</span>
          </div>
        </div>
      ) : null}
      {/* 2026-08-17 — Desktop sidebar (≥lg): one leaf + 5 collapsed drawers,
          with the AI's live autonomy state pinned underneath. */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border-default bg-surface lg:flex">
        <div className="shrink-0 px-4 pb-3 pt-5">
          <div className="flex items-center gap-2 text-lg font-semibold"><Bot className="h-5 w-5 text-primary" /> LeadCockpit</div>
        </div>
        {/* `lc-thin-scroll` (globals.css) keeps this region's own scroll but
            makes the bar thin + hover-only, so it doesn't visually compete
            with the page scrollbar (audit U-8). With the groups collapsed by
            default the nav usually fits without scrolling at all now. */}
        <nav aria-label="Main navigation" className="lc-thin-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {renderNavTree()}
        </nav>
        {/* N-UI-3 (2026-08-31) — the AI autonomy card used to be pinned HERE,
            eating roughly a third of the sidebar's height so an opened nav group
            had no room to show its screens. It now lives in the header as
            AIStatusChip: visible on every screen, costing no vertical space. */}
      </aside>

      {/* 2026-07-21 (M3) — Mobile drawer (<lg). Replaces the 20-tab
          horizontal scroller. Hamburger button in the header toggles it.
          Drawer is a modal-style overlay with the same 5 groups.
          Cluster 8 / P1-14 fix: now a proper dialog (role="dialog" +
          aria-modal + Escape-to-close) so keyboard + screen-reader users
          aren't trapped behind the overlay. Mirrors the Modal primitive. */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-50 w-72 transform border-r border-border-default bg-surface outline-none transition-transform duration-200 lg:hidden ${drawerOpen ? "translate-x-0" : "-translate-x-full"}`}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        aria-hidden={!drawerOpen}
      >
        <div className="flex items-center justify-between px-4 pb-4 pt-5">
          <div className="flex items-center gap-2 text-lg font-semibold"><Bot className="h-5 w-5 text-primary" /> LeadCockpit</div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
            className="inline-flex h-11 w-11 items-center justify-center rounded text-muted hover:bg-surface-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav aria-label="Mobile main navigation" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-6">
          {renderNavTree(() => setDrawerOpen(false))}
        </nav>
      </aside>

      <section className="lg:pl-64">
        <header className="z-10 border-b border-border-default bg-surface/95 px-4 py-3 backdrop-blur lg:sticky lg:top-0 lg:px-8 lg:py-4">
          {/* 2026-09-03 (N-UX-40) — the header used to drop its whole control
              row (search, user, AI state, refresh, sign out) onto a second line
              on any screen whose one-sentence blurb wrapped to two lines:
              Onboarding, Workspace, Compliance and others. The cause was that
              the title block could not shrink, so `flex-wrap` had nowhere to go
              but down. `min-w-0 flex-1` lets the SENTENCE wrap inside its own
              column — which is what should give — and `shrink-0` keeps the
              controls where the operator expects to find them on every screen.
              `flex-wrap` is kept for genuinely narrow windows, and items-start
              stops a two-line title from dragging the controls off centre. */}
          {/* 2026-09-28 — on a phone the heading was squeezed into a column
              ~70px wide beside the controls ("4 / things / need / you", one
              word per line). Below lg the wrapper dissolves (`contents`): the
              menu button and the controls share the top row, and the heading
              takes the full width underneath. Desktop is unchanged. */}
          <div className="flex flex-wrap items-start justify-between gap-3 max-lg:items-center max-lg:gap-y-2">
            <div className="flex min-w-0 flex-1 items-start gap-3 max-lg:contents">
              {/* 2026-07-21 (M3) — Hamburger for the mobile drawer. */}
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
                aria-expanded={drawerOpen}
                className="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-muted lg:hidden"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M2 4h16v2H2zM2 9h16v2H2zM2 14h16v2H2" />
                </svg>
              </button>
              <div className="min-w-0 max-lg:order-last max-lg:basis-full">
                {/* 2026-08-02 (UI polish) — the page H1 now shows the ACTIVE
                    section (e.g. "Dashboard", "Replies Inbox", "Lead pipeline")
                    instead of a static "LeadCockpit" that duplicated the brand
                    already shown in the sidebar. The workspace name moves into
                    the user chip (right side) where it belongs, next to who's
                    logged in — not stacked above the page title. */}
                <p className="text-xs font-medium uppercase tracking-wide text-muted">{state?.workspace?.name || "Workspace"}</p>
                {/* 2026-08-17 — on the queue, the title IS the status: the
                    operator should be able to read their whole day off one
                    line. `needsYouCount` is set by the section itself, so this
                    number can never disagree with the list underneath it. */}
                {/* N-UX-10 (2026-09-03) — every screen introduces itself the
                    same way: a heading that states the JOB, and exactly one
                    quieter sentence underneath saying what the screen is for.
                    The operator reads the heading, knows where they are, and
                    reads the sentence only if they want to.

                    Centralised deliberately. The heading was already rendered
                    here for all 26 screens, so putting the copy in one table
                    (src/app/page-intros.ts) fixes every screen at once and
                    stops the 27th screen from being added without one. Pinned
                    by golden:page-intros.

                    N-SEC-3 — the `!bootError` guard is why the needsYou branch
                    is a special case at all. Its heading is not a label, it is
                    a CLAIM about the operator's day ("Nothing needs you"), and
                    a claim may only be made from data we actually loaded. With
                    the workspace unloaded, `needsYouCount` is still 0 from the
                    previous render, so without the guard the largest text on
                    the screen asserted all-clear directly above a panel
                    explaining that nothing had loaded. */}
                {(() => {
                  const intro = PAGE_INTROS[active];
                  const countable = active === "needsYou" && needsYouCount !== null && !bootError;
                  const heading = countable
                    ? (needsYouCount === 0
                      ? "Nothing needs you"
                      : `${needsYouCount} thing${needsYouCount === 1 ? "" : "s"} need${needsYouCount === 1 ? "s" : ""} you`)
                    : (intro?.heading ?? tabs.find(([id]) => id === active)?.[1] ?? "Dashboard");
                  const blurb = countable && needsYouCount === 0
                    ? "Nothing else is waiting. The AI is handling the rest."
                    : intro?.blurb;
                  return (
                    <>
                      <h1 className="text-2xl font-bold tracking-tight text-foreground text-balance">{heading}</h1>
                      {blurb ? <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{blurb}</p> : null}
                    </>
                  );
                })()}
              </div>
            </div>
            {/* N-UX-53 (2026-09-05). This row was `shrink-0`, so on a phone it
                refused to give up any width and pushed 86px off the right edge
                — every screen in the product scrolled sideways at 375px, which
                is most phones. `min-w-0` lets it yield, `justify-end` keeps it
                against the right edge as it does, and the two status chips
                inside truncate rather than shoving the row wider.
                Found by the e2e mobile sweep, which had been reporting
                "scrollWidth 461 > clientWidth 375" on all 26 tabs without
                naming what was sticking out; it names the element now. */}
            <div className="flex min-w-0 items-center justify-end gap-2 max-lg:flex-1">
              {/* 2026-08-05 (UX Fix 4) — Global search (Cmd/Ctrl+K). Searches
                  leads by company/contact/phone. The single biggest power-user
                  gap: an operator with 200 leads can't find "Priya" without
                  scanning the table. Now they press Cmd+K + type. */}
              <GlobalSearch leads={leads} onNavigate={(leadId) => focusOnLead(leadId, "crm")} />
              {/* User chip — avatar (initial of the user's name) + name +
                  workspace, clearly separated instead of jammed together.
                  The authenticated user comes from the boot payload. */}
              <div className="hidden items-center gap-2 rounded-lg border border-border-default bg-surface px-3 py-1.5 text-sm shadow-sm md:flex">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-tint text-xs font-bold uppercase text-primary-strong">
                  {(authUser?.name?.[0] || "D")}
                </span>
                <div className="leading-tight">
                  <div className="font-semibold text-foreground">{authUser?.name || "Demo owner"}</div>
                  <div className="text-xs text-muted">{state?.workspace?.name || "Opening workspace…"}</div>
                </div>
              </div>
              {/* N-UI-3 — the AI's live autonomy state, on every screen. Sits
                  before the transient StatusPill because it is a standing fact,
                  not a passing message. */}
              {userRole !== 'owner' ? null : <div className="min-w-0 shrink truncate"><AIStatusChip onOpenSettings={() => navTo("ai")} /></div>}
              {/* 2026-09-25 — this pill used to show the LAST result forever
                  ("Ready", "Save completed", "Demo workspace opened"). Every
                  result is already a toast, so at rest it only repeated one. It
                  now shows while something is running, and for the messages
                  that have no toast: load failures, sign-in problems, "busy". */}
              {busy || !isQuietNotice(notice) ? <div className="min-w-0 shrink truncate"><StatusPill text={busy || notice} active={Boolean(busy)} /></div> : null}
              <button onClick={() => run("Refreshing data", loadAll)} className="icon-btn" title="Refresh" aria-label="Refresh workspace data"><RefreshCw className="h-4 w-4" /></button>
              <button onClick={logout} className="icon-btn" title="Sign out (on every device)" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
            </div>
          </div>
        </header>

        {/* 2026-08-05 (audit U-3): pb-28 reserves room under the last row for
            the floating Copilot button, which previously sat on top of the
            final table row's action buttons and made them unclickable. */}
        {/* 2026-09-25 — the assistant is a full-page conversation (CEO: "not in
            the middle, full screen"), so its page drops the centred width and
            the bottom room that was kept for the floating Copilot button,
            which is gone: the Copilot and the Command Center are now one. */}
        <div className={active === "commandCenter" ? "px-3 pb-3 pt-3 lg:px-4" : "mx-auto max-w-7xl px-4 pb-12 pt-5 lg:px-8 lg:pt-8"}>
          {/* 2026-08-02 audit P2-2 — focus ribbon: when the operator drilled into
              this section from a specific Lead, show which lead is in context and
              offer a one-click clear. Without this the user sees a filtered list
              with no explanation of why (Data-Source Clarity check). */}
          {focusLeadId && ["replies", "commercial", "tickets"].includes(active) && (() => {
            const focused = leads.find((l) => l.id === focusLeadId);
            if (!focused) return null;
            return (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-primary-bg bg-primary-bg px-4 py-2 text-sm">
                <span>
                  <strong>Viewing in context of:</strong> {focused.companyName || focused.contactName || "this prospect"}
                  {focused.contactName ? ` (${focused.contactName})` : ""}
                </span>
                <button className="btn secondary text-xs py-1 px-2" onClick={() => setFocusLeadId("")}>
                  Clear focus ×
                </button>
              </div>
            );
          })()}
          {/* N-SEC-3 (2026-09-03) — a screen may never report good news it did
              not verify.

              When the workspace load failed, every list stayed empty and each
              screen rendered its ordinary empty state. The first screen an
              operator sees then showed a green tick and the words "Nothing
              needs you" — a confident all-clear for data the app had never
              managed to fetch. That is worse than an error: it is a wrong
              answer delivered with confidence, and the operator acts on it.

              The check lives HERE, once, above the section switch, rather than
              inside each of the 26 screens. Per-screen checks are the reason
              this was inconsistent in the first place: Questions from AI showed
              "Couldn't load" correctly while Needs You showed a tick. One gate
              cannot drift out of agreement with itself.

              `bootError` is set only when /api/state itself rejected — the
              load-bearing fetch nothing else can render without. A single
              optional endpoint failing still degrades gracefully to its own
              empty state, as before. */}
          {bootError ? (
            <WorkspaceLoadFailed
              key={loadAttempt}
              reason={bootError}
              onRetry={() => loadAll().catch((e) => setBootError(e instanceof Error ? e.message : "Retry failed"))}
            />
          ) : (
          <>
          {active === "commandCenter" && (
            <Assistant
              activeLeadId={explicitlyFocusedLead?.id}
              activeLeadName={explicitlyFocusedLead?.companyName || explicitlyFocusedLead?.contactName}
              onClearLead={() => setFocusLeadId("")}
            />
          )}
          {active === "needsYou" && <NeedsYou run={run} reload={loadAll} setActive={setActive} onFocusLead={focusOnLead} onCount={setNeedsYouCount} />}
          {active === "dashboard" && <Dashboard state={state} intelligence={dashboardIntelligence} role={userRole} profile={profile} campaigns={campaigns} leads={leads} messages={messages} autoReplyLogs={autoReplyLogs} setActive={setActive} onCrmFilter={(status) => setCrmStatusFilter(status)} />}
          {active === "onboarding" && <Onboarding profile={profile} run={run} setActive={setActive} />}
          {active === "profile" && (profile || state?.workspace ? <ProfileView key={`${profile?.id || "none"}-${profile?.updatedAt || ""}`} profile={profile} run={run} initialCompanyName={state?.workspace?.businessName || state?.workspace?.name || ""} /> : <Empty text="Loading your company's details..." />)}
          {active === "icp" && <ICPView profile={profile} icps={icps} run={run} />}
          {active === "campaign" && <CampaignView profile={profile} icp={selectedIcp} campaigns={campaigns} run={run} />}
          {active === "discovery" && <Discovery campaign={selectedCampaign} icp={selectedIcp} leads={leads} run={run} />}
          {active === "review" && <LeadReview leads={leads} run={run} />}
          {active === "crm" && <CRM leads={leads} initialLeadId={returnToAnalytics ? focusLeadId : undefined} onReturnToAnalytics={returnToAnalytics ? () => { setReturnToAnalytics(false); setFocusLeadId(""); setActive("analytics"); } : undefined} followupRadar={followupRadar} mediaItems={mediaItems} run={run} onFocusLead={focusOnLead} statusFilter={crmStatusFilter} onStatusFilterChange={setCrmStatusFilter} role={userRole} />}
          {active === "messages" && <Messages leads={leads} messages={messages} campaign={selectedCampaign} run={run} />}
          {active === "replies" && (userRole === 'owner' ? <Replies leads={leads} replies={replies} autoReplyLogs={autoReplyLogs} mediaItems={mediaItems} selectedLead={selectedLead} explicitlyFocusedLead={explicitlyFocusedLead} run={run} reload={loadAll} onFocusLead={focusOnLead} setActive={setActive} /> : <StaffConversations leads={leads} focusLeadId={focusLeadId} onFocusLead={focusOnLead} />)}
          {active === "tickets" && <TicketsSection workspaceId={workspaceId} currentUserId={authUser?.id} role={userRole} focusLeadId={focusLeadId} focusAssigneeId={ticketAssigneeId} onClearAssignee={() => { setTicketAssigneeId(""); setWorkspaceInitialSection("workspace-team"); setActive("workspace"); }} onFocusLead={focusOnLead} onReviewReplies={async leadId => {
            const reviewingWorkspace = workspaceId;
            const generation = loadGenerationRef.current;
            const replyVersion = ++autoReplyLoadVersionRef.current;
            const freshLogs = await api<AutoReplyLog[]>("/api/auto-reply-logs");
            if (reviewingWorkspace !== workspaceId || generation !== loadGenerationRef.current || replyVersion !== autoReplyLoadVersionRef.current || authAccessRef.current.role !== 'owner' || logoutInFlight.current || activeSectionRef.current !== 'tickets') return;
            setAutoReplyLogs(freshLogs);
            focusOnLead(leadId, "replies");
          }} />}
          {active === "commercial" && <CommercialSection focusLeadId={focusLeadId} onFocusLead={focusOnLead} readOnly={!canMutate} />}
          {active === "catalogue" && <CatalogueSection setActive={setActive} />}
          {active === "workspace" && <WorkspaceSection role={userRole} initialSection={workspaceInitialSection} onHandoverTickets={userId => { setFocusLeadId(""); setTicketAssigneeId(userId); setActive("tickets"); }} />}
          {active === "activity" && <ActivitySection />}
          {active === "compliance" && <ComplianceSection />}
          {active === "analytics" && <Analytics key={workspaceId} campaigns={campaigns} initialCampaignId={selectedCampaign?.id} chosenCampaignId={analyticsCampaignId} onChooseCampaign={setAnalyticsCampaignId} workspaceId={workspaceId} run={run} readOnly={userRole !== 'owner'} onOpenCustomer={id => { setReturnToAnalytics(true); setAnalyticsCampaignId(analyticsCampaignId || selectedCampaign?.id || ""); focusOnLead(id, "crm"); }} />}
          {active === "integrations" && <IntegrationsSection mediaItems={mediaItems} run={run} reload={loadAll} workspaceId={workspaceId} />}
          {active === "knowledge" && <KnowledgeBase run={run} documents={documents} load={loadKnowledge} setActive={setActive} />}
          {active === "ai" && <AISettings run={run} />}
          {active === "whatsapp" && <WhatsAppAgentSettingsView leads={leads} run={run} />}
          {active === "unknown" && <QuestionsFromAI run={run} documents={documents} loadKnowledge={loadKnowledge} setActive={setActive} leads={leads} />}
          {active === "reviewQueue" && <AIReviewQueue run={run} leads={leads} setActive={setActive} />}
          {active === "settings" && <SettingsCenter state={state} setActive={setActive} onLogout={logout} />}
          {active === "agentInstructions" && <AgentGuidance key={workspaceId} run={run} workspaceId={workspaceId} />}
          {active === "exportBackup" && <ExportBackup run={run} />}
          {active === "help" && <HelpSection />}
          </>
          )}
        </div>
      </section>

      {/* 2026-09-25 — the floating Owner Copilot panel was here. It is merged
          into the full-page assistant (Command Center); a lead's "Ask the
          assistant" button opens that page with the lead in context. */}
    </main>
  );
}

/** One company an email + password belongs to, offered when there is more than one (2026-09-27). */
type LoginCompany = { workspaceId: string; name: string };
/** null = signed in; a string = a message to show; choices = ask which company. */
type LoginOutcome = string | null | { choices: LoginCompany[] };

function LoginScreen({ authMode, authLoadError, bootstrapped, onDemoLogin, onRealLogin, onBootstrap, onStartTour }: { authMode: "demo" | "local" | "production" | null; authLoadError: string | null; bootstrapped: boolean | null; onDemoLogin: () => void; onRealLogin: (email: string, password: string, workspaceId?: string) => Promise<LoginOutcome>; onBootstrap: (email: string, password: string, name: string) => Promise<string | null>; onStartTour: () => Promise<string | null> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<LoginCompany[] | null>(null);
  // CP-20 (2026-08-02) — production landing starts on the 3-action view
  // (Explore / Sign up / Log in). "showLogin" toggles to the email/password
  // form. Bootstrap (first-run owner setup) bypasses the landing entirely.
  const [showLogin, setShowLogin] = useState(false);
  const [tourBusy, setTourBusy] = useState(false);
  const [tourError, setTourError] = useState<string | null>(null);
  // N-OBS-2 (2026-08-20): the "Demo safety boundaries" panel below used to be
  // five hardcoded strings, and three of them were false on this machine — it
  // promised JSON persistence while running on Postgres, and "sample AI
  // responses" while four of six model slots made real billed calls. The rows
  // now come from GET /api/health, which computes them from the live
  // environment. `null` means "not answered yet" and renders as "checking…";
  // a failed fetch renders an explicit warning, never a reassuring default.
  const [boundaries, setBoundaries] = useState<Record<string, string> | null>(null);
  const [boundariesError, setBoundariesError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (payload && typeof payload.demoBoundaries === "object" && payload.demoBoundaries) {
          setBoundaries(payload.demoBoundaries as Record<string, string>);
        } else {
          setBoundariesError(true);
        }
      } catch {
        if (!cancelled) setBoundariesError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const isProduction = authMode === "production";
  // When in production and not yet bootstrapped, show the owner-setup form.
  const isSetup = isProduction && bootstrapped === false;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = isSetup ? await onBootstrap(email, password, name) : await onRealLogin(email, password);
      if (outcome && typeof outcome === "object") setCompanies(outcome.choices);
      else if (outcome) setError(outcome);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseCompany(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onRealLogin(email, password, workspaceId);
      if (typeof outcome === "string") setError(outcome);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // CP-20 — start the read-only tour. The button shows a busy state; errors
  // (e.g. tour disabled by the operator, or rate-limited) surface inline.
  async function handleStartTour() {
    if (tourBusy) return;
    setTourBusy(true);
    setTourError(null);
    const err = await onStartTour();
    if (err) setTourError(err);
    setTourBusy(false);
  }

  // Unknown status is not demo access. Wait for the server's actual mode.
  if (authMode === null) {
    return <main className="min-h-screen bg-background px-4 py-8 text-foreground flex items-center justify-center"><div className="text-center">{authLoadError ? <><p role="alert" className="text-danger-fg">{authLoadError}</p><Button className="mt-4" onClick={() => window.location.reload()}>Try again</Button></> : <><Spinner label="Checking your sign-in" /><p className="mt-4 text-lg font-semibold">Opening your workspace…</p></>}</div></main>;
  }

  // Confirmed demo / local mode keeps the one-click demo entry.
  if (!isProduction) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 text-foreground">
        <section className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-5xl items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <div className="mb-5 flex items-center gap-2 text-xl font-semibold"><Bot className="h-6 w-6 text-primary" /> LeadCockpit</div>
            <h1 className="max-w-2xl text-3xl font-semibold tracking-normal text-balance sm:text-4xl">Agent-assisted B2B lead generation, ready for safe demo testing.</h1>
            <p className="mt-4 max-w-xl text-muted-2">Use the demo workspace to test onboarding, knowledge, product research, lead review, manual outreach, WhatsApp dry-runs, and AI review queues. Production login is not active yet.</p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <button className="btn" onClick={onDemoLogin}><UserCircle className="h-4 w-4" /> Continue in Demo Mode</button>
            </div>
          </div>
          <Panel title="Demo safety boundaries" icon={ShieldCheck}>
            {boundariesError ? (
              <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">These boundaries could not be checked against the running system. Do not assume anything here is switched off — open Settings and confirm before you send anything to a customer.</p>
            ) : boundaries ? (
              <>
                <ProfileRows items={boundaries} />
                <p className="mt-3 text-xs text-muted-2">Read from this server just now, not written into the page.</p>
              </>
            ) : (
              <p className="text-sm text-muted-2">Checking what this system is actually connected to…</p>
            )}
          </Panel>
        </section>
      </main>
    );
  }

  // Production FIRST-RUN: owner bootstrap (unchanged — operator-only setup).
  if (isSetup) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 text-foreground">
        <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center">
          <div className="mb-6 flex items-center gap-2 text-xl font-semibold"><Bot className="h-6 w-6 text-primary" /> LeadCockpit</div>
          <Panel title="Set up the owner account" icon={ShieldCheck}>
            <form className="mt-2 space-y-4" onSubmit={handleSubmit}>
              <p className="text-sm text-muted-2">This is the first time this workspace is being used. Create the owner account. You can add team members later.</p>
              <label className="block">
                <span className="label">Your name</span>
                <input className="input mt-1" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Owner name" autoComplete="name" required />
              </label>
              <label className="block">
                <span className="label">Email</span>
                <input className="input mt-1" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setCompanies(null); }} placeholder="you@company.com" autoComplete="email" required />
              </label>
              <label className="block">
                <span className="label">Password</span>
                <input className="input mt-1" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" autoComplete="new-password" required minLength={8} />
              </label>
              {error ? <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p> : null}
              <button className="btn w-full" type="submit" disabled={busy}>{busy ? "Please wait…" : "Create owner account"}</button>
            </form>
          </Panel>
        </section>
      </main>
    );
  }

  // CP-20 (2026-08-02) — Production landing: 3 actions. A visitor can Explore
  // the live read-only demo (no signup), Sign up for their own workspace, or
  // Log in. The login form toggles in below.
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center">
        <div className="mb-6 flex items-center gap-2 text-xl font-semibold"><Bot className="h-6 w-6 text-primary" /> LeadCockpit</div>
        <h1 className="text-2xl font-semibold tracking-normal text-balance sm:text-3xl">Agent-assisted B2B CRM + lead generation.</h1>
        <p className="mt-3 text-muted-2">Discover leads, run conversations on WhatsApp and email, manage orders and tickets — with AI doing the busywork and you owning every decision.</p>

        <div className="mt-6 space-y-3">
          {/* Primary: explore the read-only demo (no signup). */}
          <button className="btn w-full" onClick={handleStartTour} disabled={tourBusy}>
            <Eye className="h-4 w-4" /> {tourBusy ? "Starting tour…" : "Explore the live demo"}
          </button>
          {tourError ? <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">{tourError}</p> : null}
          <p className="text-center text-xs text-muted">No signup needed — browse every screen read-only.</p>

          {/* Secondary: sign up + log in. */}
          <div className="flex gap-3">
            <a href="/signup" className="btn secondary flex-1 text-center">Sign up — free</a>
            <button className="btn secondary flex-1" onClick={() => setShowLogin((v) => !v)}>{showLogin ? "Hide login" : "Log in"}</button>
          </div>
        </div>

        {/* Collapsible login form. */}
        {showLogin ? (
          <div className="mt-6">
          <Panel title="Sign in" icon={ShieldCheck}>
            <form className="mt-2 space-y-4" onSubmit={handleSubmit}>
              <p className="text-sm text-muted-2">Enter your credentials to access your workspace.</p>
              <label className="block">
                <span className="label">Email</span>
                <input className="input mt-1" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setCompanies(null); }} placeholder="you@company.com" autoComplete="email" required />
              </label>
              <label className="block">
                <span className="label">Password</span>
                <input className="input mt-1" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setCompanies(null); }} placeholder="Password" autoComplete="current-password" required />
              </label>
              {error ? <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">{error}</p> : null}
              {companies ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">This email is used in more than one company. Which one do you want to open?</p>
                  {companies.map((company) => (
                    <button key={company.workspaceId} type="button" className="btn secondary w-full" disabled={busy} onClick={() => chooseCompany(company.workspaceId)}>{company.name}</button>
                  ))}
                  <button type="button" className="min-h-11 text-sm text-muted underline" onClick={() => setCompanies(null)}>Use a different email</button>
                </div>
              ) : (
                <button className="btn w-full" type="submit" disabled={busy}>{busy ? "Please wait…" : "Sign in"}</button>
              )}
              <p className="text-center text-xs"><a href="/forgot-password" className="text-primary hover:underline">Forgot password?</a></p>
            </form>
          </Panel>
          </div>
        ) : null}
      </section>
    </main>
  );
}

/**
 * CP-21 (2026-08-02) — Jidoka AI health lights for the Dashboard.
 *
 * Shows 6 compact traffic-light dots — one per AI model slot — so the owner
 * instantly sees which AIs are actually configured to work:
 *   🟢 green  = a real provider is set AND a key was saved → ready to work
 *   🟡 yellow = a real provider is set but NO key → will silently fall back to mock
 *   🔴 red    = still on mock → sample answers only, no real AI
 *
 * Status is driven by the SAVED configuration (free + instant, no tokens spent).
 * A "Test all" button does a live round-trip probe when the owner wants proof
 * (costs a few tokens, only on demand).
 */
type ModelSlotHealth = {
  slotId: string;
  slotLabel: string;
  provider: string;
  modelName: string;
  hasKey: boolean;
  status: "green" | "yellow" | "red";
};

const SLOT_SHORT_LABELS: Record<string, string> = {
  fast_customer_reply: "Fast Reply",
  daily_workhorse: "Daily Workhorse",
  deep_reasoning: "Deep Reasoning",
  research_search: "Research",
  creative_image: "Image",
  embedding_advanced: "Embedding",
};

function AIHealthLights() {
  const [slots, setSlots] = useState<ModelSlotHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const raw = await api<Array<{ slotId: string; provider: string; modelName: string; primaryKeyPreview?: string; credentialId?: string; hasPlatformKey?: boolean }>>("/api/ai/model-slots");
        if (cancelled) return;
        const health: ModelSlotHealth[] = (raw || []).map((s) => {
          const isMock = !s.provider || s.provider === "mock";
          // UA-9 fix: a slot is also genuinely ready when it's backed by the
          // shared platform-level .env key, not only a workspace credential —
          // providerFor() (LLMService.ts) accepts either. Previously only
          // credentialId/primaryKeyPreview counted, so platform-key-backed
          // slots always showed "yellow" and the dashboard falsely claimed
          // every AI was mock even while genuinely serving real replies.
          const hasKey = Boolean(s.primaryKeyPreview || s.credentialId || s.hasPlatformKey);
          const status: ModelSlotHealth["status"] = isMock ? "red" : (hasKey ? "green" : "yellow");
          return {
            slotId: s.slotId,
            slotLabel: SLOT_SHORT_LABELS[s.slotId] || s.slotId,
            provider: s.provider || "mock",
            modelName: s.modelName || "—",
            hasKey,
            status,
          };
        });
        if (!cancelled) { setSlots(health); setLoading(false); }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  async function testAll() {
    if (testing || slots.length === 0) return;
    setTesting(true);
    setTestResult(null);
    let ok = 0, fallback = 0, fail = 0;
    for (const slot of slots) {
      try {
        const r = await api<{ success: boolean; data?: { mode?: string; status?: string } }>(`/api/ai/model-slots/${slot.slotId}/test`, { method: "POST", body: { workspaceId } });
        if (r.success && r.data?.mode === "real") ok++;
        else if (r.success && (r.data?.mode === "fallback" || r.data?.mode === "mock")) fallback++;
        else fail++;
      } catch {
        fail++;
      }
    }
    setTesting(false);
    setTestResult(`Live test: ${ok} real · ${fallback} fallback/mock · ${fail} failed.`);
  }

  const dotColor = (s: ModelSlotHealth["status"]) =>
    s === "green" ? "bg-success-fg" : s === "yellow" ? "bg-warning-fg" : "bg-danger-fg";
  const dotTitle = (s: ModelSlotHealth) =>
    s.status === "green" ? `${s.slotLabel}: ${s.provider} / ${s.modelName} (key set — ready)`
    : s.status === "yellow" ? `${s.slotLabel}: set to ${s.provider} / ${s.modelName} but NO key — will fall back to sample answers`
    : `${s.slotLabel}: mock only — no real AI configured`;

  if (loading) {
    return <div className="mt-4 border-t border-border-default pt-3"><p className="text-xs text-muted">AI model health: loading…</p></div>;
  }

  const greenCount = slots.filter((s) => s.status === "green").length;
  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-surface-muted p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">AI model health</p>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${greenCount === slots.length ? "bg-success-bg text-success-fg" : greenCount > 0 ? "bg-warning-bg text-warning-fg" : "bg-danger-bg text-danger-fg"}`}>
            {greenCount}/{slots.length} ready
          </span>
        </div>
        <button className="btn secondary text-xs py-1 px-2" onClick={testAll} disabled={testing || slots.length === 0}>
          {testing ? "Testing…" : "Test all"}
        </button>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        {slots.map((s) => (
          <div key={s.slotId} className="flex items-center gap-1.5" title={dotTitle(s)}>
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor(s.status)}`} aria-label={dotTitle(s)} />
            <span className="truncate text-xs text-muted">{s.slotLabel}</span>
          </div>
        ))}
      </div>
      {testResult ? <p className="mt-2 text-xs text-muted">{testResult}</p> : null}
      {greenCount === 0 ? (
        <p className="mt-2 text-xs text-muted">All AIs are on sample/mock mode. Go to <strong>AI Settings</strong> to connect a real provider.</p>
      ) : null}
    </div>
  );
}

/**
 * 2026-08-02 (UX redesign Phase 4) — Agent briefing banner.
 *
 * Research (Fuselab "Agent UX 2026" + Salesforce trust tips): the dashboard's
 * first job on load is a dismissible "While you were away" briefing — a short,
 * plain-language summary of what the system has prepared and what needs the
 * owner. It is NOT push notifications, it never invents numbers (parts are
 * derived from real system state by the caller), and it never auto-sends.
 *
 * Dismiss state is session-local (useState) — the banner reappears next load,
 * which is correct for a daily-landing briefing (it should remind you each
 * morning). A future enhancement could persist dismissal until new work arrives.
 */
function AgentBriefing({ parts, onOpen }: { parts: string[]; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary-tint/60 p-4 shadow-sm">
      <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-primary-strong">While you were away</p>
        <p className="mt-0.5 text-sm text-foreground">{parts.join(" · ")}.</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onOpen}>Review</Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss briefing"
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * N-SEC-3 — the one screen shown when the workspace could not be loaded.
 *
 * Two different situations, told apart because they need different words and
 * different behaviour from the operator:
 *
 *   BUSY (429). The server is up and knows who we are; it is declining volume
 *   for a few seconds. There is nothing to fix and nothing to decide, so the
 *   screen says so plainly and retries on its own, counting down so the wait is
 *   visible rather than a frozen page.
 *
 *   FAILED (anything else). Something is actually wrong. The operator gets the
 *   server's own words and a button, and nothing retries behind their back.
 *
 * Laid out to the four rules: the heading states the situation in the
 * operator's language, one sentence of explanation sits under it, the action is
 * the single prominent thing, and the technical detail is last and quiet.
 */
function WorkspaceLoadFailed({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  // The rate-limit envelope is the one message we can recognise reliably: the
  // route builds it as "Too many requests. Blocked by <ip|workspace> rate
  // limit. Try again in <n>s." Anything else is treated as a real failure,
  // which is the safe direction to be wrong in — a real fault shown as "busy"
  // would retry forever and never tell anyone.
  const busyMatch = /Too many requests\..*?Try again in (\d+)s/.exec(reason);
  const isBusy = busyMatch !== null;
  const initialWait = busyMatch ? Math.min(Number(busyMatch[1]) || 5, 120) : 0;
  const [secondsLeft, setSecondsLeft] = useState(initialWait);

  // The countdown restarts because the PARENT gives this component a new `key`
  // on every load attempt, so React remounts it and `useState` re-initialises.
  //
  // That matters: `useState` takes its initial value once, so without a remount
  // a retry that lands on another 429 would re-render with a fresh `reason`
  // while `secondsLeft` stayed at 0 — the screen would sit on "Retrying…" for
  // ever without ever retrying, which is precisely the kind of lie this screen
  // exists to prevent. Resetting via an effect would also work but causes a
  // cascading render; a key is React's own answer for resetting state when the
  // input changes.
  useEffect(() => {
    if (!isBusy) return;
    if (secondsLeft <= 0) {
      onRetry();
      return;
    }
    const timer = window.setTimeout(() => setSecondsLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
    // onRetry is stable enough for this: it is only ever called when the
    // countdown reaches zero, and re-running the effect on a new identity would
    // merely restart the same one-second tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, secondsLeft]);

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <div className="flex flex-col items-start gap-3">
        <span className="inline-flex items-center gap-2 rounded-md bg-warning-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-warning-fg">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {isBusy ? "Busy" : "Not loaded"}
        </span>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          {isBusy ? "The system is busy for a moment" : "Your workspace didn't load"}
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-muted">
          {isBusy
            ? "Nothing is wrong and nothing is lost. The server is handling a burst of requests and will answer again shortly."
            : "Nothing on this screen has been checked, so nothing here would be true. Your data is untouched — this is only about reading it."}
        </p>
      </div>

      <div className="mt-8">
        {isBusy ? (
          <Button onClick={() => { setSecondsLeft(0); }}>
            {secondsLeft > 0 ? `Retrying in ${secondsLeft}s — try now` : "Retrying…"}
          </Button>
        ) : (
          <Button onClick={onRetry}>Try loading again</Button>
        )}
      </div>

      <p className="mt-10 border-t border-default pt-4 text-xs leading-relaxed text-muted-2">
        What the server said: {reason}
      </p>
    </div>
  );
}

function Dashboard({ state, intelligence, role = "owner", profile, campaigns, leads, messages, autoReplyLogs, setActive, onCrmFilter }: { state: DashboardState | null; intelligence: DashboardIntelligence | null; role?: MinRole; profile: BusinessProfile | null; campaigns: Campaign[]; leads: Lead[]; messages: MessageTemplate[]; autoReplyLogs: AutoReplyLogItem[]; setActive: (tab: TabId) => void; onCrmFilter: (status: string) => void }) {
  // OLD layout: hero + 4 intelligence cards + activity + 12 metric cards +
  //   3-panel grid. ~25 things vying for attention; multiple duplicate
  //   metrics ("Follow-ups due" appeared in 2 places; "Leads to review"
  //   vs "Pending lead reviews" vs "Total leads").
  // NEW layout: Today's work queue first (the 10-minute day), then a
  //   compact numbers strip, then recent activity. One clear primary
  //   action per item. Friendly labels via displayLabel.
  // Cluster 5 P1-11 used to be answered HERE, with a per-screen "Couldn't load
  // + Retry" card. 2026-09-03 (N-SEC-3) moved that answer up to the shell, above
  // the section switch, because a per-screen check is exactly why the product
  // was inconsistent: this screen said "Couldn't load" while Needs You showed a
  // green tick over the same failed load. The shell now renders
  // <WorkspaceLoadFailed/> INSTEAD of any screen whenever /api/state rejected,
  // so `bootError` can never be non-null by the time Dashboard renders. The old
  // branch was therefore unreachable — code that looks like a safety net and
  // catches nothing — and has been removed rather than left to be trusted.
  if (!state) {
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const approvedLeads = leads.filter((lead) => lead.reviewStatus === "approved").length;
  const dncLeads = leads.filter((lead) => lead.doNotContact || lead.status === "do_not_contact").length;
  const repliesReceived = state.recentReplies?.length || 0;

  // === Today's work queue ===
  // Each item is ONE clear action with a count + a primary "Open" CTA.
  // Sorted by priority: things that block revenue first.
  type QueueItem = {
    key: string;
    label: string;
    count: number;
    description: string;
    target: TabId;
    icon: React.ComponentType<{ className?: string }>;
    tone: "info" | "warning" | "danger" | "success";
  };
  const pendingReviewsCount = intelligence?.pendingReviewLeads ?? state.pendingReviews ?? 0;
  const draftsPendingCount = intelligence?.draftsPendingReview ?? 0;
  const followupsDueCount = intelligence?.followupsDue ?? state.followUpsDue ?? 0;
  const enrichmentGapsCount = intelligence?.enrichmentGaps ?? 0;
  // 2026-08-05 W-P1-3: the dashboard had NO entry point to the Replies inbox
  // (the highest-volume daily task — 99 held replies invisible from "Today").
  // Now counts pending customer replies + adds a queue card for them.
  const repliesPendingCount = autoReplyLogs.filter((log) => log.status === "held_for_review" || log.status === "drafted" || log.status.includes("held_for_review")).length;
  const queueItems: QueueItem[] = [
    { key: "reviews", label: "Leads to review", count: pendingReviewsCount, description: "Newly discovered prospects waiting for your approve / reject.", target: "review", icon: ShieldCheck, tone: pendingReviewsCount > 0 ? "warning" : "success" },
    { key: "replies", label: "Customer replies to review", count: repliesPendingCount, description: "Held customer messages waiting for your reply or approval.", target: "replies", icon: Mail, tone: repliesPendingCount > 0 ? "warning" : "success" },
    { key: "drafts", label: "Outreach drafts to approve", count: draftsPendingCount, description: "Outreach message drafts ready for your OK before they go out.", target: "messages", icon: MessageCircle, tone: draftsPendingCount > 0 ? "warning" : "success" },
    { key: "followups", label: "Follow-ups due", count: followupsDueCount, description: "Contacted leads with no reply after 3 days.", target: "crm", icon: RefreshCw, tone: followupsDueCount > 0 ? "info" : "success" },
    { key: "enrichment", label: "Enrichment gaps", count: enrichmentGapsCount, description: "Approved leads missing company details.", target: "crm", icon: Sparkles, tone: enrichmentGapsCount > 0 ? "info" : "success" },
  ];

  // === Numbers strip ===
  // Compact, secondary. The dashboard's primary job is the work queue.
  // FIX #3: cards that filter the CRM now carry an optional `crmFilter` so
  // clicking them jumps to CRM already filtered (e.g. "Approved: 13" → CRM
  // showing only approved leads), matching the number the owner just saw.
  type NumberItem = { key: string; label: string; value: string; target: TabId; crmFilter?: string };
  //
  // 2026-08-31 (N-UX-9) — a "Total leads" entry used to sit at the head of this
  // array and was then thrown away by a `.slice(1)` at the render site, because
  // the "Pipeline at a glance" header already prints the total ("15 leads") and
  // two totals on one card is one too many.
  //
  // Removing it HERE rather than at the render site closes a real trap:
  // `.slice(1)` silently drops whichever item happens to be first, so anyone
  // reordering this list would have made a different number disappear with no
  // error anywhere. The array now says exactly what the screen shows.
  const numberItems: NumberItem[] = [
    { key: "approved", label: "Approved", value: String(approvedLeads), target: "crm", crmFilter: "approved" },
    { key: "hot", label: "Hot leads", value: String(state.hotLeads || 0), target: "crm", crmFilter: "hot_lead" },
    { key: "replies", label: "Replies received", value: String(repliesReceived), target: "replies" },
    { key: "dnc", label: "Do not contact", value: String(dncLeads), target: "crm", crmFilter: "do_not_contact" },
    { key: "campaigns", label: "Active campaigns", value: String(state.activeCampaigns?.length || 0), target: "campaign" },
  ];

  // === Recent activity (kept; was the best part of the old dashboard) ===
  const recentActivity = intelligence?.recentActivity ?? [];

  // === 2026-08-02 (UX redesign Phase 4): Agent briefing ===
  // Research (Fuselab Agent UX): the dashboard's first job on load is a
  // dismissible "While you were away" briefing — 3 lines max, derived from
  // REAL system state (drafts prepared, leads reviewed, enrichment done). It
  // is NOT push notifications and it never invents numbers. When there's
  // nothing to report, the banner simply isn't shown (no empty noise).
  const briefingParts: string[] = [];
  if (draftsPendingCount > 0) briefingParts.push(`${draftsPendingCount} message draft${draftsPendingCount === 1 ? "" : "s"} ready to review`);
  if (pendingReviewsCount > 0) briefingParts.push(`${pendingReviewsCount} lead${pendingReviewsCount === 1 ? "" : "s"} to review`);
  if (intelligence?.enrichmentGaps && intelligence.enrichmentGaps > 0) briefingParts.push(`${intelligence.enrichmentGaps} enrichment gap${intelligence.enrichmentGaps === 1 ? "" : "s"} to fill`);
  const showBriefing = role === "owner" && briefingParts.length > 0;

  // === 2026-08-02 (UX redesign Phase 4): Pipeline stage distribution ===
  // Research (NN/g preattentive): a length-encoded horizontal bar per pipeline
  // stage communicates the distribution at a glance — far better than 6 equal
  // number tiles. Counts derived from REAL lead status (no invented metrics).
  // UA-6 fix: "Approved" used to be a 6th bar bucketed by reviewStatus, an
  // axis independent of lifecycle status — a lead can be Hot AND Approved at
  // once, so counting both inflated the shared denominator and made every
  // bar's percentage wrong. This chart is a pure lifecycle funnel.
  //
  // 2026-08-20 N-UX-7: the stage table used to live here, privately. It was
  // mutually exclusive but NOT exhaustive — it covered 9 of 26 statuses and
  // matched 6 strings LeadStatus cannot hold, so the "New" bar was always 0
  // and 10 of the 15 demo leads appeared nowhere. The denominator was the sum
  // of the bars while the header printed leads.length, so the card contradicted
  // itself. Both halves are fixed: one shared exhaustive table (checked by
  // golden-pipeline-stage-coverage) and leads.length as the denominator, so a
  // percentage here means "percent of your leads" — which is what a reader
  // assumes it means.
  const stageDefs = PIPELINE_STAGES;
  // 2026-09-25 — one colour per stage (it was one purple for all seven), so
  // "won" and "lost" are told apart before the label is read.
  const STAGE_BAR: Record<string, string> = {
    new: "bg-info-border",
    contacted: "bg-primary/30",
    qualified: "bg-primary/50",
    hot: "bg-warning-border",
    won: "bg-success-border",
    lost: "bg-danger-border",
    excluded: "bg-border-default",
  };
  const stageCounts = stageDefs.map((stage) => leads.filter((l) => (stage.statuses as string[]).includes(l.status)).length);
  const totalForBars = Math.max(1, leads.length);
  // Only non-zero if the database holds a status outside the LeadStatus union.
  // Shown rather than absorbed, so bars that do not sum to the header are
  // explained instead of just wrong.
  const uncategorisedLeads = leads.filter((l) => !stageKeyForStatus(l.status));

  // === Tone → Tailwind class ===
  const toneRing: Record<QueueItem["tone"], string> = {
    info: "border-l-info-fg",
    warning: "border-l-warning-fg",
    danger: "border-l-danger-fg",
    success: "border-l-success-fg",
  };
  const toneIcon: Record<QueueItem["tone"], string> = {
    info: "text-info-fg",
    warning: "text-warning-fg",
    danger: "text-danger-fg",
    success: "text-success-fg",
  };

  return (
    <div className="space-y-6">
      {/* 2026-08-02 (UX redesign Phase 4): Agent briefing banner.
          Dismissible, 1-2 lines, derived from REAL system state. Research
          (Fuselab): this is the dashboard's first job on load — tell the owner
          what's been prepared and what needs them, in plain language. It is
          separate from the work queue (never merges agent activity with the
          operator's own tasks — the #1 agent-UX rule). */}
      {showBriefing ? <AgentBriefing parts={briefingParts} onOpen={() => setActive(repliesPendingCount > 0 ? "replies" : draftsPendingCount > 0 ? "messages" : "review")} /> : null}

      {/* Today's work queue — the dashboard's primary job.
          UI polish (2026-08-03): individual elevated cards with bigger numbers,
          left-accent color bar, hover lift, more breathing room (Stripe/Linear
          quality bar). Each card = one action, instantly scannable. */}
      <div>
        {/* 2026-08-02 (UI polish) — a one-line summary that tells the owner, at
            a glance, whether they have work waiting or they're all caught up.
            Replaces a bare "Today" heading with context (the build-right
            Empty-State Honesty rule: never leave the user guessing why a
            section is the way it is). */}
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold text-foreground">Today</h2>
          <p className="text-sm text-muted">
            {(() => {
              const total = pendingReviewsCount + repliesPendingCount + draftsPendingCount + followupsDueCount + enrichmentGapsCount;
              // 2026-09-03 (N-UX-12) — this line used to list every queue with
              // its count, immediately above the five cards showing exactly
              // those same counts in large type. That became a single total.
              //
              // 2026-09-04 (N-UX-18) — and the total had to go too, because it
              // was a SECOND answer to a question the sidebar already answers.
              // The sidebar badge counts the Needs-you inbox: pending leads,
              // held replies, live questions and draft quotes. These five cards
              // count something else: pending leads, held replies, outreach
              // drafts, follow-ups due and enrichment gaps. Three of those ten
              // things overlap, so the two numbers are usually different — on
              // the demo workspace the sidebar said 4 and this line said 3, and
              // an owner reading both has no way to know that both are right.
              // Making them agree would mean changing what one of them counts.
              // So the sidebar keeps the total, and this line says what the
              // cards below it are, without restating their numbers.
              if (total === 0) return "Your available queues are clear right now.";
              return "Here's what's waiting. Start anywhere.";
            })()}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {queueItems.filter(item => canViewWorkspaceTab(role, item.target) && (item.key !== "replies" || role === "owner")).map((item) => {
            const Icon = item.icon;
            const toneBg: Record<QueueItem["tone"], string> = {
              info: "bg-info-bg", warning: "bg-warning-bg", danger: "bg-danger-bg", success: "bg-success-bg",
            };
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActive(item.target)}
                className={`group flex flex-col rounded-xl border border-border-default bg-surface p-4 text-left shadow-md ring-1 ring-black/[0.02] transition-all hover:shadow-lg hover:-translate-y-0.5 ${toneRing[item.tone]} border-l-4`}
                aria-label={`Open ${item.label}`}
              >
                <div className="flex items-center justify-between">
                  <Icon className={`h-5 w-5 ${toneIcon[item.tone]}`} aria-hidden="true" />
                  {/* 2026-08-05 VISUAL REFRESH: headline count bumped text-xl→text-3xl
                      so the number is the visual anchor of each queue card (was the
                      same size as body text — nothing drew the eye). */}
                  <span className={`flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-3xl font-bold tabular-nums ${toneBg[item.tone]} ${toneIcon[item.tone]}`}>{item.count}</span>
                </div>
                <p className="mt-3 font-semibold text-foreground">{item.label}</p>
                <p className="mt-1 text-sm text-muted">{item.description}</p>
                <p className="mt-3 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">Open →</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2026-08-02 (UX redesign Phase 4): Pipeline stage distribution.
          Replaces the flat 6-tile number strip with a length-encoded bar per
          stage (NN/g: length is preattentive; equal tiles are not). Each bar
          is clickable → jumps to the CRM filtered to that stage. The totals
          strip below keeps the headline numbers so nothing is lost. */}
      <Card title="Pipeline at a glance" icon={Layers3} action={<span className="text-xs text-muted">{leads.length} lead{leads.length === 1 ? "" : "s"}</span>}>
        <div className="space-y-2.5">
          {stageDefs.map((stage, i) => {
            const count = stageCounts[i];
            const pct = Math.round((count / totalForBars) * 100);
            const widthPct = (count / totalForBars) * 100;
            // N-UX-7: filter the CRM by the whole stage, not by its first
            // status — clicking a bar of 7 must not land on a list of 1.
            const filterVal = `stage:${stage.key}`;
            return (
              <button
                key={stage.key}
                type="button"
                onClick={() => { onCrmFilter(filterVal); setActive("crm"); }}
                className="group flex w-full items-center gap-3 text-left"
                title={`${stage.label}: ${count} lead${count === 1 ? "" : "s"} (${pct}%)`}
              >
                <span className="w-24 shrink-0 text-xs font-medium text-muted">{stage.label}</span>
                <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-surface-muted">
                  <div
                    className={`h-full rounded-md transition-all ${count > 0 ? STAGE_BAR[stage.key] || "bg-info-border" : "bg-transparent"} group-hover:brightness-95`}
                    style={{ width: `${Math.max(widthPct, count > 0 ? 4 : 0)}%` }}
                  />
                  <span className="absolute inset-y-0 left-2 flex items-center text-xs font-semibold text-foreground">{count}</span>
                </div>
                {/* 2026-09-03 (N-UX-12) — the percentage used to sit here
                    beside every bar. Seven stages meant fourteen numbers in one
                    block, and the percentage was the half that could not be
                    acted on: the BAR already shows the proportion, at a glance,
                    which is the whole reason it is a bar. The count is what an
                    operator clicks through to. The percentage is still in the
                    hover title above, for anyone who wants the exact share. */}
              </button>
            );
          })}
          {uncategorisedLeads.length ? (
            <p className="pt-1 text-xs text-danger-fg">{uncategorisedLeads.length} lead{uncategorisedLeads.length === 1 ? " has a status" : "s have statuses"} this chart does not recognise ({Array.from(new Set(uncategorisedLeads.map((l) => l.status))).join(", ")}) &mdash; they are counted in the total but shown in no bar.</p>
          ) : null}
        </div>
        {/* Headline totals — kept as compact inline chips so the owner still
            sees the key numbers without the equal-weight tile wall. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border-subtle pt-3">
          {numberItems.filter(item => canViewWorkspaceTab(role, item.target)).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                if (item.crmFilter !== undefined) onCrmFilter(item.crmFilter);
                setActive(item.target);
              }}
              className="group inline-flex items-baseline gap-1.5"
            >
              <span className="text-2xl font-bold text-foreground transition-colors group-hover:text-primary tabular-nums">{item.value}</span>
              <span className="text-xs text-muted">{item.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Bars show how your leads distribute across pipeline stages. Trends vs. last week will appear once you have two weeks of activity.</p>
      </Card>

      {/* Recent activity + Workspace status — side by side (Linear-style). */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent activity */}
        <Card title="Recent activity" icon={Inbox} action={recentActivity.length > 0 ? <span className="text-xs text-muted">{recentActivity.length} event{recentActivity.length === 1 ? "" : "s"}</span> : undefined}>
        {recentActivity.length ? (
          <ul className="space-y-2">
            {recentActivity.slice(0, 8).map((event, index) => (
              <li key={`${event.entityId}-${event.happenedAt}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-muted p-2 text-sm">
                <span className="text-foreground">{event.label}</span>
                <time className="text-xs text-muted" dateTime={event.happenedAt}>{formatDate(event.happenedAt)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Inbox}
            title="No recent activity yet"
            description="Lead approvals, enrichment runs, drafted messages, and sent replies will show up here as you work."
          />
        )}
      </Card>

      {/* Workspace status — replaced the old 3-panel "Sales health /
          Campaign workspace / Recent agent runs" grid with one compact
          card. No duplicate metrics, no raw snake_case status dumps. */}
      <Card title="Workspace status" icon={Bot}>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="label">Business profile</p>
            <p className="text-sm text-foreground">{profile?.status === "approved" ? "Ready" : "Needs review"}</p>
          </div>
          <div>
            <p className="label">Campaign</p>
            {/* N-BUG (2026-09-08): this counted EVERY campaign and called the
                total "active", so one unstarted draft read "1 active (Draft)"
                directly beside the KPI tile reading "Active campaigns 0". See
                src/lib/campaign-status-line.ts. */}
            <p className="text-sm text-foreground">{campaignStatusLine(campaigns)}</p>
          </div>
        </div>
        {/* CP-21 (2026-08-02) — Jidoka AI health lights. 6 compact dots (one per
            AI model slot) showing green/yellow/red so the owner instantly sees
            which AIs are actually configured to work. Driven by the saved
            configuration (free, instant); a "Test all" button does the live
            round-trip when the owner wants proof. */}
        {role === "owner" && <AIHealthLights />}
      </Card>
      </div>
    </div>
  );
}

function Onboarding({ profile, run, setActive }: SectionProps & { setActive: (tab: TabId) => void }) {
  // N-BUG (2026-09-08) — this defaulted to the literal string
  // "https://example.com". That is a VALUE, not a placeholder: the extraction
  // treats any non-empty URL as a website the operator wants crawled, so a
  // document-only run refused to start with "Website scan requires permission
  // before crawling" — naming a site the operator never typed and cannot see
  // is a placeholder. The empty default makes the field mean what it looks
  // like it means, and the hint below moves into a real `placeholder`.
  const [url, setUrl] = useState(profile?.websiteUrl || "");
  const [consentGiven, setConsentGiven] = useState(false);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [docWarning, setDocWarning] = useState("");
  const [docSuccess, setDocSuccess] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [preview, setPreview] = useState<DocumentMappingPreview | null>(null);
  const [combinedResult, setCombinedResult] = useState<CombinedExtractionResponse | null>(null);
  const [essentialQuestions, setEssentialQuestions] = useState<EssentialQuestionsResponse | null>(null);
  // 2026-08-05 multi-agent audit P0-2: track load failure separately so the UI
  // doesn't show an infinite "Loading" badge when the API is down (null was
  // ambiguous — it meant both "loading" and "failed").
  const [essentialQuestionsError, setEssentialQuestionsError] = useState<string | null>(null);
  const [essentialRetry, setEssentialRetry] = useState(0);
  const [isExtractingKnowledge, setIsExtractingKnowledge] = useState(false);
  const [activeExtraction, setActiveExtraction] = useState<ExtractionStatusResponse | null>(null);
  const extractionIsActive = isExtractingKnowledge || Boolean(activeExtraction?.active);

  async function loadActiveExtraction() {
    const status = await api<ExtractionStatusResponse>("/api/extraction-runs/active");
    setActiveExtraction(status);
  }

  // Phase 5.3: poll extraction status only when needed. Previously this ran a
  // fixed 5s interval for the entire lifetime of the page, hitting the API even
  // when no extraction was active. Now we (a) fetch once on mount, then (b) only
  // keep polling while an extraction is actually running, and (c) back off
  // exponentially (2s -> 4s -> 8s -> capped at 15s) so a long extraction run
  // does not hammer the server. When the run finishes we stop polling entirely.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let delay = 2000;
    const MIN_DELAY = 2000;
    const MAX_DELAY = 15000;

    const schedule = (ms: number) => {
      if (stopped) return;
      timer = window.setTimeout(tick, ms);
    };
    const tick = async () => {
      timer = undefined;
      try {
        const status = await api<ExtractionStatusResponse>("/api/extraction-runs/active");
        if (stopped) return;
        setActiveExtraction(status);
        if (status.active || isExtractingKnowledge) {
          // Still running: back off further to reduce load, cap at MAX_DELAY.
          delay = Math.min(Math.max(delay * 2, MIN_DELAY), MAX_DELAY);
          schedule(delay);
        } else {
          // Run finished (or never started): stop polling. A subsequent user
          // action that starts an extraction restarts this effect below.
        }
      } catch {
        // Status is unavailable: back off and retry until this effect stops.
        if (!stopped) schedule(MAX_DELAY);
      }
    };
    tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isExtractingKnowledge]);

  useEffect(() => {
    let stopped = false;
    setEssentialQuestionsError(null);
    api<EssentialQuestionsResponse>("/api/knowledge/essential-questions")
      .then((data) => {
        if (!stopped) setEssentialQuestions(data);
      })
      .catch((e) => {
        // 2026-08-05 P0-2: was setEssentialQuestions(null) — indistinguishable
        // from "still loading" → infinite "Loading" badge. Now sets a distinct
        // error state so the UI can show "Couldn't load — try again."
        if (!stopped) {
          setEssentialQuestions(null);
          setEssentialQuestionsError(e instanceof Error ? e.message : "Failed to load essential questions.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [essentialRetry]);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    setSelectedFiles(files);
    setFileNames(files.map((f) => f.name));
    setDocWarning("");
    setDocSuccess("");
  }

  return (
    <div className="space-y-4">
      <Grid>
        <Panel title="Scan public website information" icon={Globe}>
          {/* 2026-08-05 (audit F-9): explicit htmlFor/id. Most labels in this
              file WRAP their control, which associates implicitly and is fine;
              these five sat as siblings with no association at all, so a screen
              reader announced an unlabelled edit field. */}
          <label className="label" htmlFor="crawl-website-url">Website URL</label>
          <input id="crawl-website-url" className="input" placeholder="https://yourcompany.com (leave blank to use documents only)" value={url} onChange={(event) => setUrl(event.target.value)} />
          <label className="mt-3 flex items-start gap-2 rounded-md border border-border-default bg-surface p-3 text-sm">
            <input type="checkbox" checked={consentGiven} onChange={(event) => setConsentGiven(event.target.checked)} className="mt-1" />
            <span>I confirm that I have permission to scan this website and use its public information to set up my workspace.</span>
          </label>
          <p className="mt-3 text-xs text-muted">Nothing is scanned until you press Extract Company Knowledge below. The website and your documents are read together.</p>
        </Panel>
        <Panel title="Upload company documents" icon={Upload}>
        {/* 2026-09-25 (cleanup pass) — between this sentence and the file
            picker sat ~1100px of reference material: a "Prepare before upload"
            box, a 12-card grid of the essential setup questions, and a "What
            can be extracted" list that restated those cards. Useful once, in
            the way of the upload every other time. It is one press away now. */}
        <p className="text-sm text-muted-2">Brochures, catalogues, price lists, FAQs, policies, product sheets, sales notes.</p>
        <Button variant="secondary" icon={FileText} className="mt-3" onClick={() => setCoverOpen(true)}>What should my documents cover?</Button>
        <Drawer open={coverOpen} onOpenChange={setCoverOpen} title="What your documents should cover" description="The AI looks for answers to these questions in your website and documents. Whatever it cannot find, it asks you in Questions from AI." size="lg">
          <DrawerBody>
            <EssentialSetupQuestions summary={essentialQuestions} error={essentialQuestionsError} onRetry={() => { setEssentialQuestionsError(null); setEssentialRetry((n) => n + 1); }} />
            <a className="btn secondary mt-4 inline-flex" href="/api/knowledge/questionnaire/pdf" target="_blank" rel="noreferrer">
              <FileText className="h-4 w-4" /> Download the full checklist (PDF)
            </a>
          </DrawerBody>
        </Drawer>
        <div className="mt-4">
          <label className="label" htmlFor="doc-upload-input">Select files (PDF, DOCX, TXT, MD, CSV)</label>
          <input
            id="doc-upload-input"
            className="input mt-1"
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,.csv,.json"
            onChange={handleFileChange}
          />
          {fileNames.length > 0 && (
            <div className="mt-2 space-y-1">
              {fileNames.map((name) => (
                <div key={name} className="flex items-center gap-2 rounded-md bg-surface-muted px-2 py-1 text-xs text-primary-strong"><FileText className="h-3 w-3" />{name}</div>
              ))}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">A PDF that is a scanned photo of a page cannot be read yet — use the original file.</p>
        <div className="mt-4 border-t border-surface-muted pt-3">
          <button className="text-xs text-muted underline" onClick={() => setShowPaste(!showPaste)}>
            {showPaste ? "Hide" : "Advanced: paste text manually"}
          </button>
          {showPaste && (
            <div className="mt-2">
              <label><span className="label">Paste text</span>
                <textarea className="input min-h-32" value={pasteText} onChange={(event) => { setPasteText(event.target.value); setDocWarning(""); }} placeholder="Paste brochure, catalogue, FAQ, policy, or sales content here..." />
              </label>
            </div>
          )}
        </div>
      </Panel>
      </Grid>
      <Panel title="Extract company knowledge from all sources" icon={Sparkles}>
        <p className="text-sm text-muted-2">Website and uploaded documents are combined first, then the Knowledge Base questions run once on the complete source bundle.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge>Website: {url.trim() ? "included if permission is checked" : "not added"}</Badge>
          <Badge>Files: {selectedFiles.length}</Badge>
          {pasteText.trim() ? <Badge>Pasted text included</Badge> : null}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[auto_1px_minmax(320px,1fr)] lg:items-stretch">
        <div className="flex flex-wrap content-start gap-2">
        <button className="btn" disabled={extractionIsActive} onClick={() => {
          if (extractionIsActive) return;
          setIsExtractingKnowledge(true);
          run("Extract Company Knowledge", async () => {
          const hasWebsite = Boolean(url.trim());
          // 2026-08-05 audit fix (F-UI-21): the 4 pre-extraction bail-outs
          // used to `setDocWarning(...); return;` — which resolved the run()
          // promise successfully and fired a green "Extract Company Knowledge
          // completed" toast even though NOTHING was extracted. The operator
          // saw success when the action was actually skipped. Fix: throw so
          // run()'s catch branch fires the sticky danger toast (the inline
          // docWarning pill is still set for in-page context).
          if (hasWebsite && !consentGiven) {
            const msg = "Please confirm website scan permission, or remove the website URL before extracting.";
            setDocWarning(msg);
            throw new Error(msg);
          }
          if (!hasWebsite && !pasteText.trim() && selectedFiles.length === 0) {
            const msg = "Add a website URL or upload at least one document first.";
            setDocWarning(msg);
            throw new Error(msg);
          }
          let extractionWarning = "";
          let files: FileTextExtractionResponse["files"] = [];
          if (selectedFiles.length) {
            const formData = new FormData();
            selectedFiles.forEach((file) => formData.append("files", file));
            const extraction = await apiForm<FileTextExtractionResponse>("/api/documents/extract-file-text", formData);
            const warnings = [
              ...extraction.rejectedFiles.map((item) => `${item.fileName}: ${item.reason}`),
              ...extraction.files.filter((item) => item.warning).map((item) => `${item.fileName}: ${item.warning}`),
            ];
            files = extraction.files;
            extractionWarning = warnings.join(" ");
          }
          const combinedCheckText = `${pasteText}\n${files.map((file) => file.extractedText).join("\n")}`.trim();
          if (!hasWebsite && !combinedCheckText) {
            // 2026-09-17: say WHY. This used to blame "a scanned PDF" for every
            // empty result, including uploads the server failed to read at all
            // (a missing PDF worker in the Docker image) — the per-file reason
            // was collected above and then thrown away.
            const failed = files.filter((file) => file.status === "failed");
            const msg = failed.length
              ? `The server could not read ${failed.length === files.length ? "these files" : `${failed.length} of the files`}. ${extractionWarning}`.trim()
              : "No readable text was found in the selected file. If this is a scanned PDF, paste the text manually or use an OCR version.";
            setDocWarning(msg);
            throw new Error(msg);
          }
          if (combinedCheckText && !looksCompanyRelated(combinedCheckText)) {
            const msg = "This text does not seem to contain useful company/business information. Please upload brochure, catalogue, FAQ, policy, product, or sales documents.";
            setDocWarning(msg);
            throw new Error(msg);
          }
          setDocWarning(extractionWarning);
          setPreview(null);
          const result = await api<CombinedExtractionResponse>("/api/onboarding/extract-company-knowledge", {
            method: "POST",
            body: {
              workspaceId,
              websiteUrl: hasWebsite ? url.trim() : undefined,
              websiteConsent: consentGiven,
              files,
              pastedText: pasteText.trim() || undefined,
            },
          });
          setCombinedResult(result);
          setDocSuccess("Your website and documents have been analyzed together. Review the Knowledge Base and answer missing questions before syncing.");
          await loadActiveExtraction();
          }).finally(async () => {
            // A refused extraction is terminal too. Refresh after both outcomes
            // before releasing the request lock; polling retries status outages.
            await loadActiveExtraction().catch(() => undefined);
            setIsExtractingKnowledge(false);
          });
        }}><Sparkles className="h-4 w-4" /> {extractionIsActive ? "Extraction running..." : "Extract Company Knowledge"}</button>
          <button className="btn secondary" disabled={!extractionIsActive} onClick={() => run("Cancel extraction", async () => {
            const result = await api<{ message?: string }>("/api/extraction-runs/cancel-active", { method: "POST", body: { workspaceId } });
            setDocWarning(result.message || "Extraction cancel requested. You can restart after the current model call stops.");
            await loadActiveExtraction();
          })}>Cancel</button>
        </div>
        <div className="hidden bg-border-default lg:block" />
        <ExtractionStatusBox
          status={activeExtraction}
          localRunning={isExtractingKnowledge}
          onRetryFailed={activeExtraction?.run?.id ? () => run("Retry failed extraction items", async () => {
            await api(`/api/extraction-runs/${activeExtraction.run!.id}/retry-failed`, { method: "POST", body: { workspaceId } });
            await loadActiveExtraction();
          }) : undefined}
        />
        </div>
        {docWarning ? <p className="mt-3 rounded-md border border-warning-bg bg-warning-bg p-3 text-sm text-warning-fg">{docWarning}</p> : null}
        {docSuccess ? <p className="mt-2 rounded-md border border-success-bg bg-surface-tint p-2 text-sm text-success-fg">{docSuccess}</p> : null}
        {combinedResult ? <CombinedExtractionSummary result={combinedResult} setActive={setActive} /> : null}
        {preview ? (
          <div className="mt-4">
            <DocumentMappingPreviewView preview={preview} />
            <button className="btn mt-3" onClick={() => run("Apply extracted knowledge", async () => {
              await api("/api/documents/apply", { method: "POST", body: { workspaceId, preview } });
              setPreview(null);
              setDocSuccess("Knowledge candidates added. Review guided Knowledge Base sections before relying on them.");
              setFileNames([]);
              setSelectedFiles([]);
            })}><Check className="h-4 w-4" /> Add to Knowledge Base</button>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function EssentialSetupQuestions({ summary, error, onRetry }: { summary: EssentialQuestionsResponse | null; error: string | null; onRetry?: () => void }) {
  const groups = summary?.groups || [];
  const visibleGroups = groups.slice(0, 12);
  return (
    <div className="mt-3 rounded-md border border-border-default bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-foreground">Essential setup questions</p>
          <p className="mt-1 text-sm text-muted-2">
            {error
              ? "Couldn't load the essential questions. Check your connection and try again."
              : summary
                ? `${summary.visibleEssentialQuestions} starting questions across ${summary.coreDomainCount} business areas. Additional checks run automatically behind the scenes as your business knowledge grows.`
                : "Loading the essential setup questions for this workspace."}
          </p>
        </div>
        {/* 2026-09-04 N-UX-27 — this badge said "50 visible" directly beside a
            sentence that had just said "50 starting questions across 12
            business areas". The same number twice in one header, the second
            time with a word ("visible") that raises a question the first
            sentence had already answered. */}
        {error
          ? <button className="btn secondary text-xs" onClick={onRetry}>Try again</button>
          : summary ? null : <Badge>Loading</Badge>}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {visibleGroups.map((group) => (
          <details key={group.coreDomainKey} className="rounded-md border border-border-subtle bg-surface-muted p-3" open={group.coreDomainKey === "brand_identity" || group.coreDomainKey === "products_services"}>
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-foreground">{group.coreDomainTitle}</span>
                <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-[11px] font-semibold text-muted-2">{group.questions.length} questions</span>
              </div>
              <p className="mt-1 text-xs text-muted">{group.description}</p>
            </summary>
            <ul className="mt-3 space-y-2">
              {group.questions.slice(0, 5).map((question) => (
                <li key={question.id} className="flex gap-2 text-xs text-muted-2">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                  <span>{question.question}</span>
                </li>
              ))}
              {group.questions.length > 5 ? <li className="text-xs font-semibold text-muted">+ {group.questions.length - 5} more in this area</li> : null}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

function ProfileView({ profile, run, initialCompanyName }: SectionProps & { initialCompanyName?: string }) {
  const [draft, setDraft] = useState<Partial<BusinessProfile>>(profile || { companyName: initialCompanyName || "" });
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile || { companyName: initialCompanyName || "" });
  async function saveProfile() {
    if (saving || !draft.companyName?.trim()) return;
    setSaving(true);
    try {
      await run("Save profile", () => api(profile?.id ? `/api/business-profile/${profile.id}` : "/api/business-profile", {
        method: profile?.id ? "PUT" : "POST", body: draft,
      }));
    } finally { setSaving(false); }
  }
  // 2026-09-04 N-UX-46 — the title said the same thing as the sentence under
  // it ("factual identity only" / "stable company identity"), so the reader was
  // told twice and shown nothing. The title now names the job and the sentence
  // says what goes elsewhere.
  return (
    <Panel title="Your company's fixed details" icon={FileText}>
      <p className="mb-4 text-sm text-muted-2">The facts that rarely change: name, address, how to reach you. What you sell, who you sell to, and how the agent should reply all live in the Knowledge Base.</p>
      <fieldset disabled={saving || approving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Company name" value={draft.companyName || ""} onChange={(v) => setDraft({ ...draft, companyName: v })} />
        <Field label="Industry" value={draft.industry || ""} onChange={(v) => setDraft({ ...draft, industry: v })} />
        <Field label="Website" value={draft.websiteUrl || ""} onChange={(v) => setDraft({ ...draft, websiteUrl: v })} />
        <Field label="Email" value={draft.contactEmail || ""} onChange={(v) => setDraft({ ...draft, contactEmail: v })} />
        <Field label="Phone" value={draft.contactPhone || ""} onChange={(v) => setDraft({ ...draft, contactPhone: v })} />
        <Field label="WhatsApp" value={draft.whatsappNumber || ""} onChange={(v) => setDraft({ ...draft, whatsappNumber: v })} />
        <Field label="Address" value={draft.address || ""} onChange={(v) => setDraft({ ...draft, address: v })} />
        <Field label="City" value={draft.city || ""} onChange={(v) => setDraft({ ...draft, city: v })} />
        <Field label="State" value={draft.state || ""} onChange={(v) => setDraft({ ...draft, state: v })} />
        <Field label="Country" value={draft.country || ""} onChange={(v) => setDraft({ ...draft, country: v })} />
        <Field label="Business type" value={draft.businessType || ""} onChange={(v) => setDraft({ ...draft, businessType: v })} />
      </div>
      {/* 2026-09-08 — `description` is not a decorative blurb. AgentContextBuilder
          puts it into the context of EVERY AI reply as "Description: ...", so
          whatever sits here is what the agent believes the company does. It was
          written once by the website extractor and after that no screen in the
          product could change it: a demo workspace rebuilt for a zari
          manufacturer still told the agent it sold "enterprise software
          solutions, including a Cloud ERP System", and every reply was drafted
          on that. The PUT route has always accepted the field. Same shape as the
          product price and the ticket assignee — the read side shipped, the
          write side never existed. */}
      <label className="mt-4 block">
        <span className="label">What this company does — the agent reads this before every reply</span>
        <textarea
          className="input min-h-24"
          value={draft.description || ""}
          placeholder="One or two sentences: what you make or sell, and who you sell it to."
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      {/* 2026-09-25 (cleanup pass) — three buttons became two, and the note
          about where products "used to be edited" (history, not an
          instruction; the sentence at the top already says where they live)
          is gone.
          - "Sync Knowledge" repeated Save: saving already rebuilds what the
            AI knows from this profile (N-AI-10), and the full sync is one
            press away on the Knowledge Base.
          - "Approve" did something real that its label never said: once
            approved, an uploaded document that disagrees raises a question
            for the owner instead of changing these fields. It now says that,
            and disappears once done. */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn" disabled={saving || !draft.companyName?.trim()} onClick={saveProfile}><Check className="h-4 w-4" /> {saving ? "Saving..." : "Save"}</button>
        {draft.status === "approved" ? (
          <span className="text-sm text-success-fg">Marked correct: documents you upload cannot change these details without asking you.</span>
        ) : (
          <>
            {profile?.id && <Button variant="secondary" disabled={dirty || saving || approving} loading={approving} onClick={async () => {
              if (dirty || approving || saving) return;
              setApproving(true);
              try { await run("Approve profile", () => api(`/api/business-profile/${profile.id}/approve`, { method: "POST", body: { workspaceId } })); }
              finally { setApproving(false); }
            }}>Mark as correct</Button>}
            <span className="text-xs text-muted">Then documents you upload cannot change these details without asking you.</span>
          </>
        )}
      </div>
      {dirty ? <p role="status" className="mt-2 text-sm text-warning-fg">You have unsaved company details. Save them before marking these details as correct.</p> : null}
      </fieldset>
    </Panel>
  );
}



type DocumentMappingPreview = {
  documentTitle: string;
  documentType: string;
  confidenceScore: number;
  businessProfilePatch: Record<string, unknown>;
  products: Array<Record<string, unknown>>;
  knowledgeDocuments: Array<{ title: string; documentType: string; contentText: string; confidenceScore: number }>;
  policies: Array<Record<string, unknown>>;
  faqs: Array<Record<string, unknown>>;
  companyKnowledge?: Array<Record<string, unknown>>;
  customerKnowledge?: Array<Record<string, unknown>>;
  missingQuestions: Array<{ id: string; section: string; question: string }>;
  unmappedInformation: string[];
  modelUsed?: { provider?: string; modelName?: string; slotId?: string; fallbackUsed?: boolean };
  questionAnswering?: {
    totalQuestions: number;
    answeredCount: number;
    unansweredCount: number;
    partialCount: number;
    conflictCount: number;
    additionalMissingQuestionsCount?: number;
    modelUsed?: { provider?: string; modelName?: string; slotId?: string; mode?: string; fallbackUsed?: boolean; warning?: string };
    run?: { processedQuestions?: number; totalBatches?: number; completedBatches?: number; failedBatchCount?: number; status?: string; currentDomain?: string };
    domains: Array<{ domainKey: string; domainTitle: string; totalQuestions: number; answeredCount: number; unansweredCount: number; conflictCount: number }>;
  };
};

type FileTextExtractionResponse = {
  combinedText: string;
  rejectedFiles: Array<{ fileName: string; reason: string }>;
  files: Array<{ fileName: string; fileType: string; status: string; extractedText: string; warning?: string }>;
};

type CombinedExtractionResponse = {
  bundle: { id: string; status: string; sourceCount: number; combinedTextLength: number; extractionRunId?: string };
  sources: Array<{ id: string; sourceType: string; sourceTitle: string; status: string; extractedText?: string }>;
  readySources: Array<{ id: string; sourceType: string; sourceTitle: string; status: string; extractedText?: string }>;
  questionAnswering: NonNullable<DocumentMappingPreview["questionAnswering"]>;
};

type EssentialQuestionsResponse = {
  totalInternalQuestions: number;
  visibleEssentialQuestions: number;
  coreDomainCount: number;
  message: string;
  groups: Array<{
    coreDomainKey: string;
    coreDomainTitle: string;
    description: string;
    questions: Array<{
      id: string;
      question: string;
      required: boolean;
      priority: string;
      humanReviewRequired: boolean;
    }>;
  }>;
};

export type ExtractionStatusResponse = {
  active: boolean;
  run: null | {
    id: string;
    status: string;
    totalQuestions?: number;
    processedQuestions?: number;
    answeredCount?: number;
    partialCount?: number;
    unansweredCount?: number;
    conflictCount?: number;
    failedBatchCount?: number;
    totalBatches?: number;
    completedBatches?: number;
    currentDomain?: string;
    currentBatchIndex?: number;
    modelProvider?: string;
    modelName?: string;
    fallbackUsed?: boolean;
    errorMessage?: string;
    quality?: {
      score: number;
      level: string;
      message: string;
      nextAction: string;
      highPriorityMissingCount: number;
      criticalMissingDomains: string[];
      realLlmBatchCount: number;
      fallbackBatchCount: number;
      averageConfidence: number;
    };
    batchSummary?: {
      batches?: Array<{
        id: string;
        domainKey: string;
        questionCount: number;
        status: string;
        provider?: string;
        modelName?: string;
        latencyMs?: number;
        attemptCount?: number;
        answeredCount?: number;
        partialCount?: number;
        unansweredCount?: number;
        conflictCount?: number;
        errorMessage?: string;
      }>;
    };
    nextAction?: string;
  };
  batchSummary: null | {
    totalBatches: number;
    completedBatches: number;
    failedBatches: number;
    canceledBatches: number;
    runningBatches: number;
    averageBatchMs: number;
    realLlmBatches?: number;
    fallbackBatches?: number;
  };
};

type ProspectingRunResponse = {
  status: "completed";
  mode: "live_google_maps" | "llm_assisted_demo" | "fallback_demo" | "search_unavailable";
  modeLabel: string;
  providerStatus: {
    serpApiConfigured: boolean;
    provider: string;
    modelName?: string;
    llmMode?: string;
    fallbackUsed?: boolean;
    warning?: string;
  };
  queries: string[];
  leads: Lead[];
  created: number;
  updated: number;
  duplicatesAvoided: number;
  scrapedWebsites: number;
  runId: string;
  warnings: string[];
};

function ExtractionStatusBox({ status, localRunning, onRetryFailed }: { status: ExtractionStatusResponse | null; localRunning: boolean; onRetryFailed?: () => void }) {
  const run = status?.run;
  const isActive = Boolean(status?.active || localRunning);
  const answered = run?.answeredCount ?? 0;
  const partial = run?.partialCount ?? 0;
  const unanswered = run?.unansweredCount ?? 0;
  const conflicts = run?.conflictCount ?? 0;
  const total = run?.totalQuestions ?? 0;
  const quality = run?.quality;
  const failedBatches = run?.failedBatchCount ?? 0;
  return (
    <div className={`rounded-md border p-3 text-sm ${isActive ? "border-warning-bg bg-warning-bg" : "border-border-default bg-surface-muted"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-foreground">Extraction status</p>
        <Badge>{isActive ? "Running" : run?.status ? displayLabel(run.status) : "Idle"}</Badge>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-border-default bg-surface p-3">
          <p className="text-xs text-muted">Information found</p>
          <p className="mt-1 text-xl font-semibold text-primary">{answered}</p>
          {total > 0 ? <p className="text-xs text-muted">of {total} checks</p> : null}
        </div>
        <div className="rounded-md border border-border-default bg-surface p-3">
          <p className="text-xs text-muted">Still needed</p>
          <p className="mt-1 text-xl font-semibold text-warning-fg">{unanswered + partial}</p>
          <p className="text-xs text-muted">Review in Questions from AI</p>
        </div>
        <div className="rounded-md border border-border-default bg-surface p-3">
          <p className="text-xs text-muted">Conflicts found</p>
          <p className="mt-1 text-xl font-semibold text-danger-fg">{conflicts}</p>
          <p className="text-xs text-muted">Review in Settings → Conflicts</p>
        </div>
        <div className="rounded-md border border-border-default bg-surface p-3">
          <p className="text-xs text-muted">Quality</p>
          <p className="mt-1 text-xl font-semibold text-foreground">{quality ? `${quality.level}` : "—"}</p>
          <p className="text-xs text-muted">{quality ? quality.nextAction : "No extraction run yet"}</p>
        </div>
      </div>
      {run?.errorMessage ? <p className="mt-3 rounded-md border border-warning-bg bg-surface p-2 text-xs text-warning-fg">{ownerFacingFailureText(run.errorMessage)}</p> : null}
      {/* UA-2 fix: this run completed "successfully" but used zero real-model
          batches (all fell back to mock/sample answers) — that fact used to
          only be visible per-batch inside the collapsed "Batch diagnostics"
          detail, so an operator who didn't expand it would believe their real
          API key was used. Surface it as a top-level, un-missable banner
          instead, matching how errorMessage is already surfaced above. */}
      {!isActive && quality && quality.realLlmBatchCount === 0 && quality.fallbackBatchCount > 0 ? (
        <p className="mt-3 rounded-md border border-danger-bg bg-danger-bg p-2 text-xs text-danger-fg">
          {run?.status === "failed"
            ? "No company answers were added. Connect a working AI model in AI Settings, then try again."
            : "This result used sample answers. Connect a working AI model in AI Settings, then try again before relying on the result."}
        </p>
      ) : null}
      {isActive ? <p className="mt-2 text-xs text-muted">Extraction is running in the background. You can continue working.</p> : null}
      {/* S6 U-2: when a batch finishes with failures, surface a "Retry failed"
          button so the owner doesn't have to re-upload everything from
          scratch. The backend retry-failed endpoint already existed; the UI
          just didn't expose it. */}
      {failedBatches > 0 && !isActive && onRetryFailed ? (
        <div className="mt-3 flex items-center gap-2">
          <Badge tone="warning">{failedBatches} batch{failedBatches === 1 ? "" : "es"} failed</Badge>
          <button className="btn secondary text-xs py-1 px-2" onClick={onRetryFailed}>Retry failed items</button>
        </div>
      ) : null}
      {run?.batchSummary?.batches?.length ? (
        <details className="mt-3 rounded-md border border-border-default bg-surface p-3 text-xs text-muted-2">
          <summary className="cursor-pointer font-semibold text-foreground">Details by section ({run.batchSummary.batches.length})</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {run.batchSummary.batches.map((batch) => (
              <div key={batch.id} className="rounded-md border border-border-subtle bg-surface p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{formatDomainLabel(batch.domainKey)}</span>
                  <Badge>{displayLabel(batch.status)}</Badge>
                </div>
                <p className="mt-1">Questions: {batch.questionCount} / answered {batch.answeredCount || 0}, partial {batch.partialCount || 0}, missing {batch.unansweredCount || 0}, conflicts {batch.conflictCount || 0}</p>
                <p className="mt-1">Processing time: {formatDuration(batch.latencyMs || 0)}</p>
                {batch.errorMessage ? <p className="mt-1 text-warning-fg">{ownerFacingFailureText(batch.errorMessage)}</p> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function formatDuration(ms: number) {
  if (!ms) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatDomainLabel(domain?: string) {
  return domain ? knowledgeAreaName(domain) : "Waiting";
}

function CombinedExtractionSummary({ result, setActive }: { result: CombinedExtractionResponse; setActive: (tab: TabId) => void }) {
  const qa = result.questionAnswering;
  const websiteIncluded = result.readySources.some((source) => source.sourceType === "website");
  const fileCount = result.readySources.filter((source) => source.sourceType === "uploaded_file").length;
  const failedSources = result.sources.filter((source) => source.status === "failed");
  return (
    <div className="mt-4 rounded-md border border-success-bg bg-surface-tint p-3 text-sm text-success-fg">
      <p className="font-semibold text-foreground">Combined extraction complete</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge>Website: {websiteIncluded ? "included" : "not included"}</Badge>
        <Badge>Files: {fileCount}</Badge>
        <Badge>{qa.totalQuestions} questions</Badge>
        <Badge>{qa.answeredCount} answered</Badge>
        <Badge>{qa.partialCount} partial</Badge>
        <Badge>{qa.conflictCount} conflicts</Badge>
      </div>
      <p className="mt-2 text-xs text-muted-2">One combined Knowledge Base extraction ran across all ready sources. No existing knowledge was deleted.</p>
      {qa.run ? <p className="mt-1 text-xs text-muted-2">Progress: {qa.run.processedQuestions || qa.totalQuestions} / {qa.totalQuestions} questions, {qa.run.completedBatches || 0} / {qa.run.totalBatches || 0} batches, failed batches: {qa.run.failedBatchCount || 0}.</p> : null}
      {failedSources.length ? <p className="mt-2 rounded-md border border-warning-bg bg-warning-bg p-2 text-xs text-warning-fg">{failedSources.length} source failed, but other readable sources were processed.</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn secondary text-xs" onClick={() => setActive("knowledge")}>Review Knowledge Base</button>
        <button className="btn secondary text-xs" onClick={() => setActive("unknown")}>Review Questions from AI</button>
      </div>
    </div>
  );
}

function DocumentMappingPreviewView({ preview }: { preview: DocumentMappingPreview }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2"><Badge>{displayLabel(preview.documentType)}</Badge><Badge>{Math.round(preview.confidenceScore * 100)}% confidence</Badge></div>
      {preview.modelUsed?.fallbackUsed ? <Row label="Extraction quality" value="Sample data (backup)" /> : null}
      <Row label="Source document" value={preview.documentTitle} />
      {preview.questionAnswering ? (
        <div className="rounded-md border border-success-bg bg-surface-tint p-3">
          <p className="font-semibold text-success-fg">Question-driven extraction complete</p>
          <div className="mt-2 grid gap-2 md:grid-cols-4">
            <Badge>{preview.questionAnswering.answeredCount} answered</Badge>
            <Badge>{preview.questionAnswering.partialCount} partial</Badge>
            <Badge>{preview.questionAnswering.unansweredCount} unanswered</Badge>
            <Badge>{preview.questionAnswering.conflictCount} conflicts</Badge>
          </div>
          <p className="mt-2 text-xs text-muted-2">The internal framework checked {preview.questionAnswering.totalQuestions} questions across {preview.questionAnswering.domains.length} domains. Business users review guided sections and grouped question cards.</p>
          {preview.questionAnswering.run ? <p className="mt-1 text-xs text-muted-2">Progress: {preview.questionAnswering.run.processedQuestions || preview.questionAnswering.totalQuestions} / {preview.questionAnswering.totalQuestions} questions, {preview.questionAnswering.run.completedBatches || 0} / {preview.questionAnswering.run.totalBatches || 0} batches, failed batches: {preview.questionAnswering.run.failedBatchCount || 0}.</p> : null}
          {preview.questionAnswering.additionalMissingQuestionsCount ? <p className="mt-1 text-xs text-success-fg">{preview.questionAnswering.additionalMissingQuestionsCount} extra clarification questions were created for missing product, policy, or specification details.</p> : null}
          {preview.questionAnswering.modelUsed?.fallbackUsed ? <p className="mt-1 text-xs text-muted-2">Question answering used sample data (backup mode). Review the results before trusting them.</p> : null}
        </div>
      ) : null}
      <p className="font-semibold">Business Profile Suggestions</p>
      <Chips items={Object.entries(preview.businessProfilePatch || {}).map(([key, value]) => `${key}: ${String(Array.isArray(value) ? value.join(", ") : value)}`)} />
      <p className="font-semibold">Product Suggestions</p>
      {preview.products.length ? preview.products.map((item, index) => <Row key={index} label={String(item.productName || "Product")} value={String(item.description || "Detected product information")} />) : <Empty text="No product suggestions detected." />}
      <p className="font-semibold">Knowledge Base Suggestions</p>
      {preview.knowledgeDocuments.map((item) => <Row key={item.title} label={item.title} value={`${displayLabel(item.documentType)} / ${Math.round(item.confidenceScore * 100)}%`} />)}
      <p className="font-semibold">Policy / FAQ Suggestions</p>
      <Chips items={[...preview.policies.map((item) => String(item.topic || "Policy")), ...preview.faqs.map((item) => String(item.question || "FAQ"))]} />

      {(preview.companyKnowledge && preview.companyKnowledge.length > 0) && (
        <>
          <p className="font-semibold mt-4 border-t pt-2">Extracted Company Knowledge</p>
          <Chips items={preview.companyKnowledge.map((item) => String(item.question || "Company Fact"))} />
        </>
      )}

      {(preview.customerKnowledge && preview.customerKnowledge.length > 0) && (
        <>
          <p className="font-semibold mt-4 border-t pt-2">Extracted Customer Knowledge</p>
          <Chips items={preview.customerKnowledge.map((item) => String(item.question || "Customer Fact"))} />
        </>
      )}

      {(preview.missingQuestions && preview.missingQuestions.length > 0) && (
        <div className="mt-4 rounded-md border border-danger-bg bg-danger-bg p-3">
          <p className="font-semibold text-danger-fg">{preview.missingQuestions.length} information areas need your review</p>
          <p className="text-xs text-danger-fg">Go to the Questions from AI tab to answer them as simple grouped business cards. You do not need to answer a long question list.</p>
        </div>
      )}

      {preview.unmappedInformation.length ? <><p className="font-semibold mt-4 border-t pt-2">Unmapped Extra Information</p><Chips items={preview.unmappedInformation} /></> : null}
    </div>
  );
}



function ICPView({ profile, icps, run }: SectionProps & { icps: ICP[] }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* 2026-09-04 N-UX-28 — this line existed to explain the abbreviation
            in the button beside it. Using the plain words instead removes both
            the jargon and the sentence that apologised for it. */}
        <p className="text-sm text-muted-2">Pick one focused buyer group before finding leads. The AI ranks new companies against whichever one you choose.</p>
        <div className="flex flex-wrap gap-2">
          {/* N-BUG (2026-09-08): POST /api/product-research/generate had no
              caller anywhere in the app — no button, no script — while the
              dashboard's recommended next action told the operator to "analyze
              product applications and buyer segments to improve targeting".
              This is that action. It reads the Settings → Products catalogue
              and feeds the buyer segments the customer-type suggestions below
              are built from, so it belongs immediately before them. */}
          <button className="btn secondary" disabled={!profile} onClick={() => run("Research product applications", () => api("/api/product-research/generate", { method: "POST", body: { workspaceId } }))}>
            <Sparkles className="h-4 w-4" /> Research who buys these products
          </button>
          <button className="btn secondary" disabled={!profile} onClick={() => run("Generate ICPs", () => api("/api/icp/generate", { method: "POST", body: { workspaceId } }))}>
            <Sparkles className="h-4 w-4" /> {icps.length > 0 ? "Suggest different ones" : "Suggest customer types"}
          </button>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Stage A+ / Cluster 10b (P2-11): explicit empty state with CTA. Was:
            rendered an empty grid when no ICPs — the user couldn't tell whether
            to click the Generate button at the top or whether something was
            broken. Now points them at the action. */}
        {icps.length === 0 && (
          <div className="lg:col-span-3">
            <EmptyState
              icon={Users}
              title="No ICPs yet"
              description={profile ? "Choose \"Suggest customer types\" above to draft ideal customer profiles tailored to your business." : "Add your business profile first (Onboarding tab), then suggest customer types."}
            />
          </div>
        )}
        {/* 2026-09-04 N-UX-29 — every card offered "Select" in the same solid
            button, including the one already selected. `icp.status` has always
            said which one it is; nothing rendered it. So the Campaign screen
            named a chosen buyer group while this screen, whose only job is
            choosing it, showed three identical unchosen cards. The chosen one
            now says so, loses the button that would re-do what is already
            done, and cannot be rejected by a stray click. */}
        {icps.map((icp) => {
          const isChosen = icp.status === "selected";
          return (
          <Panel key={icp.id} title={icp.name} icon={Users}>
            {isChosen ? (
              <p className="mb-2 inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success-fg">
                <Check className="h-3 w-3" /> This is who you are selling to
              </p>
            ) : null}
            <p className="text-sm text-muted-2">{icp.description}</p>
            <Chips items={[icp.buyerType, ...icp.geography, ...icp.preferredChannels]} />
            <p className="mt-3 text-sm"><b>Why fit:</b> {icp.messagingAngles.join(", ")}</p>
            <p className="mt-2 text-sm"><b>Rules:</b> {icp.qualificationRules.join("; ")}</p>
            {isChosen ? <IcpExclusions icp={icp} run={run} /> : null}
            {isChosen ? null : (
              <div className="mt-4 flex gap-2">
                <button className="btn" onClick={() => run("Select ICP", () => api(`/api/icp/${icp.id}/select`, { method: "POST", body: { workspaceId } }))} aria-label={`Sell to ${icp.name}`}><Check className="h-4 w-4" /> Sell to these</button>
                <button className="icon-btn" onClick={() => run("Reject ICP", () => api(`/api/icp/${icp.id}/reject`, { method: "POST", body: { workspaceId } }))} title="Not interested" aria-label={`Not interested in ${icp.name}`}><X className="h-4 w-4" /></button>
              </div>
            )}
          </Panel>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Session 55 — "who we do NOT sell to", on the ICP the owner chose.
 *
 * The ICP said who to sell to and had no way to say who not to, so discovering
 * "zari manufacturer Surat" surfaced the company's own competitors alongside
 * its buyers — and competitors are the easiest of all to reach, so the F-N-R-T
 * score ranked them highest. A score cannot express a disqualification; this
 * can.
 */
function IcpExclusions({ icp, run }: { icp: ICP; run: Runner }) {
  const [draft, setDraft] = useState((icp.exclusions || []).join("\n"));
  const saved = (icp.exclusions || []).join("\n");
  const dirty = draft !== saved;
  return (
    <div className="mt-4 rounded-md border border-border-subtle bg-surface-muted p-3">
      <p className="label">Who you do NOT sell to</p>
      <p className="mt-1 text-xs text-muted">
        One phrase per line, in your own words — a competitor&apos;s trade, an
        industry you avoid. A lead whose details contain one of these is flagged
        in Lead Review with the phrase that matched, so you can still overrule it.
      </p>
      <textarea
        className="input mt-2 min-h-20 font-mono text-xs"
        aria-label="Who you do NOT sell to"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={"manufactures the same product\nstaffing agency\nrecruitment"}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          disabled={!dirty}
          onClick={() => run("Save who you do not sell to", () => api(`/api/icp/${icp.id}`, {
            method: "PUT",
            body: {
              workspaceId,
              exclusions: draft.split("\n").map((line) => line.trim()).filter(Boolean),
            },
          }))}
        >
          Save
        </Button>
        <span className="text-xs text-muted">{dirty ? "Unsaved changes" : `${(icp.exclusions || []).length} rule${(icp.exclusions || []).length === 1 ? "" : "s"} saved`}</span>
      </div>
    </div>
  );
}

function CampaignView({ profile, icp, campaigns, run }: SectionProps & { icp?: ICP; campaigns: Campaign[] }) {
  // 2026-09-25 (cleanup pass) — was two panels: an explainer with "Generate
  // Recommended Campaign", and the plans, each with a "Regenerate" button that
  // called the SAME endpoint (it made a new plan, it did not change that one),
  // an "Approve" button even on approved plans, and a hard-coded "Lead intent
  // signals" sentence repeated on every plan (the explainer already says it).
  // Now: one list, one "Make a new plan", and each plan shows only the buttons
  // that apply to its state.
  const makePlan = () => run("Make a campaign plan", () => api("/api/campaigns", { method: "POST", body: { workspaceId, businessProfileId: profile?.id, icpId: icp?.id, goal: "find qualified buyers", leadGoal: 50, dailyOutreachLimit: 20 } }));
  return (
    <Panel title="Your campaign plans" icon={Workflow}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-2">
          The AI writes a plan from your knowledge base for the customer type you picked
          {icp ? <> — now <strong className="text-foreground">{icp.name}</strong></> : null}.
          You approve it before any outreach is prepared. A request for a catalogue, price, quote or sample counts as buying interest.
        </p>
        <Button icon={Workflow} variant={campaigns.length ? "secondary" : "primary"} disabled={!profile || !icp} onClick={makePlan}>Make a new plan</Button>
      </div>
      {!icp ? <p className="mt-2 text-sm text-warning-fg">Pick who you sell to in Ideal Customers first.</p> : null}
      <div className="mt-4 space-y-3">
        {campaigns.map((campaign) => {
          const approved = campaign.approvalStatus === "approved";
          return (
            <div key={campaign.id} className="rounded-lg border border-border-default p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">{campaign.name}</span>
                <Badge tone={campaign.status === "active" ? "success" : campaign.status === "paused" ? "warning" : "neutral"}>{displayCampaignStatus(campaign.status)}</Badge>
                {!approved ? <Badge tone="warning">{displayCampaignApprovalStatus(campaign.approvalStatus)}</Badge> : null}
              </div>
              <p className="mt-2 text-sm text-muted-2">{campaign.plan.messageStrategy}</p>
              {campaign.plan.searchQueries.length ? (
                <p className="mt-2 text-xs text-muted">Searches it will run: {campaign.plan.searchQueries.slice(0, 4).join(" · ")}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {!approved ? (
                  <Button icon={Check} onClick={() => run("Approve campaign", () => api(`/api/campaigns/${campaign.id}/approve`, { method: "POST", body: { workspaceId } }))}>Approve</Button>
                ) : null}
                {/* 2026-08-02 audit P2-4 — Pause/Resume (the route had no UI). */}
                {campaign.status === "active" ? (
                  <Button variant="secondary" onClick={() => run("Pause campaign", () => api(`/api/campaigns/${campaign.id}/pause`, { method: "POST", body: { workspaceId } }))}>Pause</Button>
                ) : null}
                {campaign.status === "paused" ? (
                  <Button variant="secondary" onClick={() => run("Resume campaign", () => api(`/api/campaigns/${campaign.id}/approve`, { method: "POST", body: { workspaceId } }))}>Resume</Button>
                ) : null}
              </div>
            </div>
          );
        })}
        {!campaigns.length ? <Empty text="No plans yet. Pick who you sell to, then press Make a new plan." /> : null}
      </div>
    </Panel>
  );
}

function Discovery({ campaign, icp, leads, run }: { campaign?: Campaign; icp?: ICP; leads: Lead[]; run: Runner }) {
  const [showManual, setShowManual] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<ProspectingRunResponse | null>(null);
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [csvError, setCsvError] = useState("");
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [customQuery, setCustomQuery] = useState("");
  const query = campaign?.plan?.searchQueries?.[0] || (campaign?.name ? campaign.name : "B2B buyers");
  // The template ships to every workspace, so the example row must not name a
  // business, a city or a product. It shows the SHAPE of a row, nothing else.
  const csvTemplate = "company_name,website,email,phone,city,country,fit_reason\nExample Company Ltd,https://example.com,contact@example.com,+10000000000,City,Country,Why this company could be a customer\n";
  return (
    <div className="space-y-4">
      {/* 2026-09-04 N-UX-44 — the heading named the feature ("Prospect
          Discovery Plan"); it now names the job. The row labels did the same:
          "Current campaign" and "Target segment" are our words for the two
          things that decide who gets searched for, so they now say that. And
          the source row named a vendor (SerpApi) that means nothing to the
          operator — what he needs to know is whether the results are real. */}
      <Panel title="Who we will go looking for" icon={Search}>
        {!campaign ? <Empty text="Approve a campaign first. The agent will then prepare lead discovery strategy." /> : (
          <>
            <ProfileRows items={{
              "Searching for this campaign": campaign.name,
              "Kind of company we want": icp?.name || "Selected ICP",
              "Where the names come from": "Google Maps, using the search phrases below (sample results until a web-search key is connected; the results say which).",
            }} />
            <p className="mt-3 rounded-md border border-border-default bg-surface-muted p-3 text-sm text-muted-2">Every company found lands in your leads list with a score, whatever contact details we could find, and a link back to where it came from. Nothing is contacted until you say so.</p>
            <Chips items={campaign.plan.searchQueries?.length ? campaign.plan.searchQueries : [query]} />
          </>
        )}
      </Panel>
      {/* 2026-09-25 (cleanup pass) — a "Discovered leads" table sat beside this
          panel. It showed the first 8 of ALL leads (won and old ones included),
          not what discovery found, so it was a smaller copy of the Leads list
          under a misleading name. What a search found is already reported by
          the run summary inside this panel; the pending count below says
          where new leads wait. The panel now takes the full width. */}
      {(() => {
        const pending = leads.filter((l) => l.reviewStatus === "pending").length;
        return pending ? <p className="rounded-md border border-warning-bg bg-warning-bg px-4 py-3 text-sm text-warning-fg">{pending} new lead{pending === 1 ? " is" : "s are"} waiting for your approval in Lead Review.</p> : null;
      })()}
      <div>
        {/* 2026-09-04 N-UX-45 — titled "Manual import", but two of its three
            buttons are not imports: this is where leads are found, uploaded OR
            typed. The title now covers all three. */}
        <Panel title="Get leads into the list" icon={Upload}>
          <label className="mb-3 block">
            <span className="label">Search query</span>
            <input className="input" value={customQuery || query} onChange={(event) => setCustomQuery(event.target.value)} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon={Search} disabled={!campaign} onClick={() => run("Run prospect discovery", async () => {
              const result = await api<ProspectingRunResponse>("/api/leads/discover", { method: "POST", body: { workspaceId, campaignId: campaign?.id, icpId: icp?.id, query: customQuery || query, region: campaign?.targetRegion?.[0], limit: 5 } });
              setDiscoveryResult(result);
              return result;
            })}>
              Run prospect discovery
            </Button>
            {/* Session 55: this button used to POST two hardcoded rows ("Acme
                Trading Co", "Global Distributors") and opened no file picker,
                so there was no way to import a real list at all. The route
                behind it was always real — it parses headers, maps six columns
                and creates leads — it simply had nothing to parse. */}
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                // Let the same file be chosen twice in a row.
                event.target.value = "";
                if (!file) return;
                setCsvError("");
                setCsvResult(null);
                const MAX_CSV_BYTES = 5 * 1024 * 1024;
                if (file.size > MAX_CSV_BYTES) {
                  setCsvError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`);
                  return;
                }
                let text: string;
                try {
                  text = await file.text();
                } catch {
                  setCsvError(`Could not read ${file.name}.`);
                  return;
                }
                await run(`Import ${file.name}`, async () => {
                  const result = await api<CsvImportResult>("/api/leads/upload-csv", {
                    method: "POST",
                    body: { workspaceId, campaignId: campaign?.id, icpId: icp?.id, csv: text },
                  });
                  setCsvResult(result);
                  return result;
                });
              }}
            />
            <Button variant="secondary" icon={Upload} onClick={() => csvInputRef.current?.click()}>Import a CSV</Button>
            <Button variant="secondary" icon={MousePointer2} onClick={() => setShowManual(!showManual)}>Type one in by hand</Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Columns: company_name, website, email, phone, city, country,
            fit_reason. Only company_name or website is required.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                const blob = new Blob([csvTemplate], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "leadcockpit-template.csv";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download a template
            </button>
          </p>
          {csvError ? <p role="alert" className="mt-2 rounded-md bg-danger-bg p-2 text-sm text-danger-fg">{csvError}</p> : null}
          {csvResult ? <CsvImportSummary result={csvResult} /> : null}
          {discoveryResult ? <DiscoveryRunSummary result={discoveryResult} /> : null}
          {showManual && <div className="mt-4 rounded-md border border-border-default bg-surface p-3">
            <ManualCustomerForm onSave={values => run("Add manual lead", async () => {
              await api("/api/leads/manual", { method: "POST", body: { workspaceId, campaignId: campaign?.id, icpId: icp?.id, ...values, whatsappNumber: values.phone, source: "manual", fitReason: values.fitReason || "User-entered prospect for review." } });
              return true;
            })} onSaved={() => setShowManual(false)} onCancel={() => setShowManual(false)} />
          </div>}
        </Panel>
      </div>
    </div>
  );
}

/** What POST /api/leads/upload-csv reports back about a real file. */
type CsvImportResult = {
  created: number;
  duplicatesSkipped: number;
  doNotContactSkipped: number;
  emptyRowsSkipped: number;
  rowsRead: number;
  parseErrors: string[];
};

function CsvImportSummary({ result }: { result: CsvImportResult }) {
  return (
    <div className="mt-4 rounded-md border border-border-default bg-surface p-3 text-sm">
      <p className="font-semibold text-foreground">
        Imported {result.created} lead{result.created === 1 ? "" : "s"} from {result.rowsRead} row{result.rowsRead === 1 ? "" : "s"}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <InfoMetric label="Added" value={result.created} tone="success" />
        <InfoMetric label="Already in your list" value={result.duplicatesSkipped} />
        <InfoMetric label="Do not contact — skipped" value={result.doNotContactSkipped || 0} />
        <InfoMetric label="Blank rows skipped" value={result.emptyRowsSkipped} />
      </div>
      {result.duplicatesSkipped > 0 ? (
        <p className="mt-2 text-xs text-muted">
          Rows matching a lead you already have were skipped, so importing the
          same file twice does not duplicate anything.
        </p>
      ) : null}
      {result.parseErrors?.length ? (
        <div className="mt-3 rounded-md border border-warning-bg bg-warning-bg p-2 text-xs text-warning-fg">
          <p className="font-semibold">Some rows could not be read:</p>
          <ul className="mt-1 list-disc pl-4">
            {result.parseErrors.map((error, index) => <li key={index}>{error}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DiscoveryRunSummary({ result }: { result: ProspectingRunResponse }) {
  return (
    <div className="mt-4 rounded-md border border-border-default bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-foreground">Discovery run completed</p>
          <p className="mt-1 text-muted-2">{result.modeLabel}</p>
        </div>
        <Badge>{result.mode === "live_google_maps" ? "Live search" : result.mode === "search_unavailable" ? "Search unavailable" : "Sample buyers"}</Badge>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <InfoMetric label="Created" value={result.created} tone="success" />
        <InfoMetric label="Updated" value={result.updated} />
        <InfoMetric label="Websites checked" value={result.scrapedWebsites} />
        <InfoMetric label="Review leads" value={result.leads.length} />
      </div>
      <div className="mt-3">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">Search queries used</p>
        <Chips items={result.queries} />
      </div>
      <p className="mt-3 text-xs text-muted">
        Leads are saved for review; messages are not sent automatically.
      </p>
      {result.warnings.length ? (
        <div className="mt-3 rounded-md border border-warning-bg bg-warning-bg p-2 text-xs text-warning-fg">
          {result.warnings.slice(0, 3).map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}
    </div>
  );
}

function LeadReview({ leads, run }: { leads: Lead[]; run: Runner }) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  // 2026-08-05 E-P1-8: was console.error only → page looked unconfigured (mode
  // buttons unselected, default threshold). Now surfaces an inline banner so
  // the owner knows their real config didn't load.
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  // 2026-08-05 W-P1-2: was showing ALL leads (14 already-approved + 1 pending)
  // with no way to filter to just the pending ones. Now defaults to "pending
  // only" so the operator lands on the actionable leads, with a toggle to see all.
  const [reviewShowAll, setReviewShowAll] = useState(false);
  // 2026-09-25 — the bar is edited as a whole percentage (85), stored as a
  // fraction (0.85). The box used to show the stored fraction and invite
  // people to type a percentage into it.
  const [threshold, setThreshold] = useState("85");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Stage A+ / Cluster 10b (P2-16): replace window.prompt for reject-reason
  // with an accessible PromptModal. Tracks which lead is being rejected
  // (null when modal closed). One modal instance serves the whole list.
  const [rejectLeadId, setRejectLeadId] = useState<string | null>(null);
  const [dailyLimit, setDailyLimit] = useState("10");
  // 2026-08-02 audit P2-4 — bulk select. The leads/bulk-approve + bulk-reject
  // routes existed but had no UI. An operator with 30 pending leads had to
  // click Approve 30 times. Now: tick the cards, then one bulk action.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // F5 (2026-08-04 CONTINUOUS-2 audit): bulk approve/reject now require a
  // confirmation (D-2026-08-04-l). Every other destructive multi-row action in
  // the app uses ConfirmModal; bulk lead state-change was the exception. For
  // bulk-reject, an optional reason is captured once and applied to all
  // (audit parity with the single-lead reject PromptModal).
  const [bulkAction, setBulkAction] = useState<"bulk-approve" | "bulk-reject" | null>(null);
  const [bulkRejectReason, setBulkRejectReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ action: string; leads: Lead[]; skipped: Array<{ leadId: string; reason: string }> } | null>(null);
  // The agent's recommendation, keyed by lead. Pressing the button used to
  // spend a real model call, write a decision row with its reason, matched
  // signals, risk signals and suggested next step - and show the operator
  // nothing at all. The most recent decision per lead is what the card shows.
  const [decisions, setDecisions] = useState<Record<string, LeadReviewDecision>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  async function runBulk(action: "bulk-approve" | "bulk-reject") {
    const ids = Array.from(selectedIds);
    if (!ids.length || bulkBusy) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const result = await run(action === "bulk-approve" ? `Approving ${ids.length} leads` : `Rejecting ${ids.length} leads`, () => api<{ leads: Lead[]; skipped: Array<{ leadId: string; reason: string }> }>(`/api/leads/${action}`, { method: "POST", body: { ids, ...(action === "bulk-reject" && bulkRejectReason.trim() ? { reason: bulkRejectReason.trim() } : {}) } }));
      if (!result) return; // Keep the selection and confirmation available for a retry.
      setBulkResult({ ...result, action: action === "bulk-approve" ? "approved" : "rejected" });
      setSelectedIds(new Set(result.skipped.map((item) => item.leadId)));
      setBulkAction(null);
      setBulkRejectReason("");
    } finally {
      setBulkBusy(false);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { api<Record<string, unknown>>("/api/lead-review/settings").then((loaded) => { setSettings(loaded); setSettingsLoadError(null); setThreshold(String(Math.round(Number(loaded.autoApproveThreshold || 0.85) * 100))); setDailyLimit(String(loaded.maxAutoApprovedPerDay || 10)); }).catch((error) => setSettingsLoadError(error instanceof Error ? error.message : "Failed to load review settings"));
      // A recommendation already asked for must survive a reload, or the
      // operator pays for the same model call twice to see the same answer.
      api<LeadReviewDecision[]>("/api/lead-review-decisions").then((rows) => {
        const latest: Record<string, LeadReviewDecision> = {};
        for (const row of rows || []) {
          const held = latest[row.leadId];
          if (!held || String(row.createdAt || "") >= String(held.createdAt || "")) latest[row.leadId] = row;
        }
        setDecisions(latest);
      }).catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  // 2026-09-25 (cleanup pass) — there were four modes, but the server only
  // acts on one of them: "high_confidence_auto_approval" is the only mode that
  // approves anything by itself. "Agent recommends" and "Full automation" did
  // exactly what "you approve every lead" does (the AI recommendation button
  // works in every mode), and "Full automation" was labelled "Future mature
  // mode". Two honest choices remain. A workspace saved in one of the old
  // modes shows as the choice it actually behaves like; its saved value is not
  // rewritten until the owner picks.
  const autoMode = settings?.mode === "high_confidence_auto_approval";
  const barPercent = Number(threshold);
  const barValid = Number.isFinite(barPercent) && barPercent >= 50 && barPercent <= 100;
  const limitValid = /^\d+$/.test(dailyLimit.trim()) && Number(dailyLimit) <= 500;
  const savedBar = Number(settings?.autoApproveThreshold);
  const savedBarBroken = settings ? !(savedBar >= 0.5 && savedBar <= 1) : false;
  const saveSettings = (mode: string) => run("Save lead review settings", async () => setSettings(await api<Record<string, unknown>>("/api/lead-review/settings", { method: "PUT", body: { workspaceId, mode, autoApproveThreshold: barPercent / 100, maxAutoApprovedPerDay: Number(dailyLimit), allowAutoSend: false, auditEveryDecision: true } })));
  return (
    <div className="space-y-4">
      {bulkResult && (
        <div role="status" className="rounded-md border border-border-default bg-surface p-3 text-sm">
          <p>{bulkResult.leads.length} buyer{bulkResult.leads.length === 1 ? "" : "s"} {bulkResult.action}; {bulkResult.skipped.length} skipped.</p>
          {bulkResult.skipped.length > 0 && <ul className="mt-2 list-disc pl-4">{bulkResult.skipped.map((item) => <li key={item.leadId}>{leads.find((lead) => lead.id === item.leadId)?.companyName || "Buyer no longer available"}: {item.reason}</li>)}</ul>}
        </div>
      )}
      {settingsLoadError && (
        <div role="alert" className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg">
          <p className="font-semibold">Couldn't load your current review mode.</p>
          <p className="mt-1">{settingsLoadError} — the mode buttons below may not reflect your saved settings. Saving will overwrite them.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-default bg-surface px-4 py-3 text-sm">
        <span className="text-muted-2">
          {autoMode
            ? `Safe leads the AI is at least ${Math.round(savedBar * 100)}% sure of are approved automatically (up to ${String(settings?.maxAutoApprovedPerDay ?? dailyLimit)} a day).`
            : "You approve every lead yourself."}
        </span>
        <Button variant="secondary" icon={Settings} onClick={() => setSettingsOpen(true)}>Review settings</Button>
      </div>
      {!leads.length ? <Empty text="No prospects yet. Go to Discovery, add a manual lead, upload CSV, or run light discovery." /> : (
        <>
        {/* 2026-08-02 audit P2-4 — bulk action bar. Shows only when ≥1 lead is
            selected. The leads/bulk-approve + bulk-reject routes were orphaned
            (no UI) until now. */}
        {selectedIds.size > 0 && (
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-md border border-primary-bg bg-primary-bg px-4 py-2 text-sm">
            <span>{selectedIds.size} lead{selectedIds.size === 1 ? "" : "s"} selected</span>
            <div className="flex gap-2">
              <button className="btn text-xs py-1 px-2" onClick={() => setBulkAction("bulk-approve")}><Check className="h-3 w-3 mr-1" /> Approve selected</button>
              <button className="btn secondary text-xs py-1 px-2" onClick={() => setBulkAction("bulk-reject")}><X className="h-3 w-3 mr-1" /> Reject selected</button>
              <button className="btn secondary text-xs py-1 px-2" onClick={() => setSelectedIds(new Set())}>Clear</button>
            </div>
          </div>
        )}
        {/* F5 (2026-08-04 CONTINUOUS-2 audit): confirmation for bulk lead
            state changes. Approve → count confirm. Reject → count confirm +
            optional reason applied to all (D-2026-08-04-l). Matches the
            ConfirmModal pattern every other destructive multi-row action uses. */}
        <ConfirmModal
          open={bulkAction !== null}
          loading={bulkBusy}
          onClose={() => { setBulkAction(null); setBulkRejectReason(""); }}
          title={bulkAction === "bulk-approve" ? `Approve ${selectedIds.size} lead${selectedIds.size === 1 ? "" : "s"}?` : `Reject ${selectedIds.size} lead${selectedIds.size === 1 ? "" : "s"}?`}
          confirmLabel={bulkAction === "bulk-approve" ? "Approve" : "Reject"}
          tone={bulkAction === "bulk-reject" ? "danger" : "default"}
          onConfirm={() => { if (bulkAction) runBulk(bulkAction); }}
        >
          {bulkAction === "bulk-approve" ? (
            <>These leads will move to <strong>Approved</strong> and become eligible for outreach review.</>
          ) : (
            <div className="space-y-2">
              <p>These leads will be marked <strong>Rejected</strong>.</p>
              <textarea
                className="input w-full"
                rows={2}
                placeholder="Optional reason (applied to all)…"
                value={bulkRejectReason}
                onChange={(e) => setBulkRejectReason(e.target.value)}
                aria-label="Optional reason for rejecting these leads"
              />
            </div>
          )}
        </ConfirmModal>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            {reviewShowAll
              ? `Showing all ${leads.length} leads.`
              : `${leads.filter((l) => l.reviewStatus === "pending").length} pending review${leads.filter((l) => l.reviewStatus === "pending").length === 1 ? "" : "s"} (of ${leads.length} total).`}
          </p>
          <button className="btn secondary text-xs" onClick={() => setReviewShowAll((v) => !v)}>
            {reviewShowAll ? "Show pending only" : "Show all leads"}
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {(reviewShowAll ? leads : leads.filter((l) => l.reviewStatus === "pending")).length === 0 && (
            <Panel title="All caught up" icon={Check}>
              <p className="text-sm text-muted">No leads are waiting for review. New prospects from Discovery will appear here automatically.</p>
              {!reviewShowAll && <button className="btn secondary mt-3 text-xs" onClick={() => setReviewShowAll(true)}>Show all leads</button>}
            </Panel>
          )}
          {(reviewShowAll ? leads : leads.filter((l) => l.reviewStatus === "pending")).map((lead) => (
            <Panel key={lead.id} title={lead.companyName || "Unnamed prospect"} icon={ShieldCheck}>
              <div className="mb-2 flex items-center gap-2">
                {/* 2026-08-02 audit P2-4 — bulk-select checkbox (now the
                    Checkbox primitive for visual consistency with CRM). */}
                <Checkbox checked={selectedIds.has(lead.id)} onChange={() => toggleSelect(lead.id)} disabled={lead.doNotContact} className="mt-0.5" aria-label={`Select ${lead.companyName || "lead"} for bulk action`} />
                {/* 2026-09-25 — the AI's fit reason ran to 15+ lines on a narrow
                    card; the first lines carry the verdict, the rest is one
                    press away. */}
                <div className="flex-1">
                  <p className={`text-sm text-muted-2 ${expandedIds.has(lead.id) ? "" : "line-clamp-4"}`}>{lead.fitReason}</p>
                  {(lead.fitReason || "").length > 220 ? (
                    <button type="button" className="mt-1 text-xs font-semibold text-primary underline" onClick={() => toggleExpanded(lead.id)}>{expandedIds.has(lead.id) ? "Show less" : "Show more"}</button>
                  ) : null}
                </div>
              </div>
              {lead.doNotContact && <p className="mt-2 rounded-md bg-danger-bg p-2 text-sm text-danger-fg">Do not contact: outreach is blocked for this lead.</p>}
              {/* 2026-09-25 — the card showed two unrelated "confidence" numbers
                  (how sure discovery was of the details, and the AI's review
                  confidence) side by side, plus a status badge the Approve /
                  Reject buttons already state. The AI's score is shown instead. */}
              <Chips items={[lead.city, lead.country, displayLeadSource(lead.source), lead.buyerType].filter(Boolean) as string[]} />
              <div className="mt-3 flex flex-wrap gap-2">
                <LeadScoreChip lead={lead} />
                <EnrichmentBadge lead={lead} hideWhen="Contact found" />
              </div>
              {lead.enrichmentResult?.validationNote ? <p className="mt-2 rounded-md border border-border-default bg-surface p-2 text-xs text-muted-2">{lead.enrichmentResult.validationNote}</p> : null}
              {decisions[lead.id] ? (
                <div className="mt-3 rounded-md border border-border-default bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{decisions[lead.id].decision === "approve" ? "Agent says approve" : decisions[lead.id].decision === "reject" ? "Agent says reject" : "Agent says needs review"}</Badge>
                    <span className="text-xs text-muted">confidence {Math.round((decisions[lead.id].confidenceScore || 0) * 100)}%</span>
                  </div>
                  {decisions[lead.id].riskSignals?.length ? <p className="mt-2 text-xs text-danger-fg">Risks: {decisions[lead.id].riskSignals.join(" · ")}</p> : null}
                  {decisions[lead.id].suggestedNextStep ? <p className="mt-2 text-sm text-foreground">Next step: {decisions[lead.id].suggestedNextStep}</p> : null}
                  {/* The full reasoning and matched signals are kept, one press away. */}
                  <details className="mt-2 text-xs text-muted-2">
                    <summary className="cursor-pointer font-semibold text-primary-strong">Why?</summary>
                    <p className="mt-1 text-sm">{decisions[lead.id].reason}</p>
                    {decisions[lead.id].matchedSignals?.length ? <p className="mt-1">Matched: {decisions[lead.id].matchedSignals.join(" · ")}</p> : null}
                  </details>
                  <p className="mt-2 text-xs text-muted">This is a recommendation. Approving or rejecting is still yours.</p>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                {/* N-A11Y-11 — this card repeats once per lead, so the screen
                    offered fifteen buttons called "Agent recommendation",
                    fourteen called "Reject" and thirteen called "Approved",
                    none of which said which business they act on. The visible
                    labels stay short because the cards are narrow; the
                    accessible names carry the lead. */}
                <button className="btn secondary" onClick={async () => { const saved = await run("Agent lead recommendation", () => api<LeadReviewDecision>(`/api/leads/${lead.id}/review-decision`, { method: "POST", body: { workspaceId } })); if (saved?.id) setDecisions((prev) => ({ ...prev, [lead.id]: saved })); }} aria-label={`Ask the AI to recommend a decision for ${lead.companyName || "this prospect"}`}>{decisions[lead.id] ? "Ask again" : "Agent recommendation"}</button>
                <Button icon={Check} disabled={lead.doNotContact || lead.reviewStatus === "approved"} onClick={() => run("Approve lead", () => api(`/api/leads/${lead.id}/approve`, { method: "POST", body: { workspaceId } }))} aria-label={lead.reviewStatus === "approved" ? `${lead.companyName || "This prospect"} is already approved` : `Approve ${lead.companyName || "this prospect"} for outreach`}>{lead.reviewStatus === "approved" ? "Approved" : "Approve"}</Button>
                <Button variant="secondary" icon={X} disabled={lead.doNotContact || lead.reviewStatus === "rejected"} onClick={() => setRejectLeadId(lead.id)} aria-label={lead.reviewStatus === "rejected" ? `${lead.companyName || "This prospect"} is already rejected` : `Reject ${lead.companyName || "this prospect"}`}>{lead.reviewStatus === "rejected" ? "Rejected" : "Reject"}</Button>
              </div>
            </Panel>
          ))}
        </div>
        </>
      )}
      {/* Stage A+ / Cluster 10b (P2-16): reject-reason modal. Replaces the
          window.prompt() call. One modal instance for the whole list. */}
      <PromptModal
        open={rejectLeadId !== null}
        onClose={() => setRejectLeadId(null)}
        title="Reject this lead"
        label="Reason (optional)"
        placeholder="e.g. Out of target region, not in our ICP, etc."
        okLabel="Reject"
        onSubmit={(reason) => {
          const id = rejectLeadId;
          setRejectLeadId(null);
          if (id) {
            run("Reject lead", () => api(`/api/leads/${id}/reject`, { method: "POST", body: { workspaceId, ...(reason.trim() ? { reason: reason.trim() } : {}) } }));
          }
        }}
      />
      {/* 2026-09-25 (cleanup pass) — the settings panel sat under the leads
          and took half the screen on every visit. It is a once-in-a-while
          decision, so it lives behind "Review settings" at the top, which
          also states the current choice in one line. */}
      <Drawer open={settingsOpen} onOpenChange={setSettingsOpen} title="Lead review settings" description="Outreach is never sent automatically, whichever you choose." size="md">
        <DrawerBody>
          <div className="space-y-3">
            {([
              ["manual_review", "You approve every lead", "Nothing is approved without you. Use \u201cAsk the AI\u201d on a lead for a second opinion."],
              ["high_confidence_auto_approval", "Approve safe leads automatically", "Leads the AI has scored, with no warning signs, above your bar, are approved for you, up to your daily limit. Everything else waits for you."],
            ] as const).map(([mode, label, text]) => {
              const selected = mode === "high_confidence_auto_approval" ? autoMode : !autoMode;
              return (
                <button key={mode} type="button" aria-pressed={selected} className={`w-full rounded-md border p-3 text-left text-sm ${selected ? "border-primary-deep bg-surface-tint" : "border-border-default bg-surface"}`} onClick={() => { if (!barValid || !limitValid) return; saveSettings(mode); }}>
                  <strong className="text-foreground">{label}</strong>
                  <p className="mt-1 text-muted-2">{text}</p>
                </button>
              );
            })}
            {savedBarBroken ? (
              <p role="alert" className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">The saved bar is not a valid percentage, so no lead can be approved automatically. Set it below and save.</p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Approve automatically when the AI is at least (%) sure" value={threshold} onChange={setThreshold} />
              <Field label="At most this many a day" value={dailyLimit} onChange={setDailyLimit} />
            </div>
            {!barValid ? <p className="text-sm text-danger-fg">Enter a whole number from 50 to 100.</p> : null}
            {!limitValid ? <p className="text-sm text-danger-fg">Enter a whole number from 0 to 500.</p> : null}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button disabled={!barValid || !limitValid} onClick={() => saveSettings(autoMode ? "high_confidence_auto_approval" : "manual_review")}>Save review settings</Button>
        </DrawerFooter>
      </Drawer>
    </div>
  );
}

function CRM({ leads, initialLeadId, onReturnToAnalytics, followupRadar, mediaItems, run, onFocusLead, statusFilter, onStatusFilterChange, role = "owner" }: { leads: Lead[]; initialLeadId?: string; onReturnToAnalytics?: () => void; followupRadar: FollowupRadarResponse; mediaItems: MediaCatalogItem[]; run: Runner; onFocusLead?: (leadId: string, section: TabId) => void; statusFilter?: string; onStatusFilterChange?: (status: string) => void; role?: MinRole }) {
  const canEdit = role !== "viewer";
  const [addingCustomer, setAddingCustomer] = useState(false);
  // 2026-08-02 (UX redesign Phase 2): the expand-row pattern is replaced by a
  // slide-over Drawer — NN/g's top-ranked master-detail pattern. The drawer
  // keeps the leads list visible behind it so the operator can click the next
  // record without re-navigating, and adjacent rows stay available for
  // comparison. `drawerLeadId` replaces the old `activeRelevancy` toggle.
  const [drawerLeadId, setDrawerLeadId] = useState<string | null>(initialLeadId || null);
  const [customerDetailTab, setCustomerDetailTab] = useState("crm-customer");
  // 2026-08-05 UX audit (P1-5): the mobile card list hard-capped at 50, hiding
  // the rest of the pipeline with no "load more". Grow the visible window in
  // increments of 50 so a growing workspace stays fully reachable from a phone.
  const [mobileLimit, setMobileLimit] = useState(50);
  // Bulk-select state (NN/g "reveal checkboxes on selection" pattern). The
  // sticky bottom action bar appears only when ≥1 row is selected.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [autoSettings, setAutoSettings] = useState<Record<string, unknown> | null>(null);
  // 2026-09-09 (session 55): what the last AI scoring pass actually did. The
  // model pass is CAPPED, and a capped run that reports nothing is
  // indistinguishable from a complete one — the operator would believe the
  // whole pipeline had been looked at when a quarter of it had.
  const [aiScoreSummary, setAiScoreSummary] = useState("");
  const [agentContext, setAgentContext] = useState<AgentContextSummary | null>(null);
  const [agentPlans, setAgentPlans] = useState<Record<string, LeadAgentActionPlan>>({});
  const [timelines, setTimelines] = useState<Record<string, LeadActivityTimeline>>({});
  const [timelineErrors, setTimelineErrors] = useState<Record<string, string>>({});
  const [policyInputs, setPolicyInputs] = useState<Record<string, { title: string; clauses: string }>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (role === "owner") api<Record<string, unknown>>("/api/agent-autonomous/settings").then(setAutoSettings).catch((error) => console.error("Agent settings load failed:", error.message));
      api<AgentContextSummary>("/api/agent-context/summary").then(setAgentContext).catch((error) => console.error("Agent context load failed:", error.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [role]);

  useEffect(() => {
    if (!drawerLeadId || timelines[drawerLeadId] || timelineErrors[drawerLeadId] || !canReadWorkspacePath(role, "/api/activity")) return;
    let cancelled = false;
    api<LeadActivityTimeline>(`/api/activity/lead/${drawerLeadId}`)
      .then((timeline) => { if (!cancelled) setTimelines((prev) => ({ ...prev, [drawerLeadId]: timeline })); })
      .catch((e) => {
        if (!cancelled) setTimelineErrors((prev) => ({ ...prev, [drawerLeadId]: e instanceof Error ? e.message : "Could not load customer history." }));
      });
    return () => { cancelled = true; };
  }, [drawerLeadId, timelines, timelineErrors, role]);

  const isManualWhatsapp = autoSettings?.whatsappMode !== "automatic";

  // FIX #3 (2026-08-02 walkthrough): apply the Dashboard-driven status filter so
  // clicking "Approved: 13" lands on the CRM showing ONLY approved leads (the
  // number the owner just saw), not the whole unfiltered list. Empty filter =
  // show all. The filter chips below let the owner change/clear it in-place.
  // 2026-08-20 N-UX-7: the dashboard's pipeline bars now hand over a STAGE
  // ("stage:qualified"), because a stage covers several statuses and filtering
  // by only the first one showed the owner a shorter list than the bar they
  // clicked. Plain status values and "approved" (which is a review flag, not a
  // lifecycle status) still work, so nothing else that links here breaks.
  const filterLabel: Record<string, string> = {
    "": "All leads",
    approved: "Approved only",
    ...Object.fromEntries(PIPELINE_STAGES.map((s) => [`stage:${s.key}`, s.label])),
  };
  const filterMatches = (l: Lead) => {
    if (!statusFilter) return true;
    if (statusFilter === "approved") return l.reviewStatus === "approved";
    if (statusFilter.startsWith("stage:")) return statusesForStage(statusFilter.slice(6)).includes(l.status);
    return l.status === statusFilter;
  };
  // A filter can arrive from a headline card as a plain status ("hot_lead")
  // that has no chip of its own. Without this the list would be filtered while
  // every chip read inactive — the owner sees a short list and no reason for
  // it, which is the exact confusion the chip row exists to prevent.
  const describeFilter = (val: string) => filterLabel[val] ?? displayLabel(val);
  const unlistedFilter = statusFilter && !(statusFilter in filterLabel) ? statusFilter : "";
  const visibleLeads = statusFilter ? leads.filter(filterMatches) : leads;

  const drawerLead = drawerLeadId ? leads.find((l) => l.id === drawerLeadId) ?? null : null;
  const allVisibleSelected = visibleLeads.length > 0 && visibleLeads.every((l) => selectedIds.has(l.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        // Deselect only the visible ones.
        const next = new Set(prev);
        visibleLeads.forEach((l) => next.delete(l.id));
        return next;
      }
      const next = new Set(prev);
      visibleLeads.forEach((l) => next.add(l.id));
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {onReturnToAnalytics && <Button variant="secondary" onClick={onReturnToAnalytics}>Back to campaign results</Button>}
      {canEdit && <div className="flex justify-end"><Button icon={Plus} onClick={() => setAddingCustomer(true)}>Add customer</Button></div>}
      {addingCustomer && <Modal open title="Add customer" size="lg" onClose={() => setAddingCustomer(false)} disableDismiss>
        <ManualCustomerForm saveLabel="Save customer" onSave={values => run("Add customer", async () => {
          await api("/api/leads/manual", { method: "POST", body: { workspaceId, ...values, whatsappNumber: values.phone, source: "manual", fitReason: values.fitReason || "User-entered prospect for review." } });
          return true;
        })} onSaved={() => { setAddingCustomer(false); onStatusFilterChange?.(""); }} onCancel={() => setAddingCustomer(false)} />
      </Modal>}
      {followupRadar.count ? (
        <Panel title={`Follow-ups due (${followupRadar.count})`} icon={RefreshCw}>
          <div className="space-y-2">
            {followupRadar.leads.map((lead) => (
              <div key={lead.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface p-3 text-sm">
                <div>
                  <p className="font-semibold">{lead.companyName || "Unnamed prospect"}</p>
                  <p className="text-xs text-muted">Last contact: {lead.daysSinceContact} day{lead.daysSinceContact === 1 ? "" : "s"} ago</p>
                </div>
                <Button size="sm" variant="secondary" icon={Sparkles} disabled={role !== "owner"} onClick={() => run("Generate follow-up", () => api("/api/messages/generate", { method: "POST", body: { workspaceId, leadId: lead.id, campaignId: lead.campaignId, channel: "WhatsApp" } }))}>
                  Generate follow-up
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      <Panel title="Lead pipeline" icon={Layers3}>
        <p className="mb-3 text-sm text-muted-2">The score (out of 20) adds up four things: how well they fit, how much they need you, how easy they are to reach, and whether the timing is right. Higher is better.</p>

        {/* 2026-08-02 (UX redesign): active-filter chips (NN/g + Pencil & Paper
            pattern). The selected filter renders as a removable lozenge with a
            clear affordance; the unselected options remain as quick-toggle
            pills. A result count is always shown so the owner never guesses
            whether the filter is the reason for an empty list. */}
        {onStatusFilterChange ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted">Show:</span>
            {Object.entries(filterLabel).map(([val, label]) => {
              const active = (statusFilter ?? "") === val;
              return (
                <button
                  key={val || "all"}
                  type="button"
                  onClick={() => onStatusFilterChange(val)}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${active ? "bg-primary text-white" : "bg-surface-muted text-muted-2 hover:bg-surface-tint"}`}
                  aria-pressed={active}
                >
                  {label}
                  {active ? <X className="h-3 w-3" aria-hidden="true" /> : null}
                </button>
              );
            })}
            {unlistedFilter ? (
              <button
                type="button"
                onClick={() => onStatusFilterChange("")}
                className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
                aria-pressed={true}
              >
                {describeFilter(unlistedFilter)}
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
            <span className="ml-auto text-xs text-muted">{visibleLeads.length} of {leads.length} leads shown</span>
          </div>
        ) : null}

        {/* 2026-08-05 (UX Fix 3) — CRM table: desktop gets the full table;
            mobile gets a compact card list (no horizontal scroll on phones). */}
        {/* Desktop table (lg and up). */}
        <div className="hidden max-w-full overflow-x-auto rounded-lg border border-border-subtle lg:block">
          <table className="w-full min-w-[800px] text-sm">
            <thead>
              <tr className="border-b border-border-default bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
                {/* 2026-08-02 (UX redesign): sticky select-all checkbox column
                    (NN/g — Select All shortcut when whole-dataset actions are common). */}
                <th scope="col" className="w-10 px-4 py-3">
                  <Checkbox
                    checked={allVisibleSelected}
                    disabled={!canEdit}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible leads"
                  />
                </th>
                <th scope="col" className="px-4 py-3">Company</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3">Score <span className="font-normal normal-case">/{LEAD_SCORE_MAX}</span></th>
                <th scope="col" className="px-4 py-3">Contact</th>
                <th scope="col" className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleLeads.map((lead) => {
                const isSelected = selectedIds.has(lead.id);
                return (
                  <tr key={lead.id} className={`border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-muted/50 ${isSelected ? "bg-surface-tint/50" : ""}`}>
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={isSelected}
                        disabled={!canEdit}
                        onChange={() => toggleSelect(lead.id)}
                        aria-label={`Select ${lead.companyName || "this prospect"}`}
                      />
                    </td>
                    {/* Clickable company name → opens the slide-over Drawer. */}
                    <td className="px-4 py-3 font-medium">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-left font-medium text-foreground hover:text-primary"
                        onClick={() => { setCustomerDetailTab("crm-customer"); setDrawerLeadId(lead.id); }}
                        aria-label={`Show details for ${lead.companyName || "this prospect"}`}
                      >
                        {lead.companyName || "Unnamed prospect"}
                        <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={displayLeadStatusTone(lead.status)}>{displayLeadStatus(lead.status)}</Badge>
                        {/* 2026-09-25 — "Approved" is the normal state of a lead in
                            this list and was printed on 13 of 15 rows. The review
                            badge now appears only when it says something: rejected,
                            or still waiting for review. */}
                        {lead.reviewStatus !== "approved" && displayLeadStatus(lead.status).toLowerCase() !== (lead.reviewStatus === "rejected" ? "rejected" : "") && (
                          <Badge tone={lead.reviewStatus === "rejected" ? "danger" : "warning"}>{lead.reviewStatus === "rejected" ? "Rejected" : "Review needed"}</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <LeadScoreChip lead={lead} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <p className="text-foreground">{lead.whatsappNumber || lead.email || lead.phone || <span className="text-muted">Missing</span>}</p>
                        {/* "Contact found" under a visible contact repeated what the
                            line above already shows; only exceptions get a badge. */}
                        <EnrichmentBadge lead={lead} compact hideWhen="Contact found" />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {/* 2026-08-02 (UX redesign): row actions collapse into a
                          Dropdown "⋯" menu (NN/g + Pencil & Paper — reduces
                          column clutter; the most common action stays inline). */}
                      <div className="flex items-center justify-end gap-2">
                        {lead.reviewStatus === "approved" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={Mail}
                            onClick={() => onFocusLead?.(lead.id, "replies")}
                            aria-label={`Open replies from ${lead.companyName || lead.contactName || "this lead"}`}
                          >
                            Replies
                          </Button>
                        )}
                        <Dropdown
                          trigger={
                            <button
                              type="button"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-default bg-surface text-muted hover:bg-surface-muted hover:text-foreground"
                              aria-label={`More actions for ${lead.companyName || "this prospect"}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          }
                        >
                          <DropdownItem icon={Eye} onSelect={() => { setCustomerDetailTab("crm-customer"); setDrawerLeadId(lead.id); }}>View details</DropdownItem>
                          {lead.reviewStatus === "approved" && lead.enrichmentStatus === "not_started" ? (
                            <DropdownItem disabled={!canEdit} icon={Search} onSelect={() => run("Enrich lead", () => api(`/api/leads/${lead.id}/enrich`, { method: "POST", body: { workspaceId } }))}>
                              Enrich contact
                            </DropdownItem>
                          ) : null}
                          {isManualWhatsapp && lead.reviewStatus === "approved" && (
                            <DropdownItem disabled={role !== "owner"} icon={MessageCircle} onSelect={() => run("Generate WhatsApp message", () => api("/api/messages/generate", { method: "POST", body: { workspaceId, leadId: lead.id, campaignId: lead.campaignId, channel: "WhatsApp" } }))}>
                              Draft message
                            </DropdownItem>
                          )}
                          {lead.reviewStatus === "approved" && onFocusLead && (
                            <>
                              <DropdownSeparator />
                              <DropdownItem icon={ShoppingBag} onSelect={() => onFocusLead(lead.id, "commercial")}>
                                Quotes &amp; orders
                              </DropdownItem>
                              <DropdownItem icon={TicketIcon} onSelect={() => onFocusLead(lead.id, "tickets")}>
                                Support tickets
                              </DropdownItem>
                            </>
                          )}
                        </Dropdown>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visibleLeads.length && <Empty text={statusFilter ? `No leads match "${describeFilter(statusFilter)}". Click another filter above.` : "No leads found."} />}
        </div>

        {/* 2026-08-05 (UX Fix 3) — mobile card list (lg:hidden). Compact
            tappable cards instead of a horizontal-scroll table on phones. */}
        <div className="space-y-2 lg:hidden">
          {visibleLeads.length === 0 && <Empty text="No leads found." />}
          {visibleLeads.slice(0, mobileLimit).map((lead) => {
            const isSelected = selectedIds.has(lead.id);
            // 2026-08-05 (audit U-6): the card printed "No contact name" even
            // when a phone or email existed, because it only ever read
            // contactName. Fall back the same way the desktop CONTACT column
            // does — a name is nicest, a reachable phone/email is still real
            // contact info and better than a false "no contact" claim.
            const contactLine = lead.contactName || lead.phone || lead.whatsappNumber || lead.email || "No contact info";
            return (
              <div
                key={lead.id}
                className={`rounded-lg border p-3 ${isSelected ? "border-primary bg-surface-tint" : "border-border-default bg-surface"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <button className="text-sm font-semibold text-foreground hover:text-primary" onClick={() => { setCustomerDetailTab("crm-customer"); setDrawerLeadId(lead.id); }}>
                      {lead.companyName || lead.contactName || "Unnamed prospect"}
                    </button>
                    <p className="truncate text-xs text-muted">{contactLine}</p>
                  </div>
                  <Badge className="shrink-0" tone={displayLeadStatusTone(lead.status)}>{displayLeadStatus(lead.status)}</Badge>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted">
                  <span>{lead.city || "—"}</span>
                  <span>·</span>
                  <span>{lead.buyerType || "—"}</span>
                  <span>·</span>
                  <span className="font-medium">Score: {leadScoreText(lead)}</span>
                </div>
                {/* 2026-08-05 (audit U-5): mobile cards had NO actions at all —
                    a phone was read-only. Mirror the desktop row's primary
                    action (Replies) + the same "more" menu, sized for touch. */}
                <div className="mt-3 flex items-center gap-2 border-t border-border-default pt-2">
                  {lead.reviewStatus === "approved" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Mail}
                      className="flex-1"
                      onClick={() => onFocusLead?.(lead.id, "replies")}
                      aria-label={`Open replies from ${lead.companyName || lead.contactName || "this lead"}`}
                    >
                      Replies
                    </Button>
                  )}
                  <Dropdown
                    trigger={
                      <button
                        type="button"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-default bg-surface text-muted hover:bg-surface-muted hover:text-foreground"
                        aria-label={`More actions for ${lead.companyName || "this prospect"}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    }
                  >
                    <DropdownItem icon={Eye} onSelect={() => { setCustomerDetailTab("crm-customer"); setDrawerLeadId(lead.id); }}>View details</DropdownItem>
                    {lead.reviewStatus === "approved" && lead.enrichmentStatus === "not_started" ? (
                      <DropdownItem disabled={!canEdit} icon={Search} onSelect={() => run("Enrich lead", () => api(`/api/leads/${lead.id}/enrich`, { method: "POST", body: { workspaceId } }))}>
                        Enrich contact
                      </DropdownItem>
                    ) : null}
                    {isManualWhatsapp && lead.reviewStatus === "approved" && (
                      <DropdownItem disabled={role !== "owner"} icon={MessageCircle} onSelect={() => run("Generate WhatsApp message", () => api("/api/messages/generate", { method: "POST", body: { workspaceId, leadId: lead.id, campaignId: lead.campaignId, channel: "WhatsApp" } }))}>
                        Draft message
                      </DropdownItem>
                    )}
                    {lead.reviewStatus === "approved" && onFocusLead && (
                      <>
                        <DropdownSeparator />
                        <DropdownItem icon={ShoppingBag} onSelect={() => onFocusLead(lead.id, "commercial")}>
                          Quotes &amp; orders
                        </DropdownItem>
                        <DropdownItem icon={TicketIcon} onSelect={() => onFocusLead(lead.id, "tickets")}>
                          Support tickets
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                </div>
              </div>
            );
          })}
          {visibleLeads.length > mobileLimit && (
            <button className="btn secondary w-full text-sm" onClick={() => setMobileLimit((n) => n + 50)}>
              Show 50 more ({visibleLeads.length - mobileLimit} hidden)
            </button>
          )}
        </div>

        {/* 2026-08-02 (UX redesign): sticky bulk-action bar appears only when
            rows are selected (Pencil & Paper pattern). Shows the count + a
            clear-selection affordance so the operator always knows the scope. */}
        {selectedIds.size > 0 && (
          <div className="sticky bottom-4 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-default bg-foreground px-4 py-2.5 text-surface shadow-xl">
            <span className="text-sm font-semibold">{selectedIds.size} selected</span>
            <span className="text-xs opacity-70">of {visibleLeads.length} shown</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={Search} disabled={!canEdit} onClick={() => {
                const count = selectedIds.size;
                run(`Enrich ${count} selected lead${count === 1 ? "" : "s"}`, async () => {
                  // F11 (2026-08-04 CONTINUOUS-2 audit): each enrich is a real
                  // LLM call that costs tokens. Previously per-lead failures
                  // were swallowed (.catch(() => undefined)) and the wrapping
                  // run() always fired a GREEN "completed" toast — the operator
                  // had no idea 5 of 30 didn't enrich. Collect per-lead results;
                  // on any failure throw a synthetic error so run() shows a
                  // danger toast naming the count that failed (run() catches
                  // + renders it sticky).
                  const ids = Array.from(selectedIds);
                  const results = await Promise.allSettled(
                    ids.map((id) => api(`/api/leads/${id}/enrich`, { method: "POST", body: { workspaceId } })),
                  );
                  const failed = results.filter((r) => r.status === "rejected").length;
                  if (failed > 0) {
                    throw new Error(`${failed} of ${ids.length} lead${ids.length === 1 ? "" : "s"} failed to enrich. ${ids.length - failed} succeeded — check the list and retry the failed ones.`);
                  }
                });
              }}>
                Enrich selected
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 flex gap-3 border-t border-border-default pt-4">
          <Button icon={Search} disabled={!canEdit} onClick={() => run("Enrich approved leads", async () => {
            // F11 (2026-08-07, docs/OPEN-ISSUES.md narrowed finding): the
            // service already returns { failed, failures } — this button was
            // the one caller that never inspected it, so a partial failure
            // still showed a green "completed" toast. Mirror the "Enrich
            // selected" button's fix above.
            const result = await api<{ failed: number; processed: number; enriched: number }>("/api/leads/enrich-approved", { method: "POST", body: { workspaceId } });
            if (result?.failed > 0) {
              throw new Error(`${result.failed} of ${result.processed} lead${result.processed === 1 ? "" : "s"} failed to enrich. ${result.enriched} succeeded — check the list and retry the failed ones.`);
            }
            return result;
          })}>Enrich approved only</Button>
          {/* 2026-09-25 (CEO: lead scoring is AI only). "Score all" ran the
              quick built-in rules and sat beside "Ask the AI to score them";
              the rules are gone, so the two buttons are one. It scores up to
              five leads the AI has not scored yet, per press. */}
          <Button variant="secondary" icon={Sparkles} disabled={!canEdit} onClick={async () => {
            const result = await run("Score with AI", () => api<{ aiScored: number; stillWaiting: number; limit: number; stoppedReason?: string }>(
              "/api/leads/bulk-score", { method: "POST", body: { workspaceId } },
            ));
            if (!result) return;
            setAiScoreSummary(
              result.stoppedReason && result.aiScored === 0
                ? `The AI could not score any leads right now: ${result.stoppedReason} Nothing was changed.`
                : `The AI scored ${result.aiScored} lead${result.aiScored === 1 ? "" : "s"}.` +
                  (result.stoppedReason ? ` It then stopped: ${result.stoppedReason}` : "") +
                  (result.stillWaiting > 0 ? ` ${result.stillWaiting} still waiting — press again to score the next ${Math.min(result.limit, result.stillWaiting)}.` : " Every lead now has the AI's score."),
            );
          }}>Score with AI</Button>
        </div>
        {aiScoreSummary && <p className="mt-3 text-xs text-fg">{aiScoreSummary}</p>}
        <p className="mt-3 text-xs text-muted">Enrichment means finding more useful information about approved leads. Rejected, invalid, duplicate, and do-not-contact leads are blocked from the pipeline. &ldquo;Score with AI&rdquo; has the AI read each lead it has not scored yet (a small AI cost per lead); leads it has already scored are left as they are.</p>
      </Panel>

      {/* 2026-08-02 (UX redesign Phase 2): the slide-over Drawer replaces the
          inline expand-row. The rich detail content (company snapshot, AI
          relevancy, activity timeline, agent plan, policy) moves into the
          DrawerBody verbatim — no logic change, just a better container. */}
      {drawerLead && (
        <Drawer
          open={drawerLeadId !== null}
          onOpenChange={(o) => { if (!o) setDrawerLeadId(null); }}
          title={drawerLead.companyName || "Unnamed prospect"}
          description={drawerLead.industry ? `${drawerLead.industry}${drawerLead.buyerType ? ` · ${drawerLead.buyerType}` : ""}` : "Lead detail"}
          size="xl"
        >
          <DrawerBody>
            <div className="space-y-4">
              {onReturnToAnalytics && <Button variant="secondary" onClick={onReturnToAnalytics}>Back to campaign results</Button>}
              {/* Header row: score + status + contact, so the operator sees the
                  headline identity before scrolling into the detail blocks. */}
              <div className="flex flex-wrap items-center gap-2">
                <LeadScoreChip lead={drawerLead} />
                <Badge>{displayLeadStatus(drawerLead.status)}</Badge>
                {drawerLead.reviewStatus === "approved" ? <Badge tone="success">Approved</Badge> : drawerLead.reviewStatus === "rejected" ? <Badge tone="danger">Rejected</Badge> : <Badge tone="warning">Review needed</Badge>}
              </div>

              {/* Company snapshot — the human facts come BEFORE the AI opinion. */}
              <Tabs tabs={[
                { id: "crm-customer", label: "Customer" },
                ...(canReadWorkspacePath(role, "/api/activity") ? [{ id: "crm-history", label: "History" }] : []),
                { id: "crm-guidance", label: "AI guidance" },
                { id: "crm-documents", label: "Documents" },
              ]} activeTab={customerDetailTab} onSelect={setCustomerDetailTab} />
              <TabPanel tabId="crm-customer" hidden={customerDetailTab !== "crm-customer"}>
              <div className="rounded-lg border border-border-default bg-surface p-4">
                <p className="mb-3 font-semibold text-xs uppercase tracking-wide text-primary">Company snapshot</p>
                <div className="grid grid-cols-1 gap-x-4 gap-y-2 break-words text-sm sm:grid-cols-2 md:grid-cols-3">
                  <div><span className="text-muted">Company:</span> <span className="font-medium">{drawerLead.companyName || "Unnamed prospect"}</span></div>
                  <div><span className="text-muted">Industry:</span> <span className="font-medium">{drawerLead.industry || "—"}</span></div>
                  <div><span className="text-muted">Buyer type:</span> <span className="font-medium">{drawerLead.buyerType || "—"}</span></div>
                  <div><span className="text-muted">Location:</span> <span className="font-medium">{[drawerLead.city, drawerLead.country].filter(Boolean).join(", ") || "—"}</span></div>
                  <div><span className="text-muted">Company size:</span> <span className="font-medium">{drawerLead.companySizeBucket || "—"}</span></div>
                  <div><span className="text-muted">Website:</span> {drawerLead.websiteUrl ? <a href={drawerLead.websiteUrl} target="_blank" rel="noreferrer" className="font-medium text-primary underline hover:text-primary-strong">{drawerLead.websiteUrl.replace(/^https?:\/\//, "").slice(0, 30)}</a> : <span className="text-muted">—</span>}</div>
                  <div><span className="text-muted">Email:</span> <span className="font-medium">{drawerLead.email || "Missing"}</span></div>
                  <div><span className="text-muted">Phone:</span> <span className="font-medium">{drawerLead.phone || "Missing"}</span></div>
                  <div><span className="text-muted">WhatsApp:</span> <span className="font-medium">{drawerLead.whatsappNumber || "—"}</span></div>
                </div>
                {drawerLead.personalizationNote ? (
                  <p className="mt-3 text-sm text-muted"><span className="font-semibold text-foreground">Outreach angle:</span> {drawerLead.personalizationNote}</p>
                ) : null}
              </div>

              {/* N11 (2026-09-19) — what this customer has told us about
                  THEMSELVES, as opposed to what the web research guessed about
                  them. Read-only on purpose: the system only writes down what
                  the customer volunteered, and asking questions is a separate
                  half that is not switched on. This panel is the precondition
                  for switching it on — the owner has to be able to read what
                  the listening caught, and say "that is wrong", before a
                  question goes in front of a real buyer. */}
              <WhatTheBuyerToldUs lead={drawerLead} readOnly={!canEdit} />
              </TabPanel>
              {canReadWorkspacePath(role, "/api/activity") ? (
                <TabPanel tabId="crm-history" hidden={customerDetailTab !== "crm-history"}>
                  {timelineErrors[drawerLead.id] ? <div role="alert" className="space-y-2 text-sm">
                    <p className="text-danger-fg">Could not load customer history: {timelineErrors[drawerLead.id]}</p>
                    <Button variant="secondary" onClick={() => setTimelineErrors(prev => { const next = { ...prev }; delete next[drawerLead.id]; return next; })}>Try history again</Button>
                  </div> : <ActivityTimeline timeline={timelines[drawerLead.id]} />}
                </TabPanel>
              ) : null}
              <TabPanel tabId="crm-guidance" hidden={customerDetailTab !== "crm-guidance"}>

              {/* AI relevancy analysis — collapsible reasoning (research: the
                  AI's reasoning should be available but not dominant). */}
              <details className="rounded-lg border border-border-default bg-surface p-4" open>
                <summary className="cursor-pointer font-semibold text-xs uppercase tracking-wide text-primary">AI relevancy analysis</summary>
                <div className="mt-3 space-y-3">
                  {/* 2026-09-09 (session 55): this used to fall back to an
                      INVENTED paragraph - "The agent detected patterns
                      suggesting they are currently sourcing products like
                      yours" - for any lead with no reason text. No agent had
                      detected anything. A panel headed "AI relevancy analysis"
                      must not manufacture the analysis. */}
                  {drawerLead.relevancyReason || drawerLead.fitReason ? (
                    <p className="text-muted leading-relaxed">{drawerLead.relevancyReason || drawerLead.fitReason}</p>
                  ) : (
                    <p className="text-muted leading-relaxed">No analysis yet. Ask the AI to score this lead and it will say why this company does or does not fit.</p>
                  )}
                  {(() => {
                    // Whether a score came from the model or from the simple
                    // rules is the operator's business: the two are not the
                    // same claim, and only one of them is "the AI looked".
                    // 2026-09-25: scoring is AI only — the "simple rules" badge is gone.
                    const reason = drawerLead.scoreReason as { provider?: string; reason?: string } | undefined;
                    const fromModel = isAiScored(drawerLead);
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={fromModel ? "success" : "warning"}>
                          {fromModel ? `Scored by the AI${reason?.provider ? ` (${displayLabel(reason.provider)})` : ""}` : "Not scored by the AI yet"}
                        </Badge>
                        <Button size="sm" variant="secondary" icon={Zap} disabled={!canEdit} onClick={() => run("Score with AI", async () => {
                          const result = await api<{ aiScored?: boolean; scoreMessage?: string }>(`/api/leads/${drawerLead.id}/score`, { method: "POST", body: { workspaceId } });
                          if (result.aiScored === false) throw new Error(result.scoreMessage || "The AI could not score this lead right now. Nothing was changed.");
                          return result;
                        })}>
                          {fromModel ? "Ask the AI to score this again" : "Score with AI"}
                        </Button>
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    <div><strong className="text-muted">Source:</strong> {drawerLead.sourceUrl ? <a href={drawerLead.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline hover:text-primary-strong">{displayLeadSource(drawerLead.source)}</a> : displayLeadSource(drawerLead.source)}</div>
                    <div><strong className="text-muted">Score breakdown:</strong> {(() => {
                      const f = drawerLead.fitScore;
                      const n = drawerLead.needScore;
                      const r = drawerLead.reachabilityScore;
                      const t = drawerLead.timingScore;
                      if (f == null && n == null && r == null && t == null) {
                        return <span className="text-muted">Not scored yet</span>;
                      }
                      const parts = [`F: ${f ?? "-"}`, `N: ${n ?? "-"}`, `R: ${r ?? "-"}`, `T: ${t ?? "-"}`];
                      const numeric = [f, n, r, t].filter((v): v is number => typeof v === "number");
                      const total = numeric.length === 4 ? numeric.reduce((a, b) => a + b, 0) : null;
                      return <span>{parts.join(", ")}{total != null ? ` (total ${total})` : ""}</span>;
                    })()}</div>
                  </div>
                  {drawerLead.enrichmentResult?.validationNote ? (
                    <div className={`rounded-md border p-3 text-sm ${drawerLead.enrichmentResult.status === "ambiguous" ? "border-warning-bg bg-warning-bg text-warning-fg" : "border-border-default bg-surface-muted text-muted"}`}>
                      <p className="font-semibold">{drawerLead.enrichmentResult.status === "ambiguous" ? "Multiple companies found. Verify manually." : "Enrichment result"}</p>
                      <p className="mt-1">{drawerLead.enrichmentResult.validationNote}</p>
                      {drawerLead.enrichmentResult.matchedSource ? <p className="mt-1 text-xs">Source: {drawerLead.enrichmentResult.matchedSource}</p> : null}
                    </div>
                  ) : null}
                </div>
              </details>

              {agentContext ? <CRMRecordAgentContextPanel context={agentContext} /> : null}

              <div className="rounded-lg border border-border-default bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-foreground">Suggested next step</p>
                    <p className="text-xs text-muted">The AI suggests what to do next with this customer and drafts a message for you to check. Nothing is sent.</p>
                  </div>
                  <Button size="sm" icon={Sparkles} disabled={!canEdit} onClick={async () => {
                    const plan = await run("Create lead agent plan", () => api<LeadAgentActionPlan>(`/api/leads/${drawerLead.id}/agent-action-plan`, { method: "POST", body: { workspaceId } }));
                    if (plan) setAgentPlans((prev) => ({ ...prev, [drawerLead.id]: plan }));
                  }}>
                    Suggest a next step
                  </Button>
                </div>
                {agentPlans[drawerLead.id] ? <LeadAgentActionPlanPanel plan={agentPlans[drawerLead.id]} /> : (
                  <p className="mt-2 text-xs text-muted">No suggestion yet.</p>
                )}
              </div>
              </TabPanel>
              <TabPanel tabId="crm-documents" hidden={customerDetailTab !== "crm-documents"}>
              {/* 2026-09-29 (owner walk-through C1): the policy PDF tool used to be the
                  FIRST thing in a customer's panel. An owner opens a customer to see
                  who they are and what they said; the tool now sits at the end. */}
              {(() => {
                const policyInput = policyInputs[drawerLead.id] || { title: "Customer Policy Summary", clauses: "" };
                const leadPolicies = mediaItems.filter((item) => item.category === "policy_document" && item.leadId === drawerLead.id);
                return (
                  <div className="rounded-lg border border-border-default bg-surface p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-foreground">Policy PDF</p>
                        <p className="text-xs text-muted">Generate a customer-ready draft from this lead and your saved policy settings.</p>
                      </div>
                      <Button size="sm" icon={FileText} disabled={!canEdit} onClick={() => run("Generate policy PDF", () => api(`/api/leads/${drawerLead.id}/generate-policy`, { method: "POST", body: { workspaceId, title: policyInput.title, customClauses: policyInput.clauses } }))}>
                        Generate PDF
                      </Button>
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      {/* N-A11Y-13 — the title box had no label, no placeholder
                          and no accessible name: it announced as "edit text",
                          and a sighted operator saw a filled box with no
                          indication of what it controls. It arrives prefilled
                          with "Customer Policy Summary", so the only clue was
                          the value itself — which disappears the moment anyone
                          clears it. */}
                      <input
                        className="input"
                        aria-label="Title for the policy PDF"
                        placeholder="Title for the policy PDF"
                        value={policyInput.title}
                        onChange={(event) => setPolicyInputs((current) => ({ ...current, [drawerLead.id]: { ...policyInput, title: event.target.value } }))}
                      />
                      <input
                        className="input"
                        aria-label="Extra clause to include in the policy PDF"
                        placeholder="Extra note, payment term, or clause"
                        value={policyInput.clauses}
                        onChange={(event) => setPolicyInputs((current) => ({ ...current, [drawerLead.id]: { ...policyInput, clauses: event.target.value } }))}
                      />
                    </div>
                    {leadPolicies.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {leadPolicies.map((item) => (
                          <a key={item.id} className="inline-flex items-center gap-1 rounded-full border border-success-bg bg-surface-tint px-3 py-1 text-xs font-semibold text-primary" href={item.url} target="_blank" rel="noreferrer">
                            <Download className="h-3 w-3" /> {item.title}
                          </a>
                        ))}
                      </div>
                    ) : <p className="mt-2 text-xs text-muted">No generated policy PDF for this lead yet.</p>}
                  </div>
                );
              })()}
              </TabPanel>
            </div>
          </DrawerBody>

          {/* Sticky footer with the cross-record drill actions (Everything
              Connected). These are the highest-frequency follow-ups, so they
              stay pinned regardless of scroll position in the body. */}
          {drawerLead.reviewStatus === "approved" && onFocusLead && (
            <DrawerFooter>
              <Button variant="secondary" icon={Sparkles} disabled={role !== "owner"} onClick={() => { onFocusLead(drawerLead.id, "commandCenter"); setDrawerLeadId(null); }}>Ask the assistant</Button>
              <Button variant="secondary" icon={MessageCircle} onClick={() => { onFocusLead(drawerLead.id, "replies"); setDrawerLeadId(null); }}>View replies</Button>
              <Button variant="secondary" icon={ShoppingBag} onClick={() => { onFocusLead(drawerLead.id, "commercial"); setDrawerLeadId(null); }}>Quotes &amp; orders</Button>
              <Button variant="secondary" icon={TicketIcon} onClick={() => { onFocusLead(drawerLead.id, "tickets"); setDrawerLeadId(null); }}>Tickets</Button>
            </DrawerFooter>
          )}
        </Drawer>
      )}
    </div>
  );
}

/**
 * N-BUG (2026-09-08). The wording moved to src/lib/enrichment-label.ts so the
 * claim can be pinned by a golden — see that file's header for the defect: the
 * one enriched lead on the live pipeline, holding a phone number and an email
 * and carrying an approved draft, read "Contact missing".
 */
function EnrichmentBadge({ lead, compact = false, hideWhen }: { lead: Lead; compact?: boolean; hideWhen?: string }) {
  const label = enrichmentLabel(
    {
      result: lead.enrichmentResult?.status as EnrichmentLookupStatus,
      jobStatus: lead.enrichmentStatus,
      contactReady: Boolean(lead.email || lead.phone || lead.whatsappNumber),
    },
    compact,
  );
  if (hideWhen && label === hideWhen) return null;
  return <Badge>{label}</Badge>;
}

function ActivityTimeline({ timeline }: { timeline?: LeadActivityTimeline }) {
  return (
    <div className="mt-3 rounded-md border border-border-default bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-foreground">Activity Timeline</p>
        <Badge>{timeline ? `${timeline.events.length} events` : "Loading"}</Badge>
      </div>
      {!timeline ? <div className="mt-2 space-y-1"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-5/6" /></div> : timeline.events.length ? (
        <div className="mt-3 space-y-2">
          {timeline.events.map((event, index) => (
            <div key={`${event.happenedAt}-${index}`} className="grid gap-1 border-l-2 border-success-bg pl-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-foreground">{event.label}</p>
                <p className="text-xs text-muted">{formatDate(event.happenedAt)}</p>
              </div>
              {event.detail ? <p className="text-xs text-muted">{event.detail}</p> : null}
            </div>
          ))}
        </div>
      ) : <p className="mt-2 text-xs text-muted">No activity recorded yet.</p>}
    </div>
  );
}


function CRMRecordAgentContextPanel({ context }: { context: AgentContextSummary }) {
  const readyCount = [context.profileReady, context.salesReady, context.productsReady, context.policyReady, context.communicationReady, context.syncedKnowledgeReady].filter(Boolean).length;
  return (
    <div className="mt-3 rounded-md border border-border-default bg-surface p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-foreground">What the AI checks first</p>
        <Badge>{readyCount} of 6 ready</Badge>
      </div>
      <p className="mt-1 text-muted-2">Your company profile, sales rules, products, policies, how you talk to customers, and your approved answers.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge>{context.answerCount} synced answers</Badge>
        <Badge>{context.chunkCount} searchable chunks</Badge>
        <Badge>{context.conflictsPending ? `${context.conflictsPending} conflicts pending` : "No open conflicts"}</Badge>
        <Badge>{context.lastSyncedAt ? `Synced ${formatDate(context.lastSyncedAt)}` : "Not synced yet"}</Badge>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <ContextPreview label="Sales rules" value={context.preview.sales} ready={context.salesReady} />
        <ContextPreview label="Products" value={context.preview.products} ready={context.productsReady} />
        <ContextPreview label="Policies" value={context.preview.policy} ready={context.policyReady} />
        <ContextPreview label="Communication" value={context.preview.communication} ready={context.communicationReady} />
      </div>
    </div>
  );
}

function LeadAgentActionPlanPanel({ plan }: { plan: LeadAgentActionPlan }) {
  const statusLabel = plan.modelStatus.mode === "real"
    ? "AI draft"
    : plan.modelStatus.mode === "fallback"
      ? "AI draft (backup)"
      : "Sample draft";
  return (
    <div className="mt-3 space-y-3 text-xs">
      <div className="flex flex-wrap gap-2">
        <Badge>{statusLabel}</Badge>
        <Badge>{plan.humanReviewRequired ? "Human review required" : "Review optional"}</Badge>
      </div>
      <div className="rounded border border-border-subtle bg-surface p-3">
        <p className="font-semibold text-foreground">{plan.recommendation}</p>
        <p className="mt-1 text-muted">Confidence {Math.round(plan.confidenceScore * 100)}%. {plan.safetyNote}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <PlanList title="Why the agent recommends this" items={plan.reasons} />
        <PlanList title="Next CRM steps" items={plan.nextSteps} />
      </div>
      {plan.missingInformation.length ? <PlanList title="Information still needed" items={plan.missingInformation} /> : null}
      {plan.draftMessage ? (
        <div>
          <p className="font-semibold text-foreground">Reviewed outreach draft</p>
          <p className="mt-1 whitespace-pre-wrap rounded border border-border-subtle bg-surface p-3 text-muted-2">{plan.draftMessage}</p>
        </div>
      ) : null}
      {plan.modelStatus.warning ? <p className="rounded-md bg-warning-bg p-2 text-warning-fg">AI note: {plan.modelStatus.warning}</p> : null}
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="font-semibold text-foreground">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-2">
        {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function ContextPreview({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="rounded border border-border-subtle bg-surface p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-foreground">{label}</p>
        <Badge>{ready ? "Ready" : "Not set"}</Badge>
      </div>
      <p className="mt-1 text-muted">{value}</p>
    </div>
  );
}

/**
 * 2026-09-25 (cleanup pass) — Messages was two overlapping lists: an "Outreach
 * Queue" of drafts waiting for approval, and below it a card for EVERY message,
 * approved and sent ones included, each still carrying an "Approve" button. On
 * the demo the queue said "0 drafts waiting" directly above an approved message
 * offering to be approved. Now one list, split by what the owner does next:
 * approve it, send it, or nothing (already sent). Each state shows only the
 * buttons that make sense for it. Drafting a new message stays below.
 */
type MessageStage = "waiting" | "ready" | "sent";
const MESSAGE_STAGE_OF: Record<string, MessageStage | undefined> = { draft: "waiting", approved: "ready", used: "sent" };

function Messages({ leads, messages, campaign, run }: { leads: Lead[]; messages: MessageTemplate[]; campaign?: Campaign; run: Runner }) {
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const byStage: Record<MessageStage, MessageTemplate[]> = { waiting: [], ready: [], sent: [] };
  for (const message of messages) {
    const stage = MESSAGE_STAGE_OF[message.status];
    if (stage) byStage[stage].push(message);
  }
  const score = (m: MessageTemplate) => leadById.get(m.leadId || "")?.leadScore || 0;
  byStage.waiting.sort((a, b) => score(b) - score(a) || b.createdAt.localeCompare(a.createdAt));
  byStage.ready.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  byStage.sent.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  // Until the owner picks a tab, open the first one with something in it —
  // messages load after the screen does, so this cannot be decided once.
  const [picked, setStage] = useState<MessageStage | null>(null);
  const stage: MessageStage = picked ?? (byStage.waiting.length ? "waiting" : byStage.ready.length ? "ready" : byStage.sent.length ? "sent" : "waiting");
  const approved = leads
    .filter((lead) => lead.reviewStatus === "approved")
    .slice()
    .sort((a, b) => (a.companyName || "").localeCompare(b.companyName || ""));
  const shown = byStage[stage];

  return (
    <div className="space-y-4">
      <Panel title="All messages" icon={Inbox}>
        <Tabs
          activeTab={stage}
          onSelect={(id) => setStage(id as MessageStage)}
          tabs={[
            { id: "waiting", label: "Needs your OK", count: byStage.waiting.length },
            { id: "ready", label: "Ready to send", count: byStage.ready.length },
            { id: "sent", label: "Sent", count: byStage.sent.length },
          ]}
        />
        <div role="tabpanel" id={`tabpanel-${stage}`} aria-labelledby={`tab-${stage}`} className="pt-4">
          {shown.length ? (
            <div className="space-y-3">
              {shown.map((message) => {
                const lead = leadById.get(message.leadId || "");
                const outreachBlocked = !lead || lead.reviewStatus !== "approved" || lead.doNotContact || ["do_not_contact", "rejected", "invalid", "duplicate", "not_interested"].includes(lead.status);
                const unverified = lead?.enrichmentResult?.status === "ambiguous";
                const notEnriched = lead && !lead.enrichmentResult;
                return (
                  <div key={message.id} className="rounded-lg border border-border-default bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{lead?.companyName || "No lead linked"}</span>
                      {lead ? <LeadScoreChip lead={lead} /> : null}
                      <span className="text-xs text-muted">{message.channel} · written {formatDate(message.createdAt).split(",")[0]}</span>
                    </div>
                    <MessageGenerationStatus message={message} />
                    {outreachBlocked && stage !== "sent" && <p className="mt-2 text-sm text-danger-fg">Outreach blocked for this buyer. This message is kept for your records.</p>}
                    {unverified ? (
                      <p className="mt-2 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg">Contact details not verified. Message kept general — confirm the recipient before sending.</p>
                    ) : null}
                    <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm leading-relaxed text-foreground">
                      {message.subject ? <><span className="font-semibold">Subject:</span> {message.subject}<br /><br /></> : null}
                      {message.body}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="btn secondary" disabled={outreachBlocked && stage !== "sent"} onClick={() => copyToClipboard(message.body)}><Clipboard className="h-4 w-4" /> Copy</button>
                      {stage === "waiting" && notEnriched && lead ? (
                        <Button variant="secondary" onClick={() => run("Enrich lead", () => api(`/api/leads/${lead.id}/enrich`, { method: "POST", body: { workspaceId } }))}>Check contact details first</Button>
                      ) : null}
                      {stage === "waiting" ? (
                        <Button icon={Check} disabled={outreachBlocked} onClick={() => run("Approve message", () => api(`/api/messages/${message.id}/approve`, { method: "POST", body: { workspaceId } }))}>Approve</Button>
                      ) : null}
                      {stage === "ready" && message.leadId ? (
                        <Button disabled={outreachBlocked} onClick={() => run("Mark sent", () => api("/api/outreach/mark-sent", { method: "POST", body: { workspaceId, leadId: message.leadId, messageTemplateId: message.id, campaignId: message.campaignId, channel: message.channel } }))}>I sent it — mark as sent</Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty text={stage === "waiting" ? "No messages are waiting for your OK." : stage === "ready" ? "Nothing approved and waiting to be sent." : "No messages sent yet."} />
          )}
        </div>
      </Panel>

      <Panel title="Draft a new message" icon={Send}>
        <p className="text-sm text-muted-2">The AI writes it; you review it, send it yourself, then mark it as sent. Nothing is sent from here.</p>
        {/* 2026-09-08: sorted by name so the same six show on every database,
            and it says where the rest are. */}
        <div className="mt-3 flex flex-wrap gap-2">
          {approved.slice(0, 6).map((lead) => (
            <button key={lead.id} className="btn secondary" disabled={lead.doNotContact || ["rejected", "invalid", "duplicate", "do_not_contact"].includes(lead.status)} onClick={() => run("Generate message", () => api("/api/messages/generate", { method: "POST", body: { workspaceId, leadId: lead.id, campaignId: campaign?.id || lead.campaignId, channel: "WhatsApp" } }))} aria-label={`Draft a WhatsApp message for ${lead.companyName || "this prospect"}`}><Sparkles className="h-4 w-4" /> {lead.companyName || "Unnamed prospect"}</button>
          ))}
          {approved.length === 0 ? <p className="text-sm text-muted">No approved leads yet. Approve leads in Leads first.</p> : null}
          {approved.length > 6 ? (
            <p className="w-full text-sm text-muted-2">
              {`Showing 6 of ${approved.length} approved leads, by name. For any other lead, open it in Leads and choose "Generate WhatsApp message".`}
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function MessageGenerationStatus({ message }: { message: MessageTemplate }) {
  const meta = getMessageGenerationMeta(message);
  if (!meta) {
    return (
      <div className="mt-2 rounded-md border border-warning-bg bg-warning-bg px-3 py-2 text-sm text-warning-fg">
        Older draft: not known whether a real AI wrote it. Read it carefully before use.
      </div>
    );
  }
  const modeLabel = meta.mode === "real" ? "AI draft" : meta.mode === "fallback" ? "AI draft (backup)" : "Sample draft";
  return (
    <div className="mt-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{meta.reviewState === "approved" ? "Approved draft" : meta.reviewState === "used" ? "Used in outreach" : "Draft pending review"}</Badge>
        <Badge>{modeLabel}</Badge>
        {meta.humanReviewRequired ? <Badge>Human review required</Badge> : null}
        {!meta.humanReviewRequired && meta.reviewState === "approved" ? <Badge>Human reviewed</Badge> : null}
      </div>
      <p className="mt-2 text-muted-2">
        {meta.reviewState === "approved" ? "Reviewed draft. Manual sending is still required." : meta.safetyNote || "Draft only. Review before using this message."}
      </p>
      {Number(meta.context?.conflictsPending || 0) ? (
        <p className="mt-1 text-xs text-warning-fg">{Number(meta.context?.conflictsPending)} unresolved fact conflict{Number(meta.context?.conflictsPending) === 1 ? "" : "s"} in your knowledge — check claims before sending.</p>
      ) : null}
      {Array.isArray(meta.missingInformation) && meta.missingInformation.length ? (
        <p className="mt-1 text-xs text-warning-fg">Missing before strong claims: {meta.missingInformation.join(", ")}</p>
      ) : null}
    </div>
  );
}

function getMessageGenerationMeta(message: MessageTemplate) {
  const meta = message.personalizationUsed?.generationMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  return meta as {
    provider?: string;
    modelName?: string;
    mode?: "real" | "mock" | "fallback";
    humanReviewRequired?: boolean;
    reviewState?: "pending_review" | "approved" | "used";
    safetyNote?: string;
    missingInformation?: string[];
    context?: { answerCount?: number; chunkCount?: number; conflictsPending?: number };
  };
}

/**
 * 2026-08-05 (UX Fix 2) — inline quick-answer component for held-for-review
 * replies. When the AI says "I need to confirm pricing", this lets the owner
 * type the answer RIGHT THERE (no tab-switch). The answer saves to the
 * internal note so it's visible next time + the AI picks it up as context.
 */
/**
 * 2026-08-05 (UX Fix 4) — Global search with Cmd/Ctrl+K shortcut.
 * Searches leads by company name, contact name, phone. On select,
 * navigates to the CRM tab + focuses the lead.
 */
function GlobalSearch({ leads, onNavigate }: { leads: Lead[]; onNavigate: (leadId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K to open, Escape to close.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setQuery("");
  }, [open]);

  const results = query.trim().length < 1 ? [] : leads
    .filter((l) => {
      const q = query.toLowerCase();
      return (l.companyName?.toLowerCase().includes(q) ||
              l.contactName?.toLowerCase().includes(q) ||
              l.whatsappNumber?.includes(q) ||
              l.phone?.includes(q) ||
              l.city?.toLowerCase().includes(q));
    })
    .slice(0, 8);

  if (!open) {
    return (
      <button
        className="icon-btn"
        onClick={() => setOpen(true)}
        title="Search (Ctrl+K)"
        aria-label="Search leads"
      >
        <Search className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]" onClick={() => setOpen(false)}>
      <div className="w-full max-w-lg rounded-xl border border-border-default bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border-default px-4 py-3">
          <Search className="h-4 w-4 text-muted" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
            placeholder="Search leads by name, company, phone, or city…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="rounded border border-border-default px-1.5 py-0.5 text-xs text-muted">ESC</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">{query ? "No leads found." : "Start typing to search…"}</p>
          ) : (
            results.map((lead) => (
              <button
                key={lead.id}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-tint"
                onClick={() => { onNavigate(lead.id); setOpen(false); }}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-tint text-xs font-bold text-primary-strong">
                  {(lead.companyName || "?")[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{lead.companyName || "Unknown"}</p>
                  <p className="truncate text-xs text-muted">{lead.contactName || "No contact"} · {lead.city || "—"}</p>
                </div>
                <Badge className="shrink-0">{displayLeadStatus(lead.status)}</Badge>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function QuickAnswer({ reason, onSave }: { reason: string; onSave: (answer: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState("");
  if (!expanded) {
    return (
      <button
        className="mt-1 text-xs font-semibold text-primary hover:underline"
        onClick={() => setExpanded(true)}
      >
        💡 Answer this here →
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-lg border border-primary/30 bg-primary-tint/30 p-3">
      <p className="text-xs font-semibold text-muted">Quick answer (saves to this thread's note):</p>
      <textarea
        className="mt-2 w-full resize-y rounded border border-border-default bg-background px-3 py-2 text-sm"
        rows={2}
        autoFocus
        placeholder="e.g. Our MOQ is 100m. Price for 500m is ₹42/m."
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          className="btn text-xs"
          disabled={!answer.trim()}
          onClick={() => { onSave(answer.trim()); setExpanded(false); setAnswer(""); }}
        >
          Save answer
        </button>
        <button className="btn secondary text-xs" onClick={() => { setExpanded(false); setAnswer(""); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Replies({ leads, selectedLead, explicitlyFocusedLead, run, autoReplyLogs, mediaItems, reload, onFocusLead, setActive }: { leads: Lead[]; replies: Reply[]; selectedLead?: Lead; explicitlyFocusedLead?: Lead; run: Runner; autoReplyLogs: AutoReplyLog[]; mediaItems: MediaCatalogItem[]; reload?: () => void; onFocusLead?: (leadId: string, section: TabId) => void; setActive?: (tab: TabId) => void }) {
  const [activeLogId, setActiveLogId] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [draftMedia, setDraftMedia] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState("");
  const [simulateModalOpen, setSimulateModalOpen] = useState(false);
  const [simulateText, setSimulateText] = useState("What is the price for bulk orders?");
  const [simulateLeadId, setSimulateLeadId] = useState(selectedLead?.id || leads[0]?.id || "");
  const [simulateResult, setSimulateResult] = useState<Record<string, unknown> | null>(null);
  // CP-22 Feature B — customer profile popup (click name → see full details).
  const [profileLead, setProfileLead] = useState<Lead | null>(null);
  // CP-22 Feature A — conversation timeline (what we've discussed so far).
  const [timelineData, setTimeline] = useState<LeadActivityTimeline | null>(null);
  const [timelineLeadId, setTimelineLeadId] = useState<string | null>(null);
  // CP-22 — AI conversation summary (2-3 sentence natural-language recap).
  const [convSummaryData, setConvSummary] = useState<{ summary: string; mode: string; error?: string; contextCoverage?: { includedEvents: number; totalEvents: number; shortenedMessages: number; limited: boolean } } | null>(null);
  const [showRawTimeline, setShowRawTimeline] = useState(false);
  // CP-24 — 24h window status + CP-25 template picker.
  const [windowStatusData, setWindowStatus] = useState<{ open: boolean; hoursRemaining?: number; label: string } | null>(null);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [detailsRetry, setDetailsRetry] = useState(0);
  const detailRequest = useRef(0);
  const summaryRequest = useRef(0);
  const [simulateBusy, setSimulateBusy] = useState(false);
  const simulateRequest = useRef(0);
  const [waTemplates, setWaTemplates] = useState<Array<{ id: string; name: string; body: string; status: string; language: string }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  // 2026-08-05 (UX Fix 1) — operator's internal note on each reply thread.
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});
  const [noteSaved, setNoteSaved] = useState<string | null>(null);
  const logs = autoReplyLogs.map(normalizeAutoReplyLog).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const filteredLogs = logs.filter((log) => {
    const lead = leads.find((l) => l.id === log.leadId);
    const search = searchTerm.toLowerCase();
    const matchesSearch = (lead?.companyName?.toLowerCase().includes(search) || log.incomingMessage.toLowerCase().includes(search) || log.generatedReply?.toLowerCase().includes(search));
    // 2026-08-05 N-P1-1: when drilled-in from a lead (focusLeadId set), filter
    // to that lead's replies — matching the ribbon promise + the Commercial/
    // Tickets pattern. Was showing ALL replies despite "Viewing in context of".
    // UA-5 fix: was keying off `selectedLead`, which ALWAYS falls back to some
    // lead (see page.tsx:302-305) even with no drill-down, so a fresh nav-in
    // silently filtered to that fallback lead's replies (usually 0 of them)
    // instead of showing everything. `explicitlyFocusedLead` is only set when
    // the owner actually clicked into a lead (focusLeadId truthy) — same fix
    // already applied to the Owner Copilot (audit U-1, see page.tsx:307-325).
    const matchesFocus = !explicitlyFocusedLead || log.leadId === explicitlyFocusedLead.id;
    return matchesSearch && matchesFocus;
  });

  const activeLog = filteredLogs.find((l) => l.id === activeLogId) || filteredLogs[0];
  const activeLead = activeLog ? leads.find((l) => l.id === activeLog.leadId) : undefined;
  const activeLeadId = activeLead?.id;
  const timeline = timelineLeadId === activeLeadId ? timelineData : null;
  const convSummary = timelineLeadId === activeLeadId ? convSummaryData : null;
  const windowStatus = timelineLeadId === activeLeadId ? windowStatusData : null;
  const editText = activeLog ? (draftEdits[activeLog.id] ?? activeLog.generatedReply ?? "") : "";
  const isTeamFollowup = activeLog?.retrievedContext?.source === "ticket_closure";

  // CP-22 Feature A — fetch the conversation timeline + AI summary for the
  // active lead. The summary is a 2-3 sentence natural-language recap (real AI
  // when connected, heuristic fallback when not). The raw timeline is available
  // on-demand (collapsible) for owners who want the detail.
  // 2026-08-20 N-UX-8. The 2026-08-05 fix for the "infinite Skeleton" set
  // { summary: "", mode: "error" } on failure so the shimmer would stop. It
  // did not stop: the renderer was `convSummary?.summary || <Skeleton/>`, and
  // an empty string is falsy — so the failure path rendered the very shimmer
  // the fix was written to remove, forever, with no message and no way to
  // retry. Loading is now `convSummary === null` and nothing else, the error
  // carries its own text, and the operator gets a Try again button.
  function loadConvSummary(leadId: string, generation = detailRequest.current) {
    const request = ++summaryRequest.current;
    setConvSummary(null);
    api<NonNullable<typeof convSummary>>(`/api/leads/${leadId}/conversation-summary`)
      .then(result => { if (generation === detailRequest.current && request === summaryRequest.current) setConvSummary(result); })
      .catch((e) => {
        if (generation !== detailRequest.current || request !== summaryRequest.current) return;
        const message = e instanceof Error ? e.message : String(e);
        console.warn("Conversation summary load failed:", message);
        setConvSummary({ summary: "", mode: "error", error: message });
      });
  }
  useEffect(() => {
    const generation = ++detailRequest.current;
    if (!activeLeadId) return;
    const current = () => generation === detailRequest.current;
    setTimelineLeadId(activeLeadId);
    setTimeline(null);
    setConvSummary(null);
    setWindowStatus(null);
    setDetailErrors({});
    setWaTemplates([]);
    setShowRawTimeline(false);
    setSelectedTemplate("");
    const failure = (part: string, error: unknown) => {
      if (current()) setDetailErrors(previous => ({ ...previous, [part]: error instanceof Error ? error.message : "Could not load this information." }));
    };
    api<LeadActivityTimeline>(`/api/activity/lead/${activeLeadId}`)
      .then(result => { if (current()) setTimeline(result); })
      .catch(error => failure("Customer history", error));
    loadConvSummary(activeLeadId, generation);
    // CP-24 — fetch the 24h window status for this lead.
    api<{ open: boolean; hoursRemaining?: number; label: string }>(`/api/leads/${activeLeadId}/whatsapp-window`)
      .then(result => { if (current()) setWindowStatus(result); })
      .catch(error => failure("WhatsApp reply window", error));
    // CP-25 — fetch approved templates (for the window-closed picker).
    api<Array<{ id: string; name: string; body: string; status: string; language: string }>>(`/api/whatsapp-templates`)
      .then((tpls) => { if (current()) setWaTemplates(tpls.filter((t) => t.status === "approved")); })
      .catch(error => failure("Approved templates", error));
    return () => { detailRequest.current++; summaryRequest.current++; };
  }, [activeLeadId, detailsRetry]);
  const selectedMediaId = activeLog ? (draftMedia[activeLog.id] ?? activeLog.mediaAttachmentId ?? "") : "";
  const selectedMedia = mediaItems.find((item) => item.id === selectedMediaId);

  return (
    // 2026-09-28 — the fixed height (a guess at the header's height) is for
    // desktop only, where list and conversation scroll side by side. On a phone
    // the header is taller than the guess, and a box that scrolls inside a
    // page that also scrolls is hard to use with one thumb, so the page scrolls.
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-140px)] lg:flex-row">
      {/* 2026-08-05 (UX Fix 3) — mobile master-detail: on mobile, hide the
          list when a reply is selected so the detail gets full screen. The
          operator taps "← Back" to return to the list. Desktop is unchanged. */}
      <div className={`flex w-full flex-col overflow-hidden rounded-md border border-border-default bg-surface lg:w-1/3 ${activeLogId ? "hidden lg:flex" : "flex"}`}>
        <div className="border-b border-border-default p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Replies Inbox</h2>
            {/* N-A11Y-12 — a `title` is a mouse tooltip, not an accessible
                name: this button announced as "button" with no name at all to
                anyone not using a mouse. The tooltip stays; the name is now
                explicit, and says what it does rather than just naming a
                feature. */}
            <button
              className="icon-btn bg-surface-tint hover:bg-surface-tint"
              onClick={() => setSimulateModalOpen(true)}
              title="Simulate Reply"
              aria-label="Simulate an incoming customer reply"
            >
              <Plus className="h-4 w-4 text-primary" />
            </button>
          </div>
          <div className="mt-3 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
            <input className="input has-leading-icon" placeholder="Search replies or companies..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} aria-label="Search replies by message text or company name" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2 bg-surface-muted">
          {filteredLogs.length === 0 ? (
            // Stage A+ / Cluster 10b (P2-11): distinguish "no replies at all"
            // from "no matches for this search". Was: same terse message for
            // both — the user couldn't tell if the app was broken or filtered.
            <div className="p-4 text-sm text-muted">
              {logs.length === 0 ? (
                <>
                  <p className="font-medium text-foreground">No customer replies yet.</p>
                  <p className="mt-1">When a customer replies on WhatsApp, the AI drafts a response and it lands here for your review.</p>
                </>
              ) : (
                <>
                  <p className="font-medium text-foreground">No replies match "{searchTerm}".</p>
                  <p className="mt-1">Try a different search, or clear the search box to see all {logs.length} replies.</p>
                </>
              )}
            </div>
          ) : (
            filteredLogs.map((log) => {
              const lead = leads.find((l) => l.id === log.leadId);
              const isSelected = activeLog?.id === log.id;
              const status = replyStatusDisplay(log);
              // 2026-08-02 (UX redesign Phase 3): "whose turn is it" signal
              // (Help Scout + Zendesk pattern). Approved/auto_sent = we replied,
              // now waiting on the customer. Held/drafted = customer is waiting
              // on US. This is the single most important triage cue in an inbox.
              // 2026-09-25 — only when the reply actually REACHED them: an
              // approved-but-undelivered reply said "Waiting on customer" beside
              // a badge saying the customer got nothing.
              const isWaitingOnCustomer = status.delivered && (log.status === "approved" || log.status === "auto_sent" || log.status.includes("resolved"));
              const needsOurReply = log.status === "held_for_review" || log.status === "drafted";
              return (
                <button
                  key={log.id}
                  onClick={() => setActiveLogId(log.id)}
                  className={`w-full text-left rounded-md border p-3 transition-colors ${isSelected ? "border-primary bg-surface-tint" : "border-border-default bg-surface hover:bg-surface"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground truncate">{lead?.companyName || "Not in your leads"}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>{status.label}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                    <span className="truncate">{log.classification ? displayReplyClassification(log.classification) : "Not sorted yet"}</span>
                    <span className="shrink-0">{formatDate(log.createdAt).split(",")[0]}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-2 line-clamp-2">{log.incomingMessage}</p>
                  {/* 2026-08-02: explicit turn-status pill so the owner knows at
                      a glance whether the customer is waiting on them. */}
                  {needsOurReply ? (
                    <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-fg">
                      <span className="h-1.5 w-1.5 rounded-full bg-warning-fg" /> Awaiting your reply
                    </p>
                  ) : isWaitingOnCustomer ? (
                    <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted" /> Waiting on customer
                    </p>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 2026-08-05 (UX Fix 3) — detail pane: hidden on mobile when no reply
          selected (list takes full screen); full screen on mobile when a reply
          IS selected. Desktop is unchanged (always visible, lg:w-2/3). */}
      <div className={`flex w-full flex-col overflow-hidden rounded-md border border-border-default bg-surface lg:w-2/3 ${activeLogId ? "flex" : "hidden lg:flex"}`}>
        {/* Mobile-only back button to return to the inbox list. */}
        {activeLog && (
          <button
            type="button"
            className="flex min-h-11 items-center gap-1 border-b border-border-default px-4 py-2 text-sm font-semibold text-primary hover:bg-surface-tint lg:hidden"
            onClick={() => setActiveLogId(null)}
          >
            <ChevronLeft className="h-4 w-4" /> Back to inbox
          </button>
        )}
        {activeLog ? (
          <>
            <div className="border-b border-border-default bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                {/* CP-22 Feature B — customer name is a clickable link → popup
                    with the full company snapshot (phone, email, city, etc). */}
                {activeLead ? (
                  <button
                    type="button"
                    className="text-left text-lg font-semibold text-foreground underline underline-offset-2 hover:text-primary-strong"
                    onClick={() => setProfileLead(activeLead)}
                    aria-label={`View full profile for ${activeLead.companyName || "this lead"}`}
                  >
                    {activeLead.companyName || "Unknown Lead"}
                  </button>
                ) : (
                  <h3 className="text-lg font-semibold text-foreground">Not in your leads</h3>
                )}
                {activeLead ? <span className="text-sm font-medium text-muted-2">Score: {leadScoreText(activeLead)}</span> : null}
              </div>
              {activeLead?.doNotContact && (
                <div className="mt-2 flex items-center gap-2 rounded-md bg-danger-bg px-3 py-2 text-sm font-semibold text-danger-fg">
                  <AlertTriangle className="h-4 w-4" /> Outreach Blocked: Customer requested not to be contacted.
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {timelineLeadId === activeLeadId && Object.keys(detailErrors).length > 0 ? <div role="alert" className="rounded-md border border-warning-bg bg-warning-bg p-3 text-sm">
                {Object.entries(detailErrors).map(([part, message]) => <p key={part}>{part} could not be loaded: {message}</p>)}
                <Button variant="secondary" size="sm" className="mt-2" onClick={() => setDetailsRetry(value => value + 1)}>Try conversation details again</Button>
              </div> : null}
              {/* CP-22 Feature A — AI conversation summary. A 2-3 sentence
                  natural-language recap of what's been discussed with this
                  customer. Real AI when connected; heuristic fallback when not
                  (so the box is never empty). Below it, a collapsible raw
                  timeline for owners who want the event-by-event detail. */}
              {activeLead ? (
                <div className="rounded-md border border-border-default bg-surface p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-primary">Conversation so far</p>
                    {convSummary ? (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${convSummary.mode === "real" ? "bg-success-bg text-success-fg" : convSummary.mode === "error" ? "bg-danger-bg text-danger-fg" : "bg-surface-muted text-muted"}`}>
                        {convSummary.mode === "real" ? "AI summary" : convSummary.mode === "fallback" ? "Summary (offline)" : convSummary.mode === "error" ? "Summary unavailable" : "Summary (sample)"}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 text-sm text-foreground leading-relaxed">
                    {convSummary === null ? (
                      // 2026-09-04 N-UX-19 — a bare grey bar. This summary is a
                      // live model call and can take several seconds, so the
                      // bar is what an operator actually sees on opening a
                      // reply, and a grey rectangle with no words is
                      // indistinguishable from a panel that has broken. Say
                      // what is happening.
                      <div className="space-y-2">
                        <p className="text-sm text-muted">Reading the conversation…</p>
                        <Skeleton className="h-4 w-full" />
                      </div>
                    ) : convSummary.mode === "error" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-danger-fg">Couldn&apos;t load the summary{convSummary.error ? `: ${convSummary.error}` : "."}</span>
                        <button type="button" className="btn secondary" onClick={() => loadConvSummary(activeLead.id)}>Try again</button>
                      </div>
                    ) : convSummary.summary ? (
                      convSummary.summary
                    ) : (
                      <span className="text-muted">Nothing has been discussed with this customer yet.</span>
                    )}
                  </div>
                  {/* Collapsible raw timeline — for owners who want event detail. */}
                  {convSummary?.contextCoverage?.limited && (
                    <p className="mt-2 text-xs text-muted">
                      This summary uses {convSummary.contextCoverage.includedEvents} of {convSummary.contextCoverage.totalEvents} recent events and saved customer notes.
                      {convSummary.contextCoverage.shortenedMessages > 0 ? ' Some long messages are shortened for the AI.' : ''}
                      {' Original messages remain in Conversations.'}
                    </p>
                  )}
                  {timeline && timeline.events && timeline.events.length > 0 ? (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="text-xs text-primary underline underline-offset-2 hover:text-primary-strong"
                        onClick={() => setShowRawTimeline((v) => !v)}
                      >
                        {showRawTimeline ? "Hide event details" : `Show event details (${timeline.events.length})`}
                      </button>
                      {showRawTimeline ? (
                        <ul className="mt-2 space-y-1 border-t border-border-subtle pt-2">
                          {timeline.events.slice(-8).map((event, i) => (
                            <li key={`${event.type}-${i}`} className="flex items-start gap-2 text-xs">
                              <span className="mt-0.5 shrink-0 text-muted">{formatDate(event.happenedAt).split(",")[0]}</span>
                              <span className="text-muted-2">{event.label}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {/* 2026-08-02 (UI polish) — Intercom-style unified conversation
                  thread. The customer's inbound message and our AI-suggested
                  reply now render as chat bubbles in ONE chronological thread
                  (customer = left bubble, our reply = right bubble), exactly
                  like WhatsApp Web / Intercom. Replaces the old layout where
                  each was a separate labeled box with metadata stacked
                  between them. All metadata (category, confidence, knowledge
                  context, window status, attachment, send actions) is preserved
                  — it now lives in a "Review & reply" composer below the
                  thread, where it belongs. */}
              <div className="space-y-4">
                {/* Customer message — left-aligned bubble. */}
                <div className="flex justify-start">
                  <div className="max-w-[80%]">
                    <div className="rounded-2xl rounded-tl-sm border border-border-default bg-surface-muted px-4 py-3 text-sm text-foreground shadow-sm">
                      {isTeamFollowup && <p className="mb-1 text-xs font-semibold text-muted">Ticket context</p>}
                      <p className="whitespace-pre-wrap">{activeLog.incomingMessage}</p>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-1">
                      <Badge>{activeLog.classification ? displayReplyClassification(activeLog.classification) : "Not sorted yet"}</Badge>
                      {/* A 0% confidence is "not recorded", not a finding. */}
                      {(activeLog.confidenceScore || 0) > 0 ? <Badge>Confidence: {Math.round((activeLog.confidenceScore || 0) * 100)}%</Badge> : null}
                      <Badge>{replyStatusDisplay(activeLog).label}</Badge>
                      {activeLog.mediaAttachmentName ? <Badge>Attachment suggested</Badge> : null}
                      <button
                        className="btn secondary text-xs py-0.5 px-2"
                        disabled={!activeLog.replyId}
                        onClick={() => activeLog.replyId && run("Sorted again", () => api(`/api/replies/${activeLog.replyId}/classify`, { method: "POST", body: { workspaceId } }).then(() => reload?.()))}
                      >Ask the AI to sort it again</button>
                    </div>
                  </div>
                </div>

                {/* Escalation / held-for-review divider (Intercom-style) +
                    2026-08-05 (UX Fix 2) — inline "answer the AI's question"
                    quick-action so the operator doesn't have to tab-switch to
                    Information Needed. */}
                {(activeLog.status.includes("held_for_review") || activeLog.status.includes("blocked")) && activeLog.reason ? (
                  <>
                    <div className="flex items-center gap-2 py-1">
                      <div className="h-px flex-1 bg-border-default" />
                      <span className="rounded-full bg-warning-bg px-3 py-1 text-xs font-medium text-warning-fg">
                        <AlertCircle className="mr-1 inline h-3 w-3" />
                        {activeLog.status.includes("blocked") ? "Blocked" : "Held for your review"}: {activeLog.reason}
                      </span>
                      <div className="h-px flex-1 bg-border-default" />
                    </div>
                    {/* Inline quick-answer: type the answer right here, saves
                        to the internal note so it's visible next time + the
                        AI picks it up as context. */}
                    <QuickAnswer
                      reason={activeLog.reason}
                      onSave={(answer) => {
                        const note = `AI needed: ${activeLog.reason}\nOwner answered: ${answer}`;
                        run("Save answer", async () => {
                          await api(`/api/auto-reply-logs/${activeLog.id}/note`, { method: "POST", body: { workspaceId, note } });
                          reload?.();
                        });
                      }}
                    />
                  </>
                ) : null}

                {/* Our AI-suggested reply — right-aligned bubble. */}
                <div className="flex justify-end">
                  <div className="max-w-[80%]">
                    <div className={`rounded-2xl rounded-tr-sm border px-4 py-3 text-sm shadow-sm ${activeLog.modelMode === "real" ? "border-primary/30 bg-primary-tint text-foreground" : "border-warning-bg bg-warning-bg/40 text-foreground"}`}>
                      <p className="whitespace-pre-wrap opacity-80">{editText || "(no draft yet)"}</p>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5 pr-1">
                      {isTeamFollowup ? <Badge>Team follow-up draft</Badge> : activeLog.modelMode === "real" ? (
                        <Badge>AI draft{activeLog.modelName ? ` · ${activeLog.modelProvider || ""} ${activeLog.modelName}`.trim() : ""}</Badge>
                      ) : activeLog.modelMode === "fallback" ? (
                        <Badge>AI draft (backup)</Badge>
                      ) : activeLog.modelMode === "mock" ? (
                        <Badge>Sample draft — needs a real AI key</Badge>
                      ) : (
                        <Badge>Check this reply before sending</Badge>
                      )}
                      {activeLog.fallbackUsed ? <Badge>Backup model used</Badge> : null}
                    </div>
                  </div>
                </div>
              </div>

              {/* Review & reply composer — all the action metadata lives here,
                  below the conversation thread. This is where the owner edits
                  the draft, picks an attachment, checks the 24h window, and
                  sends. Keeps the thread clean while preserving every action. */}
              <div className="rounded-xl border border-border-default bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Review &amp; reply</p>

                {/* 24h window status + template picker. */}
                <div className="mt-3">
                  <p className="text-xs font-medium text-muted-2">WhatsApp send status</p>
                  <p className="mt-0.5 text-sm font-semibold text-foreground">{sendStatusText(activeLog)}</p>
                  {activeLog.providerError ? <p className="mt-1 text-xs text-danger-fg">{activeLog.providerError}</p> : null}
                  {!activeLog.sendAttempted && activeLog.sendStatus === "not_configured" ? <p className="mt-1 text-xs text-warning-fg">Add WhatsApp Cloud credentials before using real send.</p> : null}
                  {windowStatus ? (
                    (() => {
                      // 2026-08-02 (UX redesign Phase 3): 3-tier countdown
                      // (Zendesk SLA pattern: green >2h / amber <2h / red <30min
                      // or expired). Mirrors the production urgency gradient so
                      // the owner can prioritize WhatsApp threads about to lose
                      // free-form access without opening each one.
                      const hours = windowStatus.hoursRemaining;
                      const tier = !windowStatus.open
                        ? { cls: "bg-danger-bg text-danger-fg", dot: "bg-danger-fg" }
                        : hours != null && hours <= 0.5
                          ? { cls: "bg-danger-bg text-danger-fg", dot: "bg-danger-fg" }
                          : hours != null && hours <= 2
                            ? { cls: "bg-warning-bg text-warning-fg", dot: "bg-warning-fg" }
                            : { cls: "bg-success-bg text-success-fg", dot: "bg-success-fg" };
                      // The server label already says "21h 40m remaining"; adding "· 21h left" said it twice.
                      const hoursLabel = windowStatus.open && hours != null && !/remaining|left/i.test(windowStatus.label) ? ` · ${Math.max(0, Math.round(hours))}h left` : "";
                      return (
                        <div className={`mt-2 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${tier.cls}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${tier.dot}`} aria-hidden="true" />
                          {windowStatus.label}{hoursLabel}
                        </div>
                      );
                    })()
                  ) : null}
                  {windowStatus && !windowStatus.open ? (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-muted">Select a pre-approved template to send:</p>
                      {waTemplates.length > 0 ? (
                        <select className="input mt-1 text-sm" value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)} aria-label="Select WhatsApp template">
                          <option value="">— Select a template —</option>
                          {waTemplates.map((t) => <option key={t.id} value={t.name}>{t.name} ({t.language})</option>)}
                        </select>
                      ) : (
                        <p className="mt-1 text-xs text-warning-fg">No approved templates are configured for this company. Ask whoever manages your WhatsApp Business connection to add Meta-approved templates before sending outside the reply window.</p>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* Retrieved knowledge context (collapsible — keeps the composer
                    clean; the owner expands it when they want to verify the
                    AI's source). */}
                {activeLog.retrievedContext && (activeLog.retrievedContext.chunks || []).length > 0 ? (
                  <details className="mt-3 rounded-md border border-border-subtle bg-surface-muted p-2">
                    <summary className="cursor-pointer text-xs font-semibold text-muted flex items-center gap-1">
                      <BookOpen className="h-3 w-3" /> Knowledge used ({(activeLog.retrievedContext.chunks || []).length} source{(activeLog.retrievedContext.chunks || []).length === 1 ? "" : "s"})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {(activeLog.retrievedContext.chunks || []).map((chunk, i) => (
                        <div key={i} className="rounded-md border border-border-subtle bg-surface p-2 text-xs">
                          <p className="font-semibold text-muted-2 mb-1">{chunk.documentTitle}</p>
                          <p className="text-muted">{chunk.chunkText ? `${chunk.chunkText.slice(0, 200)}...` : `Matched chunk ${chunk.id}`}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : (
                  <div className="mt-3 rounded-md border border-warning-bg bg-warning-bg/50 p-2 text-xs text-warning-fg">
                    <p><BookOpen className="mr-1 inline h-3 w-3" /> Nothing in your knowledge answers this, so check every fact in this reply before it goes out.</p>
                    {/* 2026-08-05 N-P1-4: was display-only. Now offers the one-click
                        jump to add the missing knowledge — the single most useful
                        next action when the AI flags a gap. */}
                    <button className="mt-1.5 font-semibold underline" onClick={() => setActive?.("knowledge")}>Add to Knowledge Base →</button>
                  </div>
                )}

                {/* 2026-08-02 (UX redesign Phase 3): AI draft vs. your edit are now
                    visually separated (Intercom Copilot pattern). The AI's
                    original suggestion shows in a tinted "AI draft" panel with a
                    one-click "Use this" gate; the editable textarea below is the
                    owner's territory and is what actually gets sent. The owner
                    must explicitly bring the AI's text in — it does NOT silently
                    pre-populate without a visible "this is the AI's suggestion"
                    frame. Keeps the existing edit state (editText) so the send
                    flow is unchanged. */}
                {(() => {
                  const originalDraft = activeLog.generatedReply ?? "";
                  const hasEdited = originalDraft && editText !== originalDraft;
                  const isResolved = activeLog.status === "approved" || activeLog.status === "rejected" || activeLog.status === "auto_sent" || activeLead?.doNotContact;
                  return (
                    <div className="mt-3 space-y-2">
                      {/* 2026-09-25 — shown only once the owner has changed the
                          text. Before that it was a third copy of the same reply
                          (the bubble above and the box below already show it). */}
                      {originalDraft && hasEdited ? (
                        <div className="rounded-md border border-primary/20 bg-primary-tint/40 p-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                              <Sparkles className="h-3 w-3" /> {isTeamFollowup ? "Team follow-up draft" : "AI draft"}
                            </span>
                            {!isResolved ? (
                              <button
                                type="button"
                                className="text-xs text-primary underline underline-offset-2 hover:text-primary-strong"
                                onClick={() => activeLog && setDraftEdits((current) => ({ ...current, [activeLog.id]: originalDraft }))}
                              >
                                {isTeamFollowup ? "Reset to team draft" : "Reset to AI draft"}
                              </button>
                            ) : null}
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{originalDraft}</p>
                        </div>
                      ) : null}
                      <textarea
                        className="input min-h-28 text-sm"
                        value={editText}
                        placeholder={originalDraft ? "Edit the draft above, or type your own reply…" : "Type your reply…"}
                        onChange={(e) => activeLog && setDraftEdits((current) => ({ ...current, [activeLog.id]: e.target.value }))}
                        disabled={isResolved}
                        aria-label={`Edit the WhatsApp reply for ${activeLead?.contactName || activeLead?.companyName || "this lead"}`}
                      />
                      {hasEdited ? (
                        <p className="text-xs text-muted">You've edited the {isTeamFollowup ? 'team' : 'AI'} draft. Your version is what gets sent.</p>
                      ) : null}
                    </div>
                  );
                })()}

                {/* Attachment picker. */}
                <div className="mt-3 rounded-md border border-border-subtle bg-surface-muted p-3">
                  <label className="label" htmlFor="reply-media-attachment">Attach catalog, certificate, image, or policy PDF</label>
                  <select
                    id="reply-media-attachment"
                    className="input mt-1"
                    value={selectedMediaId}
                    onChange={(event) => activeLog && setDraftMedia((current) => ({ ...current, [activeLog.id]: event.target.value }))}
                    disabled={activeLog.status === "approved" || activeLog.status === "rejected" || activeLog.status === "auto_sent" || activeLead?.doNotContact}
                  >
                    <option value="">No attachment</option>
                    {mediaItems.map((item) => (
                      <option key={item.id} value={item.id}>{item.title} ({displayLabel(item.category)})</option>
                    ))}
                  </select>
                  {selectedMedia ? (
                    <a className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary underline" href={selectedMedia.url} target="_blank" rel="noreferrer">
                      <Link2 className="h-3 w-3" /> Preview selected file
                    </a>
                  ) : activeLog.mediaAttachmentUrl ? (
                    <a className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary underline" href={activeLog.mediaAttachmentUrl} target="_blank" rel="noreferrer">
                      <Link2 className="h-3 w-3" /> Preview suggested file
                    </a>
                  ) : <p className="mt-2 text-xs text-muted">To attach a file, add it once under Connections, then pick it here.</p>}
                </div>

                {/* Action buttons. */}
                <ActionBar className="mt-4">
                  {["held_for_review", "drafted"].includes(activeLog.status) && !activeLead?.doNotContact ? (
                    <>
                      <Button icon={Send} disabled={!editText.trim()} onClick={() => run("Approve & Send", async () => {
                        // 2026-08-05 UX audit (P2-2): guard against sending an
                        // empty message. The owner can clear the textarea to
                        // start fresh; a stray Approve&Send click used to POST
                        // an empty body (and copy "" to clipboard). The button
                        // is disabled when empty; this guard is defense-in-depth.
                        if (!editText.trim()) return;
                        // F-API-1 (2026-08-04): forward the owner-selected
                        // template (name + language) so closed-24h-window sends
                        // actually reach Meta's template API. The UI already
                        // rendered the dropdown + collected selectedTemplate,
                        // but the POST dropped it — so a closed-window send
                        // always failed with "WhatsApp API Error" even when
                        // the owner had picked a template.
                        const selectedTpl = waTemplates.find((t) => t.name === selectedTemplate);
                        await api(`/api/auto-reply-logs/${activeLog.id}/approve`, {
                          method: "POST",
                          body: {
                            workspaceId,
                            body: editText,
                            mediaAttachmentId: selectedMediaId || undefined,
                            templateName: selectedTemplate || undefined,
                            templateLanguage: selectedTpl?.language,
                          },
                        });
                        copyToClipboard(editText);
                      })}>
                        Approve & Send
                      </Button>
                      <Button variant="secondary" icon={Trash2} onClick={() => run("Dismiss Draft", async () => {
                        await api(`/api/auto-reply-logs/${activeLog.id}/reject`, { method: "POST", body: { workspaceId } });
                      })}>
                        Dismiss Draft
                      </Button>
                      <Button variant="secondary" icon={Clipboard} onClick={() => {
                        copyToClipboard(editText);
                      }}>
                        Copy text
                      </Button>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-muted">
                        {activeLead?.doNotContact ? "Outreach blocked" : replyStatusDisplay(activeLog).label}
                      </span>
                      <button className="btn secondary" onClick={() => {
                        copyToClipboard(editText);
                      }}>
                        <Clipboard className="h-4 w-4" /> Copy text
                      </button>
                      {/* 2026-09-29 (walk-through R2): an approved reply that never reached the
                          customer used to stop here. The owner sends it from their phone and says so. */}
                      {activeLog.status === "approved" && !activeLead?.doNotContact && !replyDeliveryState(activeLog).delivered ? (
                        <Button variant="secondary" icon={Check} onClick={() => run("Marked as sent by you", async () => {
                          await api(`/api/auto-reply-logs/${activeLog.id}/sent-by-me`, { method: "POST", body: { workspaceId } });
                        })}>
                          I sent it myself
                        </Button>
                      ) : null}
                    </div>
                  )}
                </ActionBar>

                {/* 2026-09-28 — the owner's mark on a reply the AI sent by itself. */}
                <AutoReplyMark log={activeLog} run={run} reload={reload} />

                {/* 2026-08-05 (UX Fix 1) — internal note. The operator can
                    scribble "Called Priya, wants 500kg" without leaving the
                    reply thread. Not customer-facing. Persists on the log. */}
                <div className="mt-4 rounded-lg border border-border-default bg-surface-tint/50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">📝 Internal note (only you &amp; your team see this)</p>
                    {noteSaved === activeLog.id && <span className="text-xs text-success-fg">✓ Saved</span>}
                  </div>
                  <textarea
                    className="mt-2 w-full resize-y rounded border border-border-default bg-background px-3 py-2 text-sm"
                    rows={2}
                    placeholder="e.g. Called customer, wants 500kg at ₹42/kg. Follow up next week."
                    value={noteEdits[activeLog.id] ?? activeLog.internalNote ?? ""}
                    onChange={(e) => setNoteEdits((prev) => ({ ...prev, [activeLog.id]: e.target.value }))}
                    onBlur={() => {
                      const note = (noteEdits[activeLog.id] ?? "").trim();
                      if (activeLog.internalNote !== note && (note || activeLog.internalNote)) {
                        run("Save note", async () => {
                          await api(`/api/auto-reply-logs/${activeLog.id}/note`, { method: "POST", body: { workspaceId, note } });
                          setNoteSaved(activeLog.id);
                          setTimeout(() => setNoteSaved(null), 2000);
                          reload?.();
                        });
                      }
                    }}
                  />
                </div>

              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center">
            <Inbox className="h-12 w-12 text-border-default" />
            <p className="mt-4 text-lg font-medium text-muted-2">No reply selected</p>
            <p className="mt-1 text-sm text-muted">Select a reply from the left to review or simulate a new one.</p>
          </div>
        )}
      </div>

      {/* Cluster G fix (2026-07-21 session 19): migrated from bespoke overlay
          to the <Modal> primitive — gets role="dialog", aria-modal, Escape
          to close, focus trap, focus restore, body-scroll lock, click-
          outside. The old version had NONE of these (audit P1 finding U4). */}
      <Modal
        open={simulateModalOpen}
        disableDismiss={simulateBusy}
        onClose={() => { if (simulateBusy) return; simulateRequest.current++; setSimulateModalOpen(false); setSimulateResult(null); }}
        title="Simulate Reply"
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="simulate-lead-select">Select Lead</label>
            <select id="simulate-lead-select" className="input" disabled={simulateBusy} value={simulateLeadId} onChange={(e) => { simulateRequest.current++; setSimulateLeadId(e.target.value); setSimulateResult(null); }}>
              {leads.map(l => <option key={l.id} value={l.id}>{l.companyName || l.contactName || "Unnamed prospect"}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="simulate-message-input">Simulated Message</label>
            <textarea id="simulate-message-input" className="input min-h-24" disabled={simulateBusy} value={simulateText} onChange={(e) => { simulateRequest.current++; setSimulateText(e.target.value); setSimulateResult(null); }} placeholder="Type a sample message from this lead..." />
          </div>
          {simulateResult && (
            <div className="rounded-md border border-border-default bg-surface-muted p-3 text-sm">
              <p className="font-semibold text-foreground">Result</p>
              <p className="mt-1 text-muted-2"><strong>Decision:</strong> {simulateResult.blocked ? "Blocked" : simulateResult.needsHumanReview ? "Held for your review" : "Could be sent automatically"}</p>
              <p className="mt-1 text-muted-2"><strong>Reason:</strong> {String(simulateResult.reason || "Safety gates applied.")}</p>
              <p className="mt-1 text-muted-2"><strong>Draft:</strong> {String(simulateResult.suggestedReply || "No draft returned.")}</p>
              {/* 2026-09-25 — a simulation saves nothing now; say so, and say
                  what a real message would have changed. */}
              {simulateResult.dryRun ? (() => {
                const would = (simulateResult.wouldHave || {}) as Record<string, unknown>;
                const effects = [
                  would.queuedDraftForApproval ? "put a draft in AI Drafts for your approval" : "",
                  would.openedTicket ? "opened a ticket" : "",
                  would.askedYouAQuestion ? "asked you a question in Needs you" : "",
                  would.addedToDoNotContact ? "added this contact to your do-not-contact list" : "",
                  would.changedLeadStatus ? `moved the lead to "${displayLabel(String(would.changedLeadStatus))}"` : "",
                ].filter(Boolean);
                return (
                  <p className="mt-2 rounded-md bg-info-bg px-2 py-1.5 text-xs text-info-fg">
                    Test only — nothing was saved or sent.{effects.length ? ` A real message like this would have ${effects.join(", ")}.` : ""}
                  </p>
                );
              })() : null}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-4 border-t border-border-default">
            <button className="btn secondary" disabled={simulateBusy} onClick={() => { simulateRequest.current++; setSimulateModalOpen(false); setSimulateResult(null); }}>Close</button>
            <Button loading={simulateBusy} onClick={async () => {
              const request = ++simulateRequest.current;
              setSimulateBusy(true);
              setSimulateResult(null);
              try {
                await run("Simulate Reply", async () => {
                  const res = await api<Record<string, unknown>>("/api/whatsapp-agent/dry-run", { method: "POST", body: { workspaceId, leadId: simulateLeadId, rawText: simulateText } });
                  if (request === simulateRequest.current) setSimulateResult(res);
                });
              } finally { setSimulateBusy(false); }
            }}><Sparkles className="h-4 w-4" /> Run Simulation</Button>
          </div>
        </div>
      </Modal>

      {/* CP-22 Feature B — customer profile popup. Click the customer name in
          the reply detail → this modal shows the full Company snapshot (the
          same fields as the CRM detail): company, industry, buyer type,
          location, phone, email, WhatsApp, score, status. One click, full
          picture, close → back to the reply. */}
      <Modal open={Boolean(profileLead)} onClose={() => setProfileLead(null)} title="Customer profile">
        {profileLead ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div><span className="text-muted">Company:</span> <span className="font-medium">{profileLead.companyName || "Unnamed prospect"}</span></div>
              <div><span className="text-muted">Industry:</span> <span className="font-medium">{profileLead.industry || "—"}</span></div>
              <div><span className="text-muted">Buyer type:</span> <span className="font-medium">{profileLead.buyerType || "—"}</span></div>
              <div><span className="text-muted">Location:</span> <span className="font-medium">{[profileLead.city, profileLead.country].filter(Boolean).join(", ") || "—"}</span></div>
              <div><span className="text-muted">Email:</span> <span className="font-medium">{profileLead.email || "Missing"}</span></div>
              <div><span className="text-muted">Phone:</span> <span className="font-medium">{profileLead.phone || "Missing"}</span></div>
              <div><span className="text-muted">WhatsApp:</span> <span className="font-medium">{profileLead.whatsappNumber || "—"}</span></div>
              <div><span className="text-muted">Score:</span> <span className="font-medium">{leadScoreText(profileLead)}</span></div>
              <div><span className="text-muted">Status:</span> <span className="font-medium">{displayLeadStatus(profileLead.status)}</span></div>
              <div><span className="text-muted">Review:</span> <span className="font-medium">{displayReviewStatus(profileLead.reviewStatus)}</span></div>
            </div>
            {profileLead.fitReason ? <p className="text-xs text-muted-2 border-t border-border-default pt-2">{profileLead.fitReason}</p> : null}
            {/* 2026-08-05 N-P1-3: was a dead-end (only Close). Now offers the
                same cross-entity jumps the CRM drawer has, so an operator
                triaging a reply can act in one click. */}
            {onFocusLead && profileLead.reviewStatus === "approved" && (
              <div className="flex flex-wrap gap-2 border-t border-border-default pt-2">
                <Button size="sm" variant="secondary" icon={ShoppingBag} onClick={() => { onFocusLead(profileLead.id, "commercial"); setProfileLead(null); }}>Quotes &amp; orders</Button>
                <Button size="sm" variant="secondary" icon={TicketIcon} onClick={() => { onFocusLead(profileLead.id, "tickets"); setProfileLead(null); }}>Tickets</Button>
                <Button size="sm" variant="secondary" icon={Users} onClick={() => { onFocusLead(profileLead.id, "crm"); setProfileLead(null); }}>Full record</Button>
              </div>
            )}
            <button className="btn secondary w-full" onClick={() => setProfileLead(null)}>Close</button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export type KnowledgeDocument = { id: string; title: string; documentType: string; source?: string; status: string; contentText: string; updatedAt: string; metadata?: Record<string, unknown> };
type AutoReplyLogItem = { id: string; replyId?: string; incomingMessage: string; classification?: string; generatedReply?: string; confidenceScore?: number; canAutoSend: boolean; needsHumanReview: boolean; reason?: string; status: string; leadId?: string; createdAt: string; updatedAt: string; sendAttempted?: boolean; sendStatus?: string; providerMessageId?: string; providerError?: string; mediaAttachmentId?: string; mediaAttachmentUrl?: string; mediaAttachmentName?: string; retrievedContext?: { source?: string; ticketId?: string; confidenceScore?: number; chunks?: Array<{ id?: string; score?: number; documentTitle?: string; chunkText?: string }> }; modelMode?: "real" | "mock" | "fallback" | "unknown"; fallbackUsed?: boolean; modelProvider?: string; modelName?: string; internalNote?: string; ownerVerdict?: "looked_fine" | "should_not_have_sent" };

function normalizeAutoReplyLog(log: AutoReplyLog): AutoReplyLogItem {
  const retrievedContext = log.retrievedContext && typeof log.retrievedContext === "object" && !Array.isArray(log.retrievedContext)
    ? log.retrievedContext as AutoReplyLogItem["retrievedContext"]
    : undefined;
  return { ...log, status: String(log.status), retrievedContext };
}

// Tone -> Tailwind. The ONLY place a reply badge gets a colour, so "success
// green" cannot be reached except through a tone of "success", which
// replyDeliveryState() hands out only for a message that really was delivered.
const REPLY_TONE_CLASS: Record<ReplyDeliveryTone, string> = {
  success: "bg-success-bg text-success-fg",
  warning: "bg-warning-bg text-warning-fg",
  danger: "bg-danger-bg text-danger-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-border-subtle text-muted-2",
};

// Some rows carry compound status strings (test fixtures, prefixed codes).
// Fold them onto the canonical status before asking the chokepoint, so the
// chokepoint itself stays a plain exhaustive mapping.
function canonicalReplyStatus(status: string): string {
  if (status.includes("held_for_review")) return "held_for_review";
  if (status.includes("test_only_")) return "drafted";
  if (status.includes("blocked")) return "blocked";
  return status;
}

function replyStatusDisplay(log: AutoReplyLogItem) {
  // 2026-08-05 V-P1-3: success states use success-green (was indigo/neutral,
  // which made a successfully-sent reply look identical to a neutral draft).
  // 2026-08-20 N-UX-4: and the reverse defect — four send outcomes
  // (dry_run / blocked / not_attempted / absent) fell through to
  // "Approved - Manual Send" in that SAME success green, so a message the
  // customer never received was indistinguishable from one that arrived.
  // Both the words and the colour now come from replyDeliveryState().
  const state = replyDeliveryState({ ...log, status: canonicalReplyStatus(log.status) });
  // 2026-07-26 Session 4 audit fix (P3-DISPLAY-1): unknown status codes route
  // through the displayLabel chokepoint (sentence case, uppercase preservation)
  // instead of raw `.replace(/_/g, " ")`, which produced lowercase output.
  const label = state.label || displayLabel(log.status);
  return { label, className: REPLY_TONE_CLASS[state.tone], delivered: state.delivered, explanation: state.explanation };
}

function sendStatusText(log: AutoReplyLogItem) {
  // N-UX-4: same single source of truth as the badge, so the sentence under
  // "WhatsApp send status" can never contradict the colour beside it. The old
  // version said "Approved and recorded for manual sending" for a blocked send
  // that no one had recorded or sent.
  return replyDeliveryState({ ...log, status: canonicalReplyStatus(log.status) }).explanation;
}
type AgentContextSummary = {
  profileReady: boolean;
  salesReady: boolean;
  productsReady: boolean;
  policyReady: boolean;
  communicationReady: boolean;
  syncedKnowledgeReady: boolean;
  answerCount: number;
  chunkCount: number;
  conflictsPending: number;
  lastSyncedAt?: string;
  preview: {
    sales: string;
    products: string;
    policy: string;
    communication: string;
    knowledge: string;
  };
};
type LeadAgentActionPlan = {
  leadId: string;
  leadName: string;
  recommendation: string;
  confidenceScore: number;
  reasons: string[];
  nextSteps: string[];
  draftMessage: string;
  missingInformation: string[];
  humanReviewRequired: boolean;
  safetyNote: string;
  contextStatus: AgentContextSummary;
  modelStatus: {
    agentName: string;
    provider: string;
    modelName: string;
    slotId?: string;
    mode: "real" | "mock" | "fallback";
    fallbackUsed: boolean;
    routeSource?: string;
    runId?: string;
    warning?: string;
  };
};

function AIReviewQueue({ run, leads, setActive }: { run: Runner; leads: Lead[]; setActive: (tab: TabId) => void }) {
  const [items, setItems] = useState<AutoReplyLogItem[]>([]);
  // Cluster 5 P1-10: load-error state.
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() {
    setLoadError(null);
    setItems(await api<AutoReplyLogItem[]>("/api/auto-reply-logs"));
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load AI review queue")); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  if (loadError) {
    return (
      <Card title="AI review queue" icon={ShieldCheck}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={loadError}
          action={<Button onClick={() => load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load AI review queue"))}>Try again</Button>}
        />
      </Card>
    );
  }
  return (
    <Panel title="AI review queue" icon={ShieldCheck}>
      {/* 2026-08-20 N-UX-5 (safety): this line used to read "Approving here does
          not send WhatsApp yet; it only records your review decision." That was
          true before the send path was wired and false afterwards — Approve calls
          approveAutoReplyLog, which sends through Meta (proven end to end by
          golden-whatsapp-outbound-send). The operator was told the button was
          inert while it messaged their customer. Never describe a send button as
          inert; if delivery is conditional, say what the conditions are. */}
      <p className="text-sm text-muted-2"><strong className="text-foreground">Approving sends this reply to the customer on WhatsApp.</strong> If WhatsApp is not connected, or the 24-hour reply window has closed with no template chosen, the draft is still marked approved but nothing is delivered — the card will say so.</p>
      <div className="mt-4 space-y-3">
        {/* 2026-08-05 audit fix (F-UI-22): two bugs in the old render —
            (a) raw snake_case classification/status leaked to the operator
            (held_for_review, price_request); now routed through displayLabel.
            (b) the "queue" included already-approved/rejected/auto_sent items
            despite the intro promising "drafts that need approval"; now
            filtered to the genuinely-pending statuses. */}
        {(() => {
          const leadById = new Map(leads.map((l) => [l.id, l]));
          const PENDING = new Set(["held_for_review", "drafted", "failed", "blocked"]);
          const pending = items.filter((i) => PENDING.has(i.status));
          // 2026-09-25 — every card used to look identical, so a draft that CAN
          // be sent and one that never can (no contact on file, or blocked) read
          // the same. The left edge and the pill now say which is which.
          const contactFor = (item: typeof pending[number]) => {
            const lead = item.leadId ? leadById.get(item.leadId) : undefined;
            return lead?.whatsappNumber || lead?.phone || lead?.email || "";
          };
          return pending.length ? pending.map((item) => {
          const deliverable = Boolean(contactFor(item)) && item.status !== "blocked";
          return (
          <div key={item.id} className={`rounded-xl border border-l-4 border-border-default bg-surface p-4 shadow-sm ${deliverable ? "border-l-warning-fg" : "border-l-danger-fg"}`}>
            {/* 2026-08-20 N-UX-6: the card asked the operator to approve a real
                send without ever naming who receives it. leadId was already on
                the log; only the lookup was missing. */}
            {(() => {
              const lead = item.leadId ? leadById.get(item.leadId) : undefined;
              const to = contactFor(item);
              return (
                <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border-subtle pb-2">
                  <span className="text-sm font-semibold text-foreground">{lead?.companyName || (item.leadId ? "Unknown lead" : "No lead linked")}</span>
                  {lead?.contactName ? <span className="text-xs text-muted">{lead.contactName}</span> : null}
                  {to ? <span className="text-xs text-muted-2">&rarr; {to}</span> : <span className="text-xs text-danger-fg">no contact on file &mdash; this cannot be delivered</span>}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-muted">{displayReplyClassification(item.classification || "")}</span>
                    <Badge tone={deliverable ? "warning" : "danger"}>{deliverable ? "Waiting for you" : "Can't be sent"}</Badge>
                  </span>
                </div>
              );
            })()}
            {/* 2026-08-02 (UI polish) — customer message + AI draft now render as
                a mini conversation (matching the Replies page pattern), not a
                flat list with a monospace <pre> for the draft. */}
            <div className="mt-3 flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border-default bg-surface-muted px-3 py-2 text-sm text-foreground">
                {item.incomingMessage}
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-primary/30 bg-primary-tint px-3 py-2 text-sm text-foreground">
                {item.generatedReply || <span className="text-muted italic">No draft generated</span>}
              </div>
            </div>
            {item.reason ? <p className="mt-2 text-xs text-muted">⚠ {item.reason}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
              <button className={deliverable ? "btn" : "btn secondary"} onClick={() => run("Approve AI draft", async () => { await api(`/api/auto-reply-logs/${item.id}/approve`, { method: "POST", body: { workspaceId, body: item.generatedReply } }); await load(); })}>Approve draft</button>
              <button className="btn secondary" onClick={() => run("Reject AI draft", async () => { await api(`/api/auto-reply-logs/${item.id}/reject`, { method: "POST", body: { workspaceId } }); await load(); })}>Reject</button>
            </div>
          </div>
          );
        }) : (
            /* N-UX-11 (2026-09-03) — this empty state used to be a sentence
               with no controls at all: it told the operator what WOULD create
               drafts and then left them on a screen with nothing to press. An
               empty state that describes a future event is a dead end; it has
               to offer the thing a person would reasonably do next.

               Two doors, because there are two reasons this screen is empty:
               nothing has come in yet (go and look at the conversations), or
               the AI is not permitted to draft anything (go and check what it
               is allowed to do). */
            <EmptyState
              icon={ShieldCheck}
              title="No drafts waiting for you"
              description="When the AI writes a reply it is not allowed to send on its own, it will appear here for your approval."
              action={(
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => setActive("replies")}>See customer replies</Button>
                  <Button variant="secondary" onClick={() => setActive("whatsapp")}>Check what the AI may send</Button>
                </div>
              )}
            />
          );
        })()}
      </div>
    </Panel>
  );
}

/**
 * 2026-09-25 — replaces "Developer diagnostics", which printed two API paths
 * and a terminal command to a business owner. The same server check
 * (health/deep, owner/admin only) now answers the questions an owner has, in
 * words, with a green or amber mark. If the check cannot be read (a member
 * without access, or the server down) the panel says so instead of guessing.
 */
/** A notice that only repeats a success toast or says nothing (see the header pill). */
function isQuietNotice(notice: string) {
  return notice === "Ready"
    || / completed$/.test(notice)
    || /^(Demo workspace opened|Welcome, |Owner account created|You have been signed out)/.test(notice);
}

function SettingsCenter({ state, setActive, onLogout }: { state: DashboardState | null; setActive: (tab: TabId) => void; onLogout: () => void }) {
  // N-BUG (2026-09-08). Every row of the panel below was a hardcoded string:
  // "Demo Owner", "Demo mode — no password needed", "Not switched on yet",
  // "A file on this machine". On the live deployment four of the five were
  // false — the owner had signed in with a real password, as themselves, on a
  // workspace whose data is in Postgres. This is the one screen whose entire
  // job is telling an owner how their workspace is set up, and it was telling
  // them about a different one. The facts are one fetch away, so ask.
  const [account, setAccount] = useState<{ authMode?: string; authenticated?: boolean; user?: { name?: string; email?: string; role?: string } } | null>(null);
  const [storage, setStorage] = useState<string>("");
  useEffect(() => {
    // Silent on failure: an unreadable answer must fall back to "not known",
    // never to a confident wrong one. That confidence is the bug.
    api<{ authMode?: string; authenticated?: boolean; user?: { name?: string; email?: string; role?: string } }>("/api/auth/status")
      .then(setAccount).catch(() => setAccount(null));
    api<{ persistenceProvider?: string }>("/api/health")
      .then((health) => setStorage(String(health?.persistenceProvider || ""))).catch(() => setStorage(""));
  }, []);
  const signedInUser = account?.user;
  // 2026-08-02 (UX redesign Phase 6): grouped IA. Research (memorable.design
  // SaaS settings): modern settings surfaces group by concern with clear
  // section headers, not a flat 15-card wall. Each group matches how the owner
  // thinks about their work (Identity / AI / Connections / Trust & data).
  // Routing is unchanged — each card still opens the real page where that
  // concern lives; only the grouping/headers are new.
  // 2026-09-29 (owner walk-through W2): the card texts were written while the
  // product was being built ("Production login is pending", "Docs live in the
  // repository", "Future WhatsApp, Gmail…", "Export local demo workspace JSON").
  // An owner read them as an unfinished product. Each card now says what the
  // owner can do there, in their words; the builder-only diagnostics card
  // (Jobs / Events) is gone from the owner's settings.
  // 2026-09-30 (page guide, redesign round 2): this screen used to be a hub —
  // an account panel, a "who can do what" table, a "What's connected" box and
  // thirteen cards that each said "Open" and repeated a menu item — with the
  // business rules buried in the middle. The page guide scored it "confusing".
  // It is now the business rules the AI follows, with the account in one small
  // card at the end. The "What's connected" box is gone: it read the server's
  // health check, so it said "WhatsApp: Not connected" while this company's own
  // saved WhatsApp details were working. Integrations is the one place for that.
  const elsewhere: Array<[string, TabId]> = [
    ["Products and prices", "catalogue"],
    ["WhatsApp and other connections", "integrations"],
    ["Team, working hours and holidays", "workspace"],
    ["Which AI does what", "ai"],
  ];
  return (
    <div className="space-y-6">
      <StructuredSettingsPanel />
      <div className="grid gap-4 lg:grid-cols-2">
        {/* 2026-09-04 N-UX-25 — facts about this account, from the server, never hardcoded. */}
        <Panel title="Your account" icon={Settings}>
          <ProfileRows items={accountSummaryRows({
            authMode: account?.authMode,
            user: signedInUser,
            loaded: Boolean(account),
            persistenceProvider: storage,
            workspaceName: state?.workspace?.name,
            formatRole: displayLabel,
          })} />
          <button className="btn secondary mt-4" onClick={onLogout}><LogOut className="h-4 w-4" /> Sign out</button>
        </Panel>
        <Panel title="Looking for something else?" icon={Compass}>
          <ul className="divide-y divide-border-subtle">
            {elsewhere.map(([label, target]) => (
              <li key={target}>
                <button type="button" className="flex w-full items-center justify-between py-2.5 text-left text-sm font-medium text-foreground hover:text-primary" onClick={() => setActive(target)}>
                  {label} <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}


// N-AI-14 (2026-08-27): the starting text for an agent that has no saved
// workspace instructions yet. Named, so the screen can tell the difference
// between "this is your saved text" and "this is a suggestion".

function ExportBackup({ run }: { run: Runner }) {
  const [exportText, setExportText] = useState("");
  // Session 55: restore and reset both existed only as a sentence saying they
  // did not exist. Both are destructive, so both make the operator type the
  // word rather than clicking a button they could hit by accident.
  const [resetConfirm, setResetConfirm] = useState("");
  const [restoreFile, setRestoreFile] = useState<{ name: string; json: unknown } | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [dataMessage, setDataMessage] = useState("");
  const [dataError, setDataError] = useState("");
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const restoreReadRequest = useRef(0);
  return (
    <Grid>
      {/* 2026-09-04 N-UX-30 — the panel title repeated the page heading
          ("Export a backup" / "Data export / backup"), and the disabled
          "Restore later" button said nothing about why it was disabled or what
          it would eventually do — a dead control is worse than no control,
          because the reader spends attention working out that it is dead. */}
      <Panel title="Take a copy now" icon={Download}>
        <p className="text-sm text-muted-2">Download a copy of the supported company records. Passwords, connection keys, uploaded file contents and Assistant job history are not included. For complete recovery, use the database backup.</p>
        <button className="btn mt-4" onClick={() => run("Export workspace backup", async () => {
          const payload = await api<Record<string, unknown>>("/api/data/export");
          const text = JSON.stringify(payload, null, 2);
          setExportText(text);
          const blob = new Blob([text], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "leadcockpit-workspace-backup.json";
          link.click();
          URL.revokeObjectURL(url);
        })}><Download className="h-4 w-4" /> Download a copy</button>
        <p className="mt-3 text-xs text-muted">Saved credentials are stripped from the file, so integrations have to be reconnected after a restore.</p>
      </Panel>
      <Panel title="Export preview" icon={FileText}>
        {exportText ? <ProfileRows items={{
          "Export ready": "Redacted JSON backup prepared",
          "File download": "Started automatically",
          "Size": `${Math.round(exportText.length / 1024)} KB`,
        }} /> : <Empty text="Run export to prepare a redacted backup. Raw JSON is downloaded, not shown here." />}
      </Panel>

      <Panel title="Load a backup back in" icon={Upload}>
        <p className="text-sm text-muted-2">
          Replaces the supported company records with the contents of a backup
          file. Files missing from storage cannot be recovered from this copy. If the
          restore cannot finish completely, your previous records are kept. People who asked never to be contacted stay on the do-not-contact
          list either way — a restore adds to that list, it never shortens it.
        </p>
        <input
          ref={restoreInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (event) => {
            const request = ++restoreReadRequest.current;
            const file = event.target.files?.[0];
            setRestoreConfirm("");
            setRestoreFile(null);
            event.target.value = "";
            if (!file) return;
            setDataError("");
            setDataMessage("");
            try {
              const json: unknown = JSON.parse(await file.text());
              if (request === restoreReadRequest.current) setRestoreFile({ name: file.name, json });
            } catch {
              if (request !== restoreReadRequest.current) return;
              setRestoreFile(null);
              setDataError(`${file.name} is not readable JSON.`);
            }
          }}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={Upload} onClick={() => restoreInputRef.current?.click()}>Choose a backup file</Button>
          {restoreFile ? <span className="text-sm text-muted">{restoreFile.name}</span> : null}
        </div>
        {restoreFile ? (
          <div className="mt-3 space-y-2">
            <Field label={'Type RESTORE to confirm'} value={restoreConfirm} onChange={setRestoreConfirm} />
            <Button
              variant="danger"
              disabled={restoreConfirm !== "RESTORE"}
              onClick={() => run("Restore workspace from backup", async () => {
                const result = await api<{ restoredRows: number; ignoredKeys: string[] }>("/api/data/restore", {
                  method: "POST",
                  body: { workspaceId, confirm: "RESTORE", backup: restoreFile.json },
                });
                setDataMessage(`Restored ${result.restoredRows} record${result.restoredRows === 1 ? "" : "s"}${result.ignoredKeys?.length ? `. ${result.ignoredKeys.length} unrecognised section(s) in the file were ignored.` : "."}`);
                setRestoreFile(null);
                setRestoreConfirm("");
                return result;
              })}
            >
              Restore this workspace
            </Button>
          </div>
        ) : null}
      </Panel>

      <Panel title="Empty this workspace" icon={Trash2}>
        <p className="text-sm text-muted-2">
          Deletes every lead, conversation, ticket, quote, order and knowledge
          document in this workspace. Your account, your team and the
          do-not-contact list are kept. Take a copy first — this cannot be
          undone.
        </p>
        <div className="mt-4 space-y-2">
          <Field label={'Type RESET to confirm'} value={resetConfirm} onChange={setResetConfirm} />
          <Button
            variant="danger"
            disabled={resetConfirm !== "RESET"}
            onClick={() => run("Empty this workspace", async () => {
              const result = await api<{ removedRows: number }>("/api/data/reset", {
                method: "POST",
                body: { workspaceId, confirm: "RESET" },
              });
              setDataMessage(`Removed ${result.removedRows} record${result.removedRows === 1 ? "" : "s"}. The do-not-contact list was kept.`);
              setResetConfirm("");
              return result;
            })}
          >
            Empty this workspace
          </Button>
        </div>
      </Panel>

      {dataMessage ? <p className="rounded-md bg-surface-tint p-3 text-sm text-primary-strong">{dataMessage}</p> : null}
      {dataError ? <p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger-fg">{dataError}</p> : null}
    </Grid>
  );
}

export function InfoMetric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "success" | "warning" }) {
  const toneClass = tone === "success" ? "border-surface-tint bg-surface-tint text-primary-strong" : tone === "warning" ? "border-warning-bg bg-warning-bg text-warning-fg" : "border-border-default bg-surface text-foreground";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <p className="text-2xl font-semibold leading-none">{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wider">{label}</p>
    </div>
  );
}


export type Runner = <T>(label: string, action: () => Promise<T>) => Promise<T | undefined>;
export type SectionProps = { profile: BusinessProfile | null; run: Runner };

// (Stage A+ / Cluster 10a) local api() + apiForm() removed — imported from
// @/lib/api-client. The shared module is the single chokepoint for all
// frontend→backend calls; the previous 6 local copies had subtle differences
// (the section versions took raw RequestInit, forcing callers to JSON.stringify
// themselves — the latent [object Object] body bug P2-3).

export function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 xl:grid-cols-2">{children}</div>;
}

function looksCompanyRelated(text: string) {
  const normalized = text.toLowerCase();
  const signals = ["company", "business", "product", "service", "catalogue", "catalog", "price", "payment", "shipping", "delivery", "return", "refund", "customer", "buyer", "wholesale", "manufacturer", "policy", "faq", "sales", "lead", "order", "sample"];
  return normalized.length > 80 && signals.some((signal) => normalized.includes(signal));
}


export function formatDate(value: string) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : formatDateShared(date);
}
