"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { Button, Card, Drawer, DrawerBody, Select, Tabs, TabPanel } from "@/components/ui";
import { api } from "@/lib/api-client";
import { displayCampaignMetric, displayLeadStatus } from "@/lib/display-labels";
import { formatDate } from "@/lib/format-date";
import type { Campaign, CampaignLearning } from "@/lib/types";
import type { CampaignAnalyticsDetails, AnalyticsMetricKey } from "@/services/CampaignAnalyticsService";
import type { Runner } from "@/app/page";

const GROUPS = [
  { id: "prospects", label: "Prospects", keys: ["totalProspectsDiscovered", "leadsApproved", "leadsRejected", "leadsEnriched"] },
  { id: "conversations", label: "Messages & replies", keys: ["messagesGenerated", "messagesMarkedSent", "repliesReceived"] },
  { id: "sales", label: "Sales progress", keys: ["interestedReplies", "mqlCount", "sqlCount", "hotLeadCount", "wonLostCount", "campaignConversionRate"] },
] as const;
type Metric = CampaignAnalyticsDetails["metrics"][number];

export function Analytics({ campaigns, initialCampaignId, chosenCampaignId, onChooseCampaign, workspaceId, run, readOnly, onOpenCustomer }: {
  campaigns: Campaign[]; initialCampaignId?: string; chosenCampaignId: string; onChooseCampaign: (id: string) => void; workspaceId: string; run: Runner; readOnly: boolean; onOpenCustomer: (id: string) => void;
}) {
  const campaignId = campaigns.some(item => item.id === chosenCampaignId) ? chosenCampaignId : initialCampaignId || campaigns[0]?.id || "";
  const [tab, setTab] = useState("analytics-results");
  const [group, setGroup] = useState("prospects");
  const [report, setReport] = useState<CampaignAnalyticsDetails | null>(null);
  const [learnings, setLearnings] = useState<CampaignLearning[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const [busy, setBusy] = useState(false);
  const [learningError, setLearningError] = useState("");
  const [metricKey, setMetricKey] = useState<AnalyticsMetricKey | null>(null);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<Metric | null>(null);
  const [detailStatus, setDetailStatus] = useState<"loading" | "ready" | "error">("loading");
  const [detailRetry, setDetailRetry] = useState(0);
  const detailRequest = useRef(0);

  useEffect(() => {
    const requests = request;
    const generation = ++requests.current;
    void Promise.resolve().then(async () => {
      if (generation !== request.current) return;
      setStatus("loading"); setReport(null); setLearnings([]); setError(""); setLearningError("");
      if (!campaignId) { setStatus("ready"); return; }
      try {
        const [next, lessons] = await Promise.all([
          api<CampaignAnalyticsDetails>(`/api/analytics/campaign/${encodeURIComponent(campaignId)}/details`),
          api<CampaignLearning[]>(`/api/analytics/campaign/${encodeURIComponent(campaignId)}/learnings`),
        ]);
        if (generation !== request.current) return;
        setReport(next); setLearnings(lessons); setStatus("ready");
      } catch (failure) {
        if (generation !== request.current) return;
        setError(failure instanceof Error ? failure.message : "Results could not be loaded."); setStatus("error");
      }
    });
    return () => { requests.current++; };
  }, [campaignId, retry]);

  useEffect(() => {
    const requests = detailRequest;
    const generation = ++requests.current;
    void Promise.resolve().then(async () => {
      if (!metricKey || !campaignId || generation !== detailRequest.current) return;
      setDetailStatus("loading"); setDetail(null);
      try {
        const next = await api<CampaignAnalyticsDetails>(`/api/analytics/campaign/${encodeURIComponent(campaignId)}/details?metric=${metricKey}&page=${page}`);
        if (generation !== detailRequest.current) return;
        setDetail(next.metrics.find(item => item.key === metricKey) || null); setDetailStatus("ready");
      } catch {
        if (generation === detailRequest.current) setDetailStatus("error");
      }
    });
    return () => { requests.current++; };
  }, [campaignId, metricKey, page, detailRetry]);

  const currentReport = report?.campaign.id === campaignId ? report : null;
  const currentLearning = [...learnings].filter(item => item.campaignId === campaignId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  function openMetric(key: AnalyticsMetricKey) { setDetailStatus("loading"); setDetail(null); setPage(1); setMetricKey(key); }
  async function generateLearning() {
    if (busy || !campaignId) return;
    const generation = request.current;
    setBusy(true); setLearningError("");
    try {
      await run("Generate campaign learning", async () => {
        try {
          const result = await api<CampaignLearning>(`/api/analytics/campaign/${encodeURIComponent(campaignId)}/generate-learning`, { method: "POST", body: { workspaceId } });
          if (generation === request.current) setLearnings(items => [...items, result]);
          return result;
        } catch (failure) {
          if (generation === request.current) setLearningError(failure instanceof Error ? failure.message : "The lesson was not created. Try again.");
          throw failure;
        }
      });
    } finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <Card>
      <Select label="Campaign to review" value={campaignId} disabled={busy || !campaigns.length}
        options={[...campaigns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => ({ value: item.id, label: item.name }))}
        onChange={value => { onChooseCampaign(value); setStatus("loading"); setMetricKey(null); setDetail(null); }} />
      <p className="mt-3 text-sm text-muted">All-time results for this campaign in your company. Click a number to see the records behind it.</p>
      {currentReport && <p className="mt-2 text-sm text-muted">Target customer type: <span className="font-medium text-foreground">{currentReport.campaign.customerType}</span></p>}
    </Card>
    {!campaignId ? <Card title="No campaigns yet"><p className="text-sm text-muted">Create a campaign first. Results appear as prospects, drafts and replies are recorded.</p></Card>
      : status === "loading" || (status === "ready" && !currentReport) ? <p role="status" className="text-sm text-muted">Loading this campaign&apos;s results…</p>
      : status === "error" ? <Card title="Results could not be loaded"><p role="alert" className="text-sm text-danger-fg">{error}</p><Button variant="secondary" className="mt-3" onClick={() => setRetry(value => value + 1)}>Retry results</Button></Card>
      : currentReport && <>
        <Tabs tabs={[{ id: "analytics-results", label: "Results" }, { id: "analytics-lessons", label: "Lessons & next steps" }]} activeTab={tab} onSelect={setTab} />
        <TabPanel tabId="analytics-results" hidden={tab !== "analytics-results"}>
          <Tabs tabs={GROUPS.map(item => ({ id: `analytics-${item.id}`, label: item.label }))} activeTab={`analytics-${group}`} onSelect={id => setGroup(id.replace("analytics-", ""))} />
          {GROUPS.map(section => <TabPanel key={section.id} tabId={`analytics-${section.id}`} hidden={group !== section.id}>
            <div className={`grid gap-3 md:grid-cols-2 ${section.keys.length === 4 ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
              {section.keys.map(key => {
                const metric = currentReport.metrics.find(item => item.key === key);
                if (!metric) return null;
                const label = displayCampaignMetric(key);
                return <button key={key} type="button" onClick={() => openMetric(key)} aria-label={`${label.label}: ${metric.value}${label.suffix || ""} — view records`}
                  className="rounded-lg border border-border-default bg-surface p-4 text-left transition-colors hover:border-primary focus-visible:outline-primary">
                  <span className="text-sm font-medium text-foreground">{label.label}</span>
                  <span className="my-2 block text-3xl font-semibold text-foreground">{metric.value}{label.suffix || ""}</span>
                  <span className="block text-xs text-muted">{metric.explanation}</span>
                  <span className="mt-3 flex items-center text-xs font-medium text-primary">View records <ChevronRight className="ml-1 h-3 w-3" /></span>
                </button>;
              })}
            </div>
          </TabPanel>)}
          <details className="mt-4 rounded-lg border border-border-default bg-surface p-4 text-sm text-muted">
            <summary className="cursor-pointer font-medium text-foreground">What can this report tell me?</summary>
            <p className="mt-3">Use prospect review to check who is ready for contact, messages and replies to inspect recorded conversations, and sales progress to choose customers to follow up with.</p>
            <p className="mt-2">Customer type is this campaign&apos;s target, not a winning customer comparison. Source and channel winners are not measured here. Drafts are not sent messages, and several replies from one customer count as several reply records.</p>
          </details>
        </TabPanel>
        <TabPanel tabId="analytics-lessons" hidden={tab !== "analytics-lessons"}>
          <Card title="What this campaign taught us" icon={Sparkles}>
            <p className="mb-4 text-sm text-muted">AI suggestions are separate from the measured results. Creating a lesson uses your configured AI service.</p>
            {currentLearning ? <div className="space-y-4"><p className="text-sm text-foreground">{currentLearning.summary}</p>
              <LearningList title="What worked" items={currentLearning.winningPatterns} /><LearningList title="What didn't" items={currentLearning.losingPatterns} /><LearningList title="Do this next" items={currentLearning.recommendedNextSteps} />
              <p className="text-xs text-muted">Worked out on {formatDate(currentLearning.createdAt)}.</p></div>
              : <p className="text-sm text-muted">No lesson has been created for this campaign yet. You can still inspect every measured result in the Results tab.</p>}
            {learningError && <p role="alert" className="mt-3 text-sm text-danger-fg">{learningError}</p>}
            <Button className="mt-4" disabled={readOnly} loading={busy} onClick={() => void generateLearning()}>{currentLearning ? "Work it out again" : "Work out the lesson"}</Button>
          </Card>
        </TabPanel>
      </>}
    <Drawer open={Boolean(metricKey)} onOpenChange={open => { if (!open) setMetricKey(null); }} title={metricKey ? displayCampaignMetric(metricKey).label : "Result details"} description="The saved records and calculation behind this campaign result." size="xl">
      <DrawerBody>
        <p className="mb-4 text-sm text-muted">Viewing campaign: {campaigns.find(item => item.id === campaignId)?.name}</p>
        {detailStatus === "loading" ? <p role="status">Loading source records…</p>
          : detailStatus === "error" ? <div><p role="alert">Source records could not be loaded. The result has not been treated as empty.</p><Button variant="secondary" className="mt-3" onClick={() => setDetailRetry(value => value + 1)}>Retry source records</Button></div>
          : detail && <div className="space-y-4">
            <p className="text-3xl font-semibold">{detail.value}{metricKey && displayCampaignMetric(metricKey).suffix}</p>
            <p className="text-sm">{detail.explanation}</p><p className="text-sm text-muted">Source: {detail.source}</p>
            {detail.formula && <p className="text-sm text-muted">Calculation: {detail.formula}</p>}
            {detail.nextAction && <p className="rounded-lg bg-surface-tint p-3 text-sm">Next step: {detail.nextAction}</p>}
            {metricKey === "campaignConversionRate" && <div className="text-sm"><p>{detail.numerator} qualifying prospects out of {detail.denominator} total prospects.</p><Button variant="ghost" className="mt-2" onClick={() => openMetric("totalProspectsDiscovered")}>View all prospects in the calculation</Button></div>}
            {!detail.rows.length ? <p className="text-sm text-muted">No records meet this result&apos;s criteria for this campaign.</p> : <>
              <p className="text-xs text-muted">Showing {(page - 1) * detail.pageSize + 1}–{(page - 1) * detail.pageSize + detail.rows.length} of {detail.total} matching records.</p>
              <ul className="divide-y divide-border-default">{detail.rows.map(row => <li key={row.id} className="py-3">
                <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium">{row.name}</p>{row.status && <p className="mt-1 text-xs text-muted">{displayLeadStatus(row.status)}</p>}{row.description && <p className="mt-1 text-sm text-muted">{row.description}</p>}{row.createdAt && <p className="mt-1 text-xs text-muted">{formatDate(row.createdAt)}</p>}</div>
                  {row.leadId && <Button variant="secondary" size="sm" onClick={() => onOpenCustomer(row.leadId!)}>Open customer</Button>}</div>
              </li>)}</ul>
              <div className="flex items-center justify-between"><Button variant="secondary" disabled={page === 1} onClick={() => { setDetailStatus("loading"); setPage(value => value - 1); }}>Previous records</Button><span className="text-xs text-muted">Page {page}</span><Button variant="secondary" disabled={!detail.hasMore} onClick={() => { setDetailStatus("loading"); setPage(value => value + 1); }}>Next records</Button></div>
            </>}
          </div>}
      </DrawerBody>
    </Drawer>
  </div>;
}

function LearningList({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return <div><p className="text-sm font-semibold">{title}</p><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>;
}
