/**
 * What this customer has told us about their own business — the panel on a
 * lead's record (N11 listening, N12 the owner's lists, 2026-09-23).
 *
 * Three things kept apart on screen:
 *   - the FACTS, each in the customer's own words, against THIS lead's list
 *     (the owner's list, the extras for this buyer's type, and any lines added
 *     here). What is still unknown is named, not left blank — "we do not know"
 *     is something the owner acts on; an empty row is not.
 *   - lines added to this lead alone ("did the sample reach them?"), which can
 *     be added and removed right here.
 *   - the running MEMORY (N4): the AI's own prose, read before its next reply.
 *
 * The list is computed on the server. The same function decides what the
 * listening looks for, so the screen can never show a list the system is not
 * actually using.
 */
"use client";
import React, { useCallback, useEffect, useState } from "react";
import { Button, Textarea, Modal, ConfirmModal } from "@/components/ui";
import { RemindersPanel } from "@/app/sections/Reminders";
import { Pencil, Plus, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Lead } from "@/lib/types";
import { workspaceId } from "@/app/page";

type Row = {
  key: string;
  label: string;
  value?: string;
  known: boolean;
  onlyThisLead: boolean;
  noLongerAsked?: boolean;
  ownerEditedAt?: string;
  forgottenAt?: string;
  evidence?: { replyId: string; body: string; happenedAt: string };
};

type Discovery = { rows: Row[]; stillUnknown: string[] };

export function WhatTheBuyerToldUs({ lead, readOnly = false }: { lead: Lead; readOnly?: boolean }) {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newLine, setNewLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [factText, setFactText] = useState("");
  const [removing, setRemoving] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setDiscovery(await api<Discovery>(`/api/leads/${lead.id}/discovery`));
  }, [lead.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load what this customer told us."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function change(action: () => Promise<Discovery>) {
    if (readOnly) return false;
    setBusy(true);
    setError(null);
    try {
      setDiscovery(await action());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const addLine = () =>
    change(async () => {
      const result = await api<Discovery>(`/api/leads/${lead.id}/discovery-lines`, {
        method: "POST",
        body: { workspaceId, label: newLine },
      });
      setNewLine("");
      return result;
    });

  const removeLine = (key: string) =>
    change(() => api<Discovery>(`/api/leads/${lead.id}/discovery-lines/${encodeURIComponent(key)}`, { method: "DELETE" }));
  const changeFact = (row: Row, action: 'correct' | 'forget' | 'resume') => change(() =>
    api<Discovery>(`/api/leads/${lead.id}/discovery-facts/${encodeURIComponent(row.key)}`, {
      method: 'PUT', body: { workspaceId, action, ...(action === 'correct' ? { value: factText } : {}) },
    }));

  const known = discovery?.rows.filter((row) => row.known) || [];
  const paused = discovery?.rows.filter(row => row.forgottenAt) || [];
  const ownOpen = discovery?.rows.filter((row) => row.onlyThisLead && !row.known && !row.forgottenAt) || [];
  // Lines added to this lead are listed on their own, with a remove button, so
  // they are not repeated in the general "still unknown" sentence.
  const ownOpenLabels = new Set(ownOpen.map((row) => row.label));
  const generalUnknown = (discovery?.stillUnknown || []).filter((label) => !ownOpenLabels.has(label));

  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      <h4 className="font-semibold text-xs uppercase tracking-wide text-primary">What this customer has told us</h4>

      {error ? <div role="alert" className="mt-2"><p className="text-sm text-danger-fg">{error}</p><Button size="sm" variant="secondary" onClick={() => load().catch(cause => setError(cause instanceof Error ? cause.message : "Could not load what this customer told us."))}>Try again</Button></div> : null}
      {!discovery && !error ? <p className="mt-2 text-sm text-muted">Loading…</p> : null}

      {discovery ? (
        <>
          {known.length ? (
            <dl className="mt-3 divide-y divide-border-subtle text-sm">
              {known.map((row) => (
                <div key={row.key} className="flex items-start gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <dt className="text-xs text-muted">
                      {row.label}
                      {row.noLongerAsked ? <span className="text-muted-2"> · no longer on your list</span> : null}
                    </dt>
                    {/* Their words, not a tidied code. "Surat se le rahe hain par
                        delivery late hoti hai" is worth more than "Surat", and
                        the late delivery is the part that sells. */}
                    <dd className="mt-0.5 text-foreground">{row.value}</dd>
                    {row.ownerEditedAt && <p className="mt-1 text-xs text-muted">Corrected by your team · AI will keep this version</p>}
                    {row.evidence && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Original customer message</summary><p className="mt-1 whitespace-pre-wrap text-foreground">{row.evidence.body}</p><p className="mt-1">Received {row.evidence.happenedAt.slice(0, 10)}{row.ownerEditedAt ? ' · shown for context; your correction is the current fact' : ''}</p></details>}
                    {!readOnly && <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(row); setFactText(row.value || ''); setError(null); }} aria-label={`Correct ${row.label}`}>Correct fact</Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRemoving(row); setError(null); }} aria-label={`Remove remembered fact: ${row.label}`}>Remove remembered fact</Button>
                    </div>}
                  </div>
                  {row.onlyThisLead && !readOnly ? (
                    <Button variant="ghost" size="sm" icon={X} aria-label={`Remove "${row.label}" from this lead`} disabled={busy} onClick={() => removeLine(row.key)} />
                  ) : null}
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-sm text-muted leading-relaxed">
              {paused.length ? 'No active remembered facts in this checklist. Removed facts are listed below.' : 'Nothing recorded in this checklist yet. It captures only what the customer says, and never guesses.'}
            </p>
          )}

          {generalUnknown.length ? (
            <p className="mt-3 text-xs text-muted-2 leading-relaxed">
              {/* Separated by dots, not commas: owners write their lines as
                  questions, and "do they export?, who decides?." reads as a
                  typo. */}
              <span className="text-muted">Still unknown:</span> {generalUnknown.join(" · ")}
            </p>
          ) : known.length && !ownOpen.length && !paused.length ? (
            <p className="mt-3 text-xs text-muted-2">They have told us everything on the list.</p>
          ) : null}

          {paused.length > 0 && <div className="mt-3 rounded-md bg-surface-muted p-3 text-xs text-muted">
            <p className="font-medium">Remembering paused</p>
            <p className="mt-1">These checklist facts were removed. Original messages, the separate AI note and the activity history remain.</p>
            {paused.map(row => <div key={row.key} className="mt-2 flex items-center justify-between gap-2"><span>{row.label}</span>{!readOnly && <Button size="sm" variant="secondary" disabled={busy} aria-label={`Resume remembering ${row.label}`} onClick={() => void changeFact(row, 'resume')}>Resume remembering</Button>}</div>)}
          </div>}

          {ownOpen.length ? (
            <ul className="mt-3 space-y-1">
              {ownOpen.map((row) => (
                <li key={row.key} className="flex items-center gap-2 text-xs text-muted">
                  <span className="min-w-0 flex-1">For this customer only: {row.label}</span>
                  {!readOnly && <Button variant="ghost" size="sm" icon={X} aria-label={`Remove "${row.label}" from this lead`} disabled={busy} onClick={() => removeLine(row.key)} />}
                </li>
              ))}
            </ul>
          ) : null}

          {!readOnly && <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (newLine.trim()) void addLine();
            }}
          >
            <input
              className="input text-sm"
              aria-label="Something to find out about this customer only"
              placeholder="Something to find out about this customer only — e.g. did the sample reach them?"
              maxLength={80}
              value={newLine}
              onChange={(event) => setNewLine(event.target.value)}
            />
            <Button type="submit" variant="secondary" size="sm" icon={Plus} disabled={busy || !newLine.trim()}>
              Add
            </Button>
          </form>}
        </>
      ) : null}

      {/* Keyed so a different customer, or a newer note from the server, resets the box. */}
      <MemoryNote key={`${lead.id}:${lead.conversationMemoryAt || ""}`} lead={lead} readOnly={readOnly} />
      <RemindersPanel leadId={lead.id} doNotContact={Boolean(lead.doNotContact) || lead.status === "do_not_contact"} readOnly={readOnly} />
      <Modal open={Boolean(editing) && !readOnly} title="Correct customer fact" onClose={() => { if (!busy) { setEditing(null); setError(null); } }}>
        <Textarea label={editing?.label || 'Customer fact'} value={factText} onChange={setFactText} maxLength={240} showCounter hint="Your team’s correction stays in place. The AI will not replace it." />
        {error && <p role="alert" className="mt-2 text-sm text-danger-fg">{error}</p>}
        <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>Cancel</Button><Button loading={busy} disabled={!factText.trim()} onClick={async () => { if (editing && await changeFact(editing, 'correct')) setEditing(null); }}>Save corrected fact</Button></div>
      </Modal>
      <ConfirmModal open={Boolean(removing) && !readOnly} title="Remove this remembered fact?" confirmLabel="Remove and pause remembering" tone="danger" loading={busy} onClose={() => { if (!busy) { setRemoving(null); setError(null); } }} onConfirm={async () => { if (removing && await changeFact(removing, 'forget')) setRemoving(null); }}>
        <p>This clears “{removing?.label}” from this customer’s checklist and stops the AI from capturing it again until you resume remembering.</p>
        <p className="mt-2">Original messages, the separate AI note and the activity history remain. This does not erase customer data.</p>
        {error && <p role="alert" className="mt-2 text-danger-fg">{error}</p>}
      </ConfirmModal>
    </div>
  );
}

/** Kept in step with LEAD_MEMORY_MAX_CHARS on the server, which enforces it. */
const MEMORY_MAX_CHARS = 700;

/**
 * The AI's running note about this customer, which the owner can correct
 * (2026-09-27, A2). Once saved, the note is the owner's and the AI stops
 * rewriting it; saving an empty note hands it back to the AI.
 */
function MemoryNote({ lead, readOnly }: { lead: Lead; readOnly: boolean }) {
  const [note, setNote] = useState({
    memory: lead.conversationMemory?.trim() || "",
    source: lead.conversationMemorySource,
    at: lead.conversationMemoryAt,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (draft === null || readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api<Lead>(`/api/leads/${lead.id}/memory`, { method: "PUT", body: { workspaceId, memory: draft } });
      setNote({ memory: updated.conversationMemory?.trim() || "", source: updated.conversationMemorySource, at: updated.conversationMemoryAt });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The note did not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 border-t border-border-default pt-3">
      <p className="text-xs text-muted">What the AI remembers, and reads before its next reply</p>
      <p className="mt-1 text-xs text-muted-2">A short note plus recent messages helps the AI respond. This is selective memory; original messages stay in Conversations.</p>
      {draft === null || readOnly ? (
        <>
          {note.memory ? (
            <p className="mt-1 whitespace-pre-line text-sm text-muted-2 leading-relaxed">{note.memory}</p>
          ) : (
            <p className="mt-1 text-sm text-muted-2">Nothing remembered yet.</p>
          )}
          {note.memory && note.at ? (
            <p className="mt-1 text-xs text-muted-2">
              Last updated {note.at.slice(0, 10)}
              {note.source === "owner" ? " · your version, the AI will not overwrite it" : ""}
            </p>
          ) : null}
          {!readOnly && <Button className="mt-2" variant="ghost" size="sm" icon={Pencil} onClick={() => setDraft(note.memory)}>
            {note.memory ? "Correct this note" : "Write a note"}
          </Button>}
        </>
      ) : (
        <div className="mt-2">
          <Textarea
            label="Your note about this customer"
            value={draft}
            onChange={setDraft}
            rows={4}
            maxLength={MEMORY_MAX_CHARS}
            showCounter
            hint="Once you save, the AI keeps your version and stops rewriting it. Save it empty to let the AI keep the note again."
          />
          {error ? <p className="mt-2 text-sm text-danger-fg">{error}</p> : null}
          <div className="mt-2 flex gap-2">
            <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
              Save note
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
