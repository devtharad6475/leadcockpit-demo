/**
 * What to find out about buyers — the owner's list (N12, 2026-09-23, session 58).
 *
 * What is worth knowing about a buyer is the OWNER'S judgement, not research:
 * two zari sellers would ask different things. The system proposes a starting
 * list so nobody faces a blank box, and the screen says plainly that it is a
 * proposal until it is saved. After that, whatever is saved stands.
 *
 * The copy is careful about one thing: the assistant LISTENS for these today and
 * does not ask about them. Promising "the AI will ask your buyers this" before
 * the asking half exists would be telling the owner something untrue about what
 * their customers see.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { Panel } from "@/components/ui/primitives";
import { ArrowDown, ArrowUp, ListChecks, Plus, Save, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { DiscoveryFact } from "@/lib/types";
import type { Runner } from "@/app/page";
import { workspaceId } from "@/app/page";

type Line = { key?: string; label: string; lookFor: string };

type ChecklistView = {
  spine: DiscoveryFact[];
  segments: Record<string, DiscoveryFact[]>;
  decided: boolean;
  buyerTypes: string[];
};

/** Mirrors DISCOVERY_MAX_FACTS_PER_LIST; the server enforces it regardless. */
const MAX_LINES = 12;

const toLines = (facts: DiscoveryFact[] = []): Line[] =>
  facts.map((fact) => ({
    key: fact.key,
    label: fact.label,
    // Shown empty when it only repeats the question, so the owner is not
    // looking at every line written twice.
    lookFor: fact.lookFor === fact.label ? "" : fact.lookFor,
  }));

export function BuyerChecklistPanel({ run }: { run: Runner }) {
  const [view, setView] = useState<ChecklistView | null>(null);
  const [spine, setSpine] = useState<Line[]>([]);
  const [segments, setSegments] = useState<Record<string, Line[]>>({});
  const [buyerType, setBuyerType] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    const loaded = await api<ChecklistView>("/api/whatsapp-agent/discovery-checklist");
    setView(loaded);
    setSpine(toLines(loaded.spine));
    setSegments(Object.fromEntries(Object.entries(loaded.segments || {}).map(([type, facts]) => [type, toLines(facts)])));
    setBuyerType((current) => current || loaded.buyerTypes[0] || "");
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch((error) => setLoadError(error instanceof Error ? error.message : "Could not load the buyer checklist."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function save() {
    run("Save what to find out about buyers", async () => {
      await api("/api/whatsapp-agent/discovery-checklist", {
        method: "PUT",
        body: { workspaceId, spine, segments },
      });
      await load();
    });
  }

  const typeChoices = [...new Set([...(view?.buyerTypes || []), ...Object.keys(segments)])].sort();

  return (
    <Panel title="What to find out about buyers" icon={ListChecks}>
      <div className="space-y-1">
        <p className="text-sm text-foreground">
          When a customer mentions one of these on WhatsApp, the assistant writes it down on their record, in their own words.
        </p>
        <p className="text-xs text-muted">
          It listens for these today. It does not ask customers about them yet — that comes once you have seen what it
          picks up.
        </p>
      </div>

      {loadError ? <p className="mt-3 text-sm text-danger-fg">{loadError}</p> : null}

      {view ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">For every buyer</h4>
            {view.decided ? (
              <Badge tone="success">Your list</Badge>
            ) : (
              <Badge tone="warning">Suggested — becomes yours when you save</Badge>
            )}
          </div>
          <LineEditor lines={spine} onChange={setSpine} idPrefix="spine" emptyText="Nothing here. Saved like this, the assistant will not listen for anything about buyers." />

          <div className="mt-6 border-t border-border-default pt-4">
            <h4 className="text-sm font-semibold text-foreground">Extra, for one kind of buyer</h4>
            <p className="mt-1 text-xs text-muted">
              A trader and an exporter are different conversations. Lines here apply only to buyers of that type, on top of
              the list above.
            </p>
            {typeChoices.length ? (
              <>
                <label className="mt-3 block max-w-xs">
                  <span className="label">Buyer type</span>
                  <select className="input" value={buyerType} onChange={(event) => setBuyerType(event.target.value)}>
                    {typeChoices.map((type) => (
                      <option key={type} value={type}>
                        {type}
                        {segments[type]?.length ? ` (${segments[type].length})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {buyerType ? (
                  <LineEditor
                    lines={segments[buyerType] || []}
                    onChange={(lines) => setSegments({ ...segments, [buyerType]: lines })}
                    idPrefix={`segment-${buyerType}`}
                    emptyText="No extra lines for this buyer type — they get the list above."
                  />
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-2">None of your leads has a buyer type yet, so there is nothing to split by.</p>
            )}
          </div>

          <div className="mt-5">
            <Button icon={Save} onClick={save}>Save</Button>
          </div>
        </>
      ) : !loadError ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : null}
    </Panel>
  );
}

function LineEditor({ lines, onChange, idPrefix, emptyText }: { lines: Line[]; onChange: (lines: Line[]) => void; idPrefix: string; emptyText: string }) {
  const update = (index: number, patch: Partial<Line>) =>
    onChange(lines.map((line, n) => (n === index ? { ...line, ...patch } : line)));
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= lines.length) return;
    const next = [...lines];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="mt-3 space-y-2">
      {lines.length === 0 ? (
        <p className="text-xs text-muted-2">{emptyText}</p>
      ) : null}
      {lines.map((line, index) => (
        <div key={line.key || `${idPrefix}-new-${index}`} className="rounded-lg border border-border-default bg-surface p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <input
                className="input"
                aria-label={`What to find out, line ${index + 1}`}
                placeholder="What do you want to find out?"
                maxLength={80}
                value={line.label}
                onChange={(event) => update(index, { label: event.target.value })}
              />
              <input
                className="input text-xs"
                aria-label={`How you would recognise it, line ${index + 1}`}
                placeholder="How you would recognise it in what they say (optional)"
                maxLength={200}
                value={line.lookFor}
                onChange={(event) => update(index, { lookFor: event.target.value })}
              />
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <Button type="button" variant="ghost" size="sm" icon={ArrowUp} aria-label={`Move line ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} />
              <Button type="button" variant="ghost" size="sm" icon={ArrowDown} aria-label={`Move line ${index + 1} down`} disabled={index === lines.length - 1} onClick={() => move(index, 1)} />
            </div>
            <Button type="button" variant="ghost" size="sm" icon={X} aria-label={`Remove line ${index + 1}`} onClick={() => onChange(lines.filter((_, n) => n !== index))} />
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={Plus}
        disabled={lines.length >= MAX_LINES}
        title={lines.length >= MAX_LINES ? `Up to ${MAX_LINES} lines — each one is checked in every conversation.` : undefined}
        onClick={() => onChange([...lines, { label: "", lookFor: "" }])}
      >
        Add a line
      </Button>
    </div>
  );
}
