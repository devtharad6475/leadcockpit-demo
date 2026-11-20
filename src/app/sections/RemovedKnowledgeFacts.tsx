"use client";
import React, { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmModal, Drawer, DrawerBody, EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-date';

type RemovedFact = { chunkId: string; text: string; sourceFileName?: string; retired: { at: string; replacedBy?: string } };

/** Retained source passages can be inspected and deliberately restored. */
export function RemovedKnowledgeFacts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<RemovedFact[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [pending, setPending] = useState<RemovedFact | null>(null);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await api<RemovedFact[]>('/api/knowledge/removed-source-facts')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load removed source facts.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [open, load]);
  async function restore() {
    if (!pending || restoring) return;
    setRestoring(true); setError(''); setNotice('');
    try {
      await api(`/api/knowledge/chunks/${encodeURIComponent(pending.chunkId)}/restore`, { method: 'PUT', body: {} });
      setRows(current => current?.filter(row => row.chunkId !== pending.chunkId) || []);
      setPending(null); setNotice('Source fact restored. It is available to AI answers again; approved company answers still take priority.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this source fact.'); }
    finally { setRestoring(false); }
  }
  return <>
    <Drawer open={open} title="Removed source facts" onOpenChange={nextOpen => { if (!nextOpen && !restoring) { setPending(null); onClose(); } }}>
      <DrawerBody>
        <p className="mb-4 text-sm text-muted">These passages were removed from AI answers after a correction. Their original text is kept so you can check or undo the change.</p>
        {notice && <p role="status" className="mb-3 rounded-md bg-success-bg p-3 text-sm text-success-fg">{notice}</p>}
        {error && !pending && <div role="alert" className="mb-3"><p className="text-sm text-danger-fg">{error}</p><Button className="mt-2" variant="secondary" onClick={() => void load()}>Try again</Button></div>}
        {loading ? <div className="py-6"><Spinner /></div> : rows?.length === 0 ? <EmptyState title="No removed source facts" description="Passages you remove after a correction will appear here." /> : <ul className="space-y-3">{rows?.map(row => <li key={row.chunkId} className="rounded-lg border border-border-default p-4">
          <p className="text-xs font-medium text-muted">{row.sourceFileName || 'Company source document'} · removed {formatDateTime(row.retired.at)}</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.text}</p>
          {row.retired.replacedBy && <p className="mt-3 text-sm text-muted">Replacement explanation: {row.retired.replacedBy}</p>}
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => { setError(''); setPending(row); }}>Restore source fact</Button>
        </li>)}</ul>}
    <ConfirmModal open={Boolean(pending)} title="Restore this source fact?" confirmLabel="Restore for AI answers" loading={restoring} onClose={() => { if (!restoring) { setPending(null); setError(''); } }} onConfirm={() => void restore()}>
      <p>The original passage will become available to AI answers again. Confirm it is still accurate. Approved company answers continue to take priority.</p>
      <p className="mt-3 whitespace-pre-wrap">{pending?.text}</p>
      {error && <p role="alert" className="mt-3 text-danger-fg">{error}</p>}
    </ConfirmModal>
      </DrawerBody>
    </Drawer>
  </>;
}
