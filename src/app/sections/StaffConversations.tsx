"use client";
import { useEffect, useState } from 'react';
import { Card, Button, Spinner, EmptyState, Badge } from '@/components/ui';
import { MessageCircle, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-date';
import type { Lead } from '@/lib/types';
import type { CustomerMessage } from '@/services/CustomerConversationHistoryService';

export function StaffConversations({ leads, focusLeadId, onFocusLead }: { leads: Lead[]; focusLeadId?: string; onFocusLead: (leadId: string, section: 'crm' | 'tickets') => void }) {
  const [chosen, setChosen] = useState('');
  const customerId = focusLeadId || chosen || leads[0]?.id || '';
  const [result, setResult] = useState<{ customerId: string; messages: CustomerMessage[]; error?: string } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!customerId) return;
    let active = true;
    api<CustomerMessage[]>(`/api/leads/${customerId}/conversation-messages`).then(messages => { if (active) setResult({ customerId, messages }); })
      .catch(e => { if (active) setResult({ customerId, messages: [], error: e instanceof Error ? e.message : 'Could not load this conversation.' }); });
    return () => { active = false; };
  }, [customerId, version]);
  const customer = leads.find(l => l.id === customerId);
  return <Card title="Customer conversations" icon={MessageCircle}>
    <p className="mb-4 text-sm text-muted">Read what the customer said and the messages recorded as sent. Replies prepared by your team stay with the owner for review.</p>
    {!focusLeadId && <div className="mb-4"><label className="label" htmlFor="staff-conversation-customer">Customer</label><select className="input" id="staff-conversation-customer" value={customerId} onChange={e => setChosen(e.target.value)}>{leads.map(lead => <option key={lead.id} value={lead.id}>{lead.companyName || lead.contactName || 'Unnamed customer'}</option>)}</select></div>}
    {!customer ? <EmptyState title="No customers yet" description="Conversations will appear against the customer record when messages are received." /> : <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{customer.companyName || customer.contactName}</h3><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => onFocusLead(customer.id, 'crm')}>Customer record</Button><Button size="sm" variant="secondary" onClick={() => onFocusLead(customer.id, 'tickets')}>Support tickets</Button></div></div>
      {!result || result.customerId !== customerId ? <div className="py-8"><Spinner /></div> : result.error ? <div role="alert"><p className="mb-3 text-sm text-danger-fg">{result.error}</p><Button onClick={() => setVersion(v => v + 1)}>Try again</Button></div> : !result.messages.length ? <EmptyState title="No conversation yet" description="Unsent drafts are not customer conversations. Received messages and recorded sends will appear here." /> : <ol className="space-y-3">{result.messages.map(message => <li key={message.id} className={`rounded-lg border border-border-default p-4 ${message.direction === 'incoming' ? 'bg-surface' : 'bg-surface-muted'}`}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><Badge>{message.direction === 'incoming' ? 'Customer' : 'Your company'} · {message.channel}</Badge><span className="text-xs text-muted">{formatDateTime(message.happenedAt)}</span></div><p className="whitespace-pre-wrap break-words text-sm">{message.body}</p><p className="mt-2 text-xs text-muted">{message.confirmation}</p></li>)}</ol>}
    </>}
  </Card>;
}
