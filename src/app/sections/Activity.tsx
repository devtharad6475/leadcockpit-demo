/**
 * Activity — "who did what" (2026-09-28, feature book #14). Owner/admin only.
 * Every sentence is built on the server (ActivityLogService); this screen only
 * shows them and offers three filters. Rules: docs/LOGIC.md ACTIVITY LOG.
 */
"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, Select, Spinner } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { History } from "lucide-react";
import { api } from "@/lib/api-client";
import { groupRepeats } from "@/lib/activity-groups";
import type { ActivityItem, ActivityKind, ActivityPage } from "@/services/ActivityLogService";

const KIND_LABELS: Record<ActivityKind, string> = {
  customers: "Customers",
  knowledge: "Knowledge",
  money: "Quotes & orders",
  team: "Team",
  settings: "Settings",
  other: "Other",
};
const KIND_TONES: Record<ActivityKind, BadgeTone> = {
  customers: "info",
  knowledge: "neutral",
  money: "success",
  team: "neutral",
  settings: "warning",
  other: "neutral",
};

export function ActivitySection() {
  const [who, setWho] = useState("");
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [people, setPeople] = useState<ActivityPage["people"]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async (before?: string) => {
    const request = ++requestVersion.current;
    setLoading(true);
    setError(null);
    if (!before) { setItems([]); setNextBefore(undefined); }
    try {
      const params = new URLSearchParams();
      if (who) params.set("who", who);
      if (kind) params.set("kind", kind);
      if (before) params.set("before", before);
      const page = await api<ActivityPage>(`/api/activity?${params.toString()}`);
      if (request !== requestVersion.current) return;
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setPeople(page.people);
      setNextBefore(page.nextBefore);
    } catch (e) {
      if (request === requestVersion.current) setError(e instanceof Error ? e.message : "Couldn't load the activity.");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [who, kind]);

  const invalidateRequest = useCallback(() => { ++requestVersion.current; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); invalidateRequest(); };
  }, [load, invalidateRequest]);

  const whoOptions = [
    { value: "people", label: "People only" },
    { value: "ai", label: "The AI and automatic jobs" },
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ];
  const kindOptions = (Object.keys(KIND_LABELS) as ActivityKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }));

  return (
    <section className="space-y-4" data-testid="activity">
      <div className="flex flex-wrap gap-3">
        <Select id="activity-who" label="Who" value={who} onChange={setWho} options={whoOptions} placeholder="Everyone" className="min-w-52" />
        <Select id="activity-kind" label="About" value={kind} onChange={setKind} options={kindOptions} placeholder="Everything" className="min-w-52" />
      </div>
      {error ? <div className="space-y-2"><p className="text-sm text-danger-fg" role="alert">{error}</p><Button variant="secondary" onClick={() => void load()}>Try activity again</Button></div> : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState icon={History} title="Nothing to show yet" description={who || kind ? "Nothing matches these filters. Try Everyone or Everything." : "When you, your team or the AI do something, it will be listed here."} />
      ) : null}
      {items.length > 0 ? (
        <ul className="divide-y divide-border-default rounded-md border border-border-default bg-surface">
          {groupRepeats(items).map((item) => (
            <li key={item.key} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className="w-28 shrink-0 text-xs text-muted">{item.when}</span>
              <span className="min-w-0 flex-1 text-sm text-foreground">
                <span className="font-medium">{item.who}</span> {item.what}.
                {item.times > 1 ? <span className="ml-1 text-xs text-muted">×{item.times}, since {item.earliestWhen}</span> : null}
              </span>
              <Badge tone={KIND_TONES[item.kind]}>{KIND_LABELS[item.kind]}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {loading ? <div className="flex justify-center py-4"><Spinner /></div> : null}
      {!loading && nextBefore ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => void load(nextBefore)}>Show older</Button>
        </div>
      ) : null}
    </section>
  );
}
