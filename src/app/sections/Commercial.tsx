/**
 * 2026-07-21 (M7) — Commercial screen (Quotes + Orders).
 *
 * Per docs/UI-DESIGN.md M7: a "Commercial" tab with sub-tabs for
 * Quotes / Orders. Replaces the "no UI" gap from the audit.
 *
 * Backend: src/services/OrderService.ts (quote→order conversion, cancel,
 * reorder, discount flag) + the new /api/orders + /api/quotes endpoints.
 *
 * Uses the new design system + displayLabel so status codes never leak
 * raw (e.g. "partial_cancelled" shows as "Partially cancelled" + danger tone).
 */
"use client";
import { formatDate, formatDateTime } from "@/lib/format-date";
import React, { useEffect, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, Modal, ConfirmModal, Drawer, DrawerBody, Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui";
import { Tabs } from "@/components/ui";
import {
  displayOrderStatus, displayOrderStatusTone,
  displayQuoteStatus, displayQuoteStatusTone,
} from "@/lib/display-labels";
import { computeLineTotalPaise, formatMoney, formatUnitPriceMoney, sumQuantitiesExact, sumLineTotalsPaise } from "@/lib/money";
import type { Order, Quote } from "@/lib/types";
import { ShoppingBag, FileText, AlertCircle, Plus, MoreHorizontal, Eye, Ban, ArrowRightLeft, CopyPlus } from "lucide-react";
// Stage A+ / Cluster 10a (P2-3): shared api() chokepoint — replaces the local
// copy that took raw RequestInit (latent [object Object] body bug).
import { api } from "@/lib/api-client";
import { nextOrderStatuses, nextQuoteStatuses } from "@/lib/status-transitions";

// `onFocusLead` (2026-08-05 N-P1-5): enables the customer-name + origin links
// in the Order/Quote drawers to jump back to the lead's CRM record. Was dead
// text before — the data existed but the UI didn't link it.
export function Commercial({ focusLeadId, onFocusLead, readOnly = false }: { focusLeadId?: string; onFocusLead?: (leadId: string, section: "crm") => void; readOnly?: boolean } = {}) {
  const [tab, setTab] = useState<string>("orders");
  const [orders, setOrders] = useState<Order[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
    // 2026-08-05 E-P1-1: action errors show inline (list stays visible), not full-screen wipe.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  const [detailQuote, setDetailQuote] = useState<Quote | null>(null);
  const [revision, setRevision] = useState<Quote | null>(null);
  const [revisionLines, setRevisionLines] = useState<Array<{ quantity: string; unitPrice: string }>>([]);
  const [revisionNotes, setRevisionNotes] = useState("");
  const [quantityOrder, setQuantityOrder] = useState<Order | null>(null);
  const [quantityKind, setQuantityKind] = useState<"ship" | "cancel">("ship");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [cancelReason, setCancelReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [o, q] = await Promise.all([
        api<Order[]>("/api/orders"),
        api<Quote[]>("/api/quotes"),
      ]);
      setOrders(o);
      setQuotes(q);
      setDetailOrder(current => current ? o.find(order => order.id === current.id) ?? null : null);
      setDetailQuote(current => current ? q.find(quote => quote.id === current.id) ?? null : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // S6 U-3: confirm-dialog state for destructive actions (replaces window.confirm).
  const [pendingConfirm, setPendingConfirm] = useState<null | { kind: "cancelOrder" | "convertQuote" | "repeatOrder"; id: string }>(null);

  async function cancelOrder(orderId: string) {
    // S6 U-3: was window.confirm() — replaced with an accessible ConfirmModal.
    setPendingConfirm({ kind: "cancelOrder", id: orderId });
  }
  async function doCancelOrder(orderId: string) {
    if (readOnly || busy) return;
    setBusy("Cancelling...");
    try {
      await api(`/api/orders/${orderId}/cancel`, {
        method: "POST",
        body: { reason: "Cancelled from Quotes & Orders" },
      });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy("");
    }
  }

  // 2026-08-02 audit P2-5 — advance an order's lifecycle (quoted → in_progress →
  // shipped → delivered, etc.). Pre-fix only Cancel was reachable.
  async function changeOrderStatus(orderId: string, toStatus: string) {
    if (!toStatus || readOnly || busy) return;
    setBusy(`Updating status to ${toStatus}...`);
    try {
      await api(`/api/orders/${orderId}/status`, { method: "POST", body: { toStatus } });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Status update failed");
    } finally {
      setBusy("");
    }
  }

  // 2026-08-02 audit P2-5 — quote lifecycle (draft → sent/accepted/rejected/expired).
  async function changeQuoteStatus(quoteId: string, toStatus: string) {
    if (!toStatus || readOnly || busy) return;
    setBusy(`Updating quote to ${toStatus}...`);
    try {
      await api(`/api/quotes/${quoteId}/status`, { method: "POST", body: { toStatus } });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Quote status update failed");
    } finally {
      setBusy("");
    }
  }

  // F-DATA-5 (2026-08-17, decision D5): "Revise" is the ONLY way a quote
  // becomes superseded. It copies the quote into a new draft, links the two
  // (supersedesQuoteId), and retires the original. The server refuses on an
  // accepted/converted quote — the inline actionError shows that message.
  async function reviseQuote(quoteId: string) {
    if (readOnly) return;
    const quote = quotes.find(item => item.id === quoteId);
    if (!quote) return;
    setDetailQuote(null);
    setRevision(quote);
    setRevisionLines(quote.lineItems.map(item => ({ quantity: String(item.quantity), unitPrice: String(item.unitPrice) })));
    setRevisionNotes(quote.notes || "");
    setFormError(null);
  }

  async function saveRevision() {
    if (!revision || readOnly || busy) return;
    const lineItems = revision.lineItems.map((item, index) => ({ ...item,
      quantity: Number(revisionLines[index].quantity), unitPrice: Number(revisionLines[index].unitPrice), lineTotal: undefined }));
    if (revisionLines.some(item => !item.quantity.trim() || !item.unitPrice.trim()) || lineItems.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPrice) || item.unitPrice < 0)) {
      setFormError("Enter a positive quantity and a price of zero or more for each item."); return;
    }
    setFormError(null);
    setBusy("Creating revision...");
    try {
      const res = await api<{ quote: Quote }>(`/api/quotes/${revision.id}/revise`, { method: "POST", body: { lineItems, notes: revisionNotes } });
      setRevision(null);
      await load();
      if (res?.quote) setDetailQuote(res.quote);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not create a revision of this quote");
    } finally {
      setBusy("");
    }
  }

  function openQuantities(order: Order, kind: "ship" | "cancel") {
    if (readOnly) return;
    setDetailOrder(null);
    setQuantityOrder(order); setQuantityKind(kind); setFormError(null); setCancelReason("");
    setQuantities(Object.fromEntries(order.lineItems.map(item => [item.id, kind === "ship" ? String(order.shippedQuantityByLine?.[item.id] || 0) : "0"])));
  }

  async function saveQuantities() {
    if (!quantityOrder || readOnly || busy) return;
    const order = quantityOrder;
    const entries: Record<string, number> = {};
    for (const item of order.lineItems) {
      const value = Number(quantities[item.id]);
      const shipped = order.shippedQuantityByLine?.[item.id] || 0;
      const cancelled = order.cancelledQuantityByLine?.[item.id] || 0;
      const limit = sumQuantitiesExact(item.quantity, -cancelled, quantityKind === "cancel" ? -shipped : 0);
      if (!quantities[item.id]?.trim() || !Number.isFinite(value) || value < 0 || value > limit || (quantityKind === "ship" && value < shipped)) {
        setFormError(`Check ${item.productName}: enter ${quantityKind === "ship" ? shipped : 0} to ${limit}.`); return;
      }
      if (quantityKind === "ship" || value > 0) entries[item.id] = value;
    }
    if (quantityKind === "cancel" && (!Object.keys(entries).length || !cancelReason.trim())) {
      setFormError("Enter a quantity to cancel and the reason for the cancellation."); return;
    }
    if (quantityKind === "ship" && !order.lineItems.some(item => entries[item.id] > (order.shippedQuantityByLine?.[item.id] || 0))) {
      setFormError("Increase at least one shipped quantity to record this dispatch."); return;
    }
    setBusy(quantityKind === "ship" ? "Recording shipment..." : "Recording cancellation..."); setFormError(null);
    try {
      if (quantityKind === "ship") {
        const complete = order.lineItems.every(item => entries[item.id] === sumQuantitiesExact(item.quantity, -(order.cancelledQuantityByLine?.[item.id] || 0)));
        await api(`/api/orders/${order.id}/status`, { method: "POST", body: { toStatus: complete ? "shipped" : "partial_shipped", shippedQuantityByLine: entries } });
      } else await api(`/api/orders/${order.id}/cancel`, { method: "POST", body: { cancelQuantitiesByLine: entries, reason: cancelReason.trim() } });
      const fresh = await api<Order>(`/api/orders/${order.id}`);
      setQuantityOrder(null); await load(); setDetailOrder(fresh);
    } catch (e) { setFormError(e instanceof Error ? e.message : "Could not record the quantities. Try again."); }
    finally { setBusy(""); }
  }

  async function repeatOrder(id: string) {
    if (readOnly || busy) return;
    setBusy("Creating repeat order..."); setActionError(null);
    try {
      const order = await api<Order>(`/api/orders/${id}/reorder`, { method: "POST", body: {} });
      await load(); setTab("orders"); setDetailOrder(order);
    } catch (e) { setActionError(e instanceof Error ? e.message : "Could not create the repeat order."); }
    finally { setBusy(""); }
  }

  async function downloadQuote(quote: Quote) {
    if (readOnly || busy) return;
    setBusy("Preparing quote PDF..."); setActionError(null);
    try {
      const media = await api<{ id: string; fileName: string }>(`/api/quotes/${quote.id}/generate-pdf`, { method: "POST", body: {} });
      const response = await fetch(`/api/media/${encodeURIComponent(media.id)}/file`);
      if (!response.ok) throw new Error("The quote was prepared, but could not be downloaded. Try again.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = media.fileName || `quote-${quote.quoteNumber}.pdf`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (e) { setActionError(e instanceof Error ? e.message : "Could not prepare this quote PDF."); }
    finally { setBusy(""); }
  }

  async function convertQuote(quoteId: string) {
    // S6 U-3: was window.confirm() — replaced with an accessible ConfirmModal.
    setPendingConfirm({ kind: "convertQuote", id: quoteId });
  }
  async function doConvertQuote(quoteId: string) {
    if (readOnly || busy) return;
    setBusy("Converting...");
    try {
      const result = await api<{ order: Order }>(`/api/quotes/${quoteId}/convert`, { method: "POST" });
      await load();
      if (result.order) { setTab("orders"); setDetailQuote(null); setDetailOrder(result.order); }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Conversion failed");
    } finally {
      setBusy("");
    }
  }

  // Cluster 7 / P1-7: create-order / create-quote UI. The POST /api/orders
  // and POST /api/quotes endpoints existed but had NO UI button. Now there's
  // a small create modal with one line item (the simplest viable form). The
  // backend zod schema validates quantity > 0, unitPrice >= 0, max 200 items.
  const [createOpen, setCreateOpen] = useState<null | "order" | "quote">(null);
  const [formLeadId, setFormLeadId] = useState("");
  const [formProduct, setFormProduct] = useState("");
  const [formQty, setFormQty] = useState("1");
  const [formPrice, setFormPrice] = useState("0");
  // 2026-07-29 (depth-audit F-UI-2): operator-chosen status for a manual
  // ORDER (draft → review later, or confirmed → record immediately). Before
  // this the UI hard-coded status="confirmed" for orders but the backend
  // silently dropped it and saved "draft" — the operator's choice was lost.
  // Quotes always start as draft (the convert-quote path stamps confirmed).
  const [formOrderStatus, setFormOrderStatus] = useState<"draft" | "confirmed">("confirmed");
  const [leads, setLeads] = useState<Array<{ id: string; contactName?: string; companyName?: string }>>([]);
  // Stage A+ / Cluster 10c (P2-9): drill-down for orders/quotes. Clicking a row
  // opens a detail modal showing the line items (was: rows were dead text).

  useEffect(() => {
    // Load the lead list once for the create-form dropdown.
    api<Array<{ id: string; contactName?: string; companyName?: string }>>("/api/leads")
      .then(setLeads)
      .catch(() => undefined);
  }, []);

  function openCreate(kind: "order" | "quote") {
    if (readOnly || busy) return;
    setCreateOpen(kind);
    setFormLeadId(leads[0]?.id || "");
    setFormProduct("");
    setFormQty("1");
    setFormPrice("0");
    setFormOrderStatus("confirmed");
    setError(null);
    setFormError(null);
  }

  async function submitCreate() {
    if (!createOpen || readOnly || busy) return;
    const qty = Number(formQty);
    const unitPrice = Number(formPrice);
    if (!formProduct.trim()) { setFormError("Product name is required."); return; }
    if (!formQty.trim() || !Number.isFinite(qty) || qty <= 0) { setFormError("Quantity must be a positive number."); return; }
    if (!formPrice.trim() || !Number.isFinite(unitPrice) || unitPrice < 0) { setFormError("Unit price must be 0 or more."); return; }
    setFormError(null);
    setBusy(`Creating ${createOpen}...`);
    try {
      const endpoint = createOpen === "order" ? "/api/orders" : "/api/quotes";
      const payload: Record<string, unknown> = {
        lineItems: [{ productName: formProduct.trim(), quantity: qty, unitPrice }],
        currencyCode: "INR",
      };
      if (formLeadId) payload.leadId = formLeadId;
      if (createOpen === "order") payload.status = formOrderStatus;
      else payload.status = "draft";
      await api(endpoint, { method: "POST", body: payload });
      setCreateOpen(null);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : `Create ${createOpen} failed`);
    } finally {
      setBusy("");
    }
  }

  function previewTotal(items: Array<{ quantity: number; unitPrice: number }>, currency = "INR") {
    try { return formatMoney(sumLineTotalsPaise(items), currency); }
    catch { return "Check the quantities and prices"; }
  }

  if (loading) {
    return (
      <Card title="Quotes & Orders" icon={ShoppingBag}>
        <div className="flex items-center gap-2 justify-center py-8 text-muted">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Quotes & Orders" icon={AlertCircle}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={error}
          action={<Button onClick={load}>Try again</Button>}
        />
      </Card>
    );
  }

  // 2026-08-05 E-P1-1: action errors show inline (list stays visible).
  const actionBanner = actionError ? (
    <div role="alert" className="mb-3 flex items-start justify-between gap-3 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm text-danger-fg">
      <span>{actionError}</span>
      <button className="text-xs font-semibold underline" onClick={() => setActionError(null)}>Dismiss</button>
    </div>
  ) : null;

  // 2026-08-02 audit P2-2 — when drilled in from a Lead, pre-filter orders +
  // quotes to that lead. The focus ribbon (page.tsx) explains the filter.
  const visibleOrders = focusLeadId ? orders.filter((o) => o.leadId === focusLeadId) : orders;
  const visibleQuotes = focusLeadId ? quotes.filter((q) => q.leadId === focusLeadId) : quotes;
  // F9 (2026-08-04 CONTINUOUS-2 audit): resolve a leadId to a display name so
  // the orders/quotes tables + Drawers can show the customer. Falls back to "—"
  // for orders with no linked lead (empty leadId is valid).
  function customerNameFor(leadId: string | undefined): string {
    if (!leadId) return "—";
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return "—";
    return lead.companyName || lead.contactName || "Unnamed lead";
  }

  return (
    <div className="space-y-4">
      {actionBanner}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          tabs={[
            { id: "orders", label: "Orders", count: visibleOrders.length },
            { id: "quotes", label: "Quotes", count: visibleQuotes.length },
          ]}
          activeTab={tab}
          onSelect={setTab}
        />
        {/* Cluster 7 / P1-7: New order + New quote buttons. The POST endpoints
            existed but had no UI. Now there's a simple create flow. */}
        <div className="flex gap-2">
          {!readOnly && (tab === "orders" ? (
            <Button size="sm" icon={Plus} onClick={() => openCreate("order")}>New order</Button>
          ) : (
            <Button size="sm" icon={Plus} onClick={() => openCreate("quote")}>New quote</Button>
          ))}
        </div>
      </div>

      {tab === "orders" && (
        visibleOrders.length === 0 ? (
          <Card title="Orders" icon={ShoppingBag}>
            <EmptyState
              icon={ShoppingBag}
              title="No orders yet"
              description="When you create an order from a customer conversation or convert an accepted quote, it will appear here."
            />
          </Card>
        ) : (
          <Card title={focusLeadId ? `Orders for this customer (${visibleOrders.length} of ${orders.length})` : "All orders"} icon={ShoppingBag} padding="none">
            <Table caption="Orders">
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleOrders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      {/* Stage A+ / Cluster 10c (P2-9): clickable order # for drill-down.
                          The order-number cell is the drill trigger (not the whole row —
                          avoids conflict with the Cancel button in the Actions cell). */}
                      <button
                        type="button"
                        className="text-primary underline underline-offset-2 hover:text-primary-strong font-medium"
                        onClick={() => setDetailOrder(o)}
                        aria-label={`View details for order #${o.orderNumber}`}
                      >
                        #{o.orderNumber}
                      </button>
                    </TableCell>
                    <TableCell>
                      {/* F9 (2026-08-04 CONTINUOUS-2 audit): surface the customer.
                          Previously the table + Drawer never named the customer — an
                          operator with 30 orders had to drill into each to find one. */}
                      {customerNameFor(o.leadId)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={displayOrderStatusTone(o.status)}>
                        {displayOrderStatus(o.status)}
                      </Badge>
                      {o.discountGiven && <Badge tone="warning" className="ml-1">Discount</Badge>}
                    </TableCell>
                    <TableCell>{formatMoney(o.grandTotal, o.currencyCode)}</TableCell>
                    <TableCell>{formatDate(o.createdAt)}</TableCell>
                    <TableCell>
                      {/* 2026-08-02 (UX redesign): row actions collapsed into a
                          ⋯ Dropdown (NN/g + Pencil & Paper — reduces column
                          clutter; keeps the most important action visible). */}
                      <Dropdown
                        trigger={
                          <button
                            type="button"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-default bg-surface text-muted hover:bg-surface-muted hover:text-foreground"
                            aria-label={`More actions for order #${o.orderNumber}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        }
                      >
                        <DropdownItem icon={Eye} onSelect={() => setDetailOrder(o)}>View details</DropdownItem>
                        {!readOnly && ["draft", "confirmed", "in_progress"].includes(o.status) ? (
                          <>
                            <DropdownSeparator />
                            <DropdownItem icon={Ban} tone="danger" disabled={busy !== ""} onSelect={() => cancelOrder(o.id)}>Cancel order</DropdownItem>
                          </>
                        ) : null}
                        {!readOnly && <DropdownItem icon={CopyPlus} disabled={busy !== ""} onSelect={() => setPendingConfirm({ kind: "repeatOrder", id: o.id })}>Repeat order as draft</DropdownItem>}
                      </Dropdown>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )
      )}

      {tab === "quotes" && (
        visibleQuotes.length === 0 ? (
          <Card title="Quotes" icon={FileText}>
            <EmptyState
              icon={FileText}
              title="No quotes yet"
              description="Quotes you send to customers will appear here. A quote can be converted to an order when the customer accepts."
            />
          </Card>
        ) : (
          <Card title={focusLeadId ? `Quotes for this customer (${visibleQuotes.length} of ${quotes.length})` : "All quotes"} icon={FileText} padding="none">
            <Table caption="Quotes">
              <TableHeader>
                <TableRow>
                  <TableHead>Quote #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleQuotes.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell>
                      {/* Stage A+ / Cluster 10c (P2-9): clickable quote # for drill-down. */}
                      <button
                        type="button"
                        className="text-primary underline underline-offset-2 hover:text-primary-strong font-medium"
                        onClick={() => setDetailQuote(q)}
                        aria-label={`View details for quote #${q.quoteNumber}`}
                      >
                        #{q.quoteNumber}
                      </button>
                    </TableCell>
                    <TableCell>{customerNameFor(q.leadId)}</TableCell>
                    <TableCell><Badge tone={displayQuoteStatusTone(q.status)}>{displayQuoteStatus(q.status)}</Badge></TableCell>
                    <TableCell>{formatMoney(q.grandTotal, q.currencyCode)}</TableCell>
                    <TableCell>{formatDate(q.createdAt)}</TableCell>
                    <TableCell>
                      <Dropdown
                        trigger={
                          <button
                            type="button"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-default bg-surface text-muted hover:bg-surface-muted hover:text-foreground"
                            aria-label={`More actions for quote #${q.quoteNumber}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        }
                      >
                        <DropdownItem icon={Eye} onSelect={() => setDetailQuote(q)}>View details</DropdownItem>
                        {!readOnly && ["sent", "accepted"].includes(q.status) ? (
                          <>
                            <DropdownSeparator />
                            <DropdownItem icon={ArrowRightLeft} disabled={busy !== ""} onSelect={() => convertQuote(q.id)}>Convert to order</DropdownItem>
                          </>
                        ) : null}
                        {/* F-DATA-5 / D5: revise = new quote that replaces this one.
                            Hidden for accepted + converted (a commitment can't be
                            rewritten) and for already-superseded quotes. */}
                        {!readOnly && ["draft", "sent", "rejected", "expired"].includes(q.status) ? (
                          <>
                            <DropdownSeparator />
                            <DropdownItem icon={CopyPlus} disabled={busy !== ""} onSelect={() => reviseQuote(q.id)}>Revise (replace with new quote)</DropdownItem>
                          </>
                        ) : null}
                        {!readOnly && <DropdownItem icon={FileText} disabled={busy !== "" || !q.leadId} onSelect={() => downloadQuote(q)}>Download quote PDF</DropdownItem>}
                      </Dropdown>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )
      )}

      {busy && <p className="text-sm text-muted">{busy}</p>}

      {/* Cluster 7 / P1-7: create-order / create-quote modal. */}
      <Modal
        open={createOpen !== null}
        onClose={() => { if (!busy) setCreateOpen(null); }}
        title={createOpen === "order" ? "New order" : "New quote"}
        size="md"
        disableDismiss={Boolean(busy)}
      >
        <fieldset className="space-y-3" disabled={Boolean(busy)} aria-busy={Boolean(busy)}>
          {formError && <p role="alert" className="text-sm text-danger-fg">{formError}</p>}
          <p className="text-sm text-muted">
            {createOpen === "order"
              ? "Create a manual order. Use this when a customer agrees to buy over WhatsApp/phone and you want to record it."
              : "Create a manual quote to send to a customer. Once they accept, convert it to an order from the Quotes tab."}
          </p>
          <div>
            <label htmlFor="create-lead" className="label">Customer (optional)</label>
            <select
              id="create-lead"
              className="input mt-1"
              value={formLeadId}
              onChange={(e) => setFormLeadId(e.target.value)}
            >
              <option value="">— No linked customer —</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>{l.companyName || l.contactName || "Unnamed lead"}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="create-product" className="label">Product / item name <span className="text-danger-fg">*</span></label>
            <input
              id="create-product"
              className="input mt-1"
              value={formProduct}
              onChange={(e) => setFormProduct(e.target.value)}
              placeholder="e.g. Precision component (10-unit pack)"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="create-qty" className="label">Quantity <span className="text-danger-fg">*</span></label>
              <input
                id="create-qty"
                type="number"
                min="0"
                step="any"
                className="input mt-1"
                value={formQty}
                onChange={(e) => setFormQty(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="create-price" className="label">Unit price (₹) <span className="text-danger-fg">*</span></label>
              <input
                id="create-price"
                type="number"
                min="0"
                step="0.01"
                className="input mt-1"
                value={formPrice}
                onChange={(e) => setFormPrice(e.target.value)}
              />
            </div>
          </div>
          {createOpen === "order" && (
            <div>
              <label htmlFor="create-status" className="label">Order status</label>
              <select
                id="create-status"
                className="input mt-1"
                value={formOrderStatus}
                onChange={(e) => setFormOrderStatus(e.target.value as "draft" | "confirmed")}
              >
                <option value="confirmed">Confirmed (record this order now)</option>
                <option value="draft">Draft (save for review)</option>
              </select>
            </div>
          )}
          <p className="text-xs text-muted">
            Total: {previewTotal([{ quantity: Number(formQty || 0), unitPrice: Number(formPrice || 0) }])}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" disabled={Boolean(busy)} onClick={() => { if (!busy) setCreateOpen(null); }}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy.startsWith("Creating ")}
              onClick={submitCreate}
            >
              Create {createOpen || ""}
            </Button>
          </div>
        </fieldset>
      </Modal>

      {/* 2026-08-02 (UX redesign): Order detail now a Drawer slide-over
          (NN/g top-ranked master-detail — keeps the list visible behind it,
          so the operator can act on the next record without re-navigating).
          Was a centered Modal that hid adjacent rows. */}
      <Drawer
        open={detailOrder !== null}
        onOpenChange={(o) => { if (!o) setDetailOrder(null); }}
        title={detailOrder ? `Order #${detailOrder.orderNumber}` : ""}
        description={detailOrder ? `${customerNameFor(detailOrder.leadId)} · ${displayOrderStatus(detailOrder.status)} · ${formatMoney(detailOrder.grandTotal, detailOrder.currencyCode)}` : undefined}
        size="lg"
      >
        {detailOrder && (
          <DrawerBody>
            <div className="space-y-4">
              {actionBanner}
              {!readOnly && <div className="flex flex-wrap gap-2">
                {["confirmed", "in_progress", "partial_shipped", "partial_cancelled"].includes(detailOrder.status) && <Button size="sm" disabled={!!busy} onClick={() => openQuantities(detailOrder, "ship")}>Record shipment</Button>}
                {["draft", "quoted", "confirmed", "in_progress", "partial_shipped", "partial_cancelled"].includes(detailOrder.status) && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => openQuantities(detailOrder, "cancel")}>Cancel item quantities</Button>}
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => { setDetailOrder(null); setPendingConfirm({ kind: "repeatOrder", id: detailOrder.id }); }}>Repeat order as draft</Button>
              </div>}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted">Status:</span> <Badge tone={displayOrderStatusTone(detailOrder.status)}>{displayOrderStatus(detailOrder.status)}</Badge></div>
                {!readOnly && nextOrderStatuses(detailOrder.status).length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted">Advance to:</span>
                    <select
                      className="input input-sm"
                      value=""
                      disabled={busy !== ""}
                      onChange={(e) => e.target.value && changeOrderStatus(detailOrder.id, e.target.value)}
                      aria-label="Advance order status"
                    >
                      <option value="">Select next status…</option>
                      {/* N-DATA-12 (2026-08-20): the options come from the SHARED
                          transition map the API validates against, so the list
                          can no longer offer a move the server refuses. This
                          list used to be every status except the current one,
                          which is how the drawer came to invite an operator to
                          walk a delivered order back to Draft. */}
                      {/* 2026-09-27 (review M8): a part shipment needs a count
                          per item, which this menu cannot take — the server
                          refuses it without counts, so it is not offered here. */}
                      {nextOrderStatuses(detailOrder.status)
                        .filter((s) => s !== "partial_shipped")
                        .map((s) => <option key={s} value={s}>{displayOrderStatus(s)}</option>)}
                    </select>
                  </div>
                )}
                <div><span className="text-muted">Total:</span> {formatMoney(detailOrder.grandTotal, detailOrder.currencyCode)}</div>
                {detailOrder.reorderedFromOrderId && <p className="col-span-2 text-muted">Repeat order saved as a new draft. Review the original quantities and prices before confirming.</p>}
                {detailOrder.lineItems.some(item => item.priceChangedSinceLastOrder) && <p role="status" className="col-span-2 text-warning-fg">Catalogue prices have changed since the original order. This draft keeps the previous agreed rates for your review.</p>}
                {/* 2026-08-05 N-P1-5: customer name was dead text. Now a clickable
                    link back to the lead's CRM record (the "Everything Connected"
                    reverse jump — order → customer). */}
                <div><span className="text-muted">Customer:</span> {onFocusLead && detailOrder.leadId ? <button className="font-medium text-primary underline" onClick={() => onFocusLead(detailOrder.leadId!, "crm")}>{customerNameFor(detailOrder.leadId)}</button> : <span className="font-medium">{customerNameFor(detailOrder.leadId)}</span>}</div>
                <div><span className="text-muted">Origin:</span> {detailOrder.origin === "from_quote" ? "From quote" : "Direct"}</div>
                <div><span className="text-muted">Created:</span> {formatDateTime(detailOrder.createdAt)}</div>
                {detailOrder.confirmedAt && <div><span className="text-muted">Confirmed:</span> {formatDateTime(detailOrder.confirmedAt)}</div>}
                {/* N-UX-11 (2026-08-20): an order could say "Delivered" while the
                    screen showed no delivery date anywhere in the app. The API
                    stamps shippedAt/deliveredAt on every transition (route.ts,
                    F7) and both substrates persist them — but a repo-wide grep
                    for these two fields across every .tsx returned ZERO hits, so
                    the two dates a customer actually calls about ("when did it
                    ship, when did it land") were recorded and never shown. The
                    QUOTE drawer twenty lines below has rendered its Sent/Accepted
                    analogues all along; this is that pair, restored. */}
                {detailOrder.shippedAt && <div><span className="text-muted">Shipped:</span> {formatDateTime(detailOrder.shippedAt)}</div>}
                {detailOrder.deliveredAt && <div><span className="text-muted">Delivered:</span> {formatDateTime(detailOrder.deliveredAt)}</div>}
                {detailOrder.cancelledAt && <div><span className="text-muted">Cancelled:</span> {formatDateTime(detailOrder.cancelledAt)}</div>}
                {detailOrder.discountGiven && <div className="col-span-2"><Badge tone="warning">Discount given ({formatMoney(detailOrder.totalDiscountAmount, detailOrder.currencyCode)})</Badge></div>}
                {detailOrder.cancelReason && <div className="col-span-2"><span className="text-muted">Cancel reason:</span> {detailOrder.cancelReason}</div>}
              </div>
              <div>
                <h4 className="text-sm font-semibold mb-2">Line items</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Unit price</TableHead>
                      <TableHead>Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(detailOrder.lineItems || []).map((li, index) => {
                      const cancelledQty = detailOrder.cancelledQuantityByLine?.[li.id] ?? 0;
                      const survivingQty = Math.max(0, sumQuantitiesExact(li.quantity, -cancelledQty));
                      const effectiveTotal = cancelledQty > 0
                        ? computeLineTotalPaise(survivingQty, li.unitPrice)
                        : Number(li.lineTotal || 0);
                      return (
                        <TableRow key={li.id || `line-${index}`}>
                          <TableCell>{li.productName}{li.sku ? ` (${li.sku})` : ""}</TableCell>
                          <TableCell>
                            {li.quantity} {li.unit}
                            {(detailOrder.shippedQuantityByLine?.[li.id] || 0) > 0 && <span className="block text-muted">{detailOrder.shippedQuantityByLine?.[li.id]} shipped</span>}
                            {cancelledQty > 0 && (
                              <span className="text-muted ml-1">({cancelledQty} cancelled → {survivingQty} remaining)</span>
                            )}
                          </TableCell>
                          <TableCell>{formatUnitPriceMoney(li.unitPrice, detailOrder.currencyCode)}</TableCell>
                          <TableCell>
                            {formatMoney(effectiveTotal, detailOrder.currencyCode)}
                            {cancelledQty > 0 && Number(li.lineTotal || 0) !== effectiveTotal && (
                              <span className="text-muted line-through ml-1">{formatMoney(li.lineTotal, detailOrder.currencyCode)}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {detailOrder.notes && <p className="text-sm"><span className="text-muted">Notes:</span> {detailOrder.notes}</p>}
            </div>
          </DrawerBody>
        )}
      </Drawer>

      {/* Quote detail Drawer — same slide-over pattern. */}
      <Drawer
        open={detailQuote !== null}
        onOpenChange={(o) => { if (!o) setDetailQuote(null); }}
        title={detailQuote ? `Quote #${detailQuote.quoteNumber}` : ""}
        description={detailQuote ? `${customerNameFor(detailQuote.leadId)} · ${displayQuoteStatus(detailQuote.status)} · ${formatMoney(detailQuote.grandTotal, detailQuote.currencyCode)}` : undefined}
        size="lg"
      >
        {detailQuote && (
          <DrawerBody>
            <div className="space-y-4">
              {actionBanner}
              {!readOnly && <div className="flex flex-wrap gap-2">
                {["draft", "sent", "rejected", "expired"].includes(detailQuote.status) && <Button size="sm" disabled={!!busy} onClick={() => reviseQuote(detailQuote.id)}>Revise prices and quantities</Button>}
                <Button size="sm" variant="secondary" disabled={!!busy || !detailQuote.leadId} onClick={() => downloadQuote(detailQuote)}>Download quote PDF</Button>
              </div>}
              {!detailQuote.leadId && <p className="text-sm text-muted">Link a quote to a customer when creating it to prepare its customer PDF.</p>}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted">Status:</span> <Badge tone={displayQuoteStatusTone(detailQuote.status)}>{displayQuoteStatus(detailQuote.status)}</Badge></div>
                {!readOnly && nextQuoteStatuses(detailQuote.status).length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted">Mark as:</span>
                    <select
                      className="input input-sm"
                      value=""
                      disabled={busy !== ""}
                      onChange={(e) => e.target.value && changeQuoteStatus(detailQuote.id, e.target.value)}
                      aria-label="Update quote status"
                    >
                      <option value="">Select status…</option>
                      {/* "superseded" is NOT offered here (F-DATA-5 / D5): it is
                          set only by POST /quotes/:id/revise, which also creates
                          and links the replacement. Setting it by hand produced a
                          retired quote with no successor and no price history. */}
                      {/* N-DATA-12: same shared map as the orders list above. */}
                      {nextQuoteStatuses(detailQuote.status)
                        .map((s) => <option key={s} value={s}>{displayQuoteStatus(s)}</option>)}
                    </select>
                  </div>
                )}
                <div><span className="text-muted">Total:</span> {formatMoney(detailQuote.grandTotal, detailQuote.currencyCode)}</div>
                <div><span className="text-muted">Created:</span> {formatDateTime(detailQuote.createdAt)}</div>
                {detailQuote.validityNote && <div><span className="text-muted">Validity:</span> {detailQuote.validityNote}</div>}
                {detailQuote.sentAt && <div><span className="text-muted">Sent:</span> {formatDateTime(detailQuote.sentAt)}</div>}
                {detailQuote.acceptedAt && <div><span className="text-muted">Accepted:</span> {formatDateTime(detailQuote.acceptedAt)}</div>}
              </div>
              <div>
                <h4 className="text-sm font-semibold mb-2">Line items</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Unit price</TableHead>
                      <TableHead>Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(detailQuote.lineItems || []).map((li, index) => (
                      <TableRow key={li.id || `line-${index}`}>
                        <TableCell>{li.productName}{li.sku ? ` (${li.sku})` : ""}</TableCell>
                        <TableCell>{li.quantity} {li.unit}</TableCell>
                        <TableCell>{formatUnitPriceMoney(li.unitPrice, detailQuote.currencyCode)}</TableCell>
                        <TableCell>{formatMoney(li.lineTotal, detailQuote.currencyCode)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {detailQuote.notes && <p className="text-sm"><span className="text-muted">Notes:</span> {detailQuote.notes}</p>}
            </div>
          </DrawerBody>
        )}
      </Drawer>

      <Modal open={revision !== null} onClose={() => { if (!busy) setRevision(null); }} title={revision ? `Revise quote #${revision.quoteNumber}` : "Revise quote"} size="lg" disableDismiss={!!busy}>
        {revision && <div className="space-y-4">
          <p className="text-sm text-muted">Edit the agreed quantities and rates below. Saving creates a new draft and preserves this quote as the previous version. Nothing is sent to the customer.</p>
          {formError && <p role="alert" className="text-sm text-danger-fg">{formError}</p>}
          {revision.lineItems.map((item, index) => <div key={item.id} className="rounded-md border border-border-default p-3 space-y-2">
            <p className="font-medium text-sm">{item.productName}{item.sku ? ` (${item.sku})` : ""}</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">Quantity{item.unit ? ` (${item.unit})` : ""}<input className="input mt-1" type="number" min="0" step="any" aria-label={`Revised quantity for ${item.productName}`} value={revisionLines[index]?.quantity || ""} disabled={!!busy} onChange={event => setRevisionLines(lines => lines.map((line, position) => position === index ? { ...line, quantity: event.target.value } : line))} /></label>
              <label className="text-sm">Unit price ({revision.currencyCode})<input className="input mt-1" type="number" min="0" step="any" aria-label={`Revised unit price for ${item.productName}`} value={revisionLines[index]?.unitPrice || ""} disabled={!!busy} onChange={event => setRevisionLines(lines => lines.map((line, position) => position === index ? { ...line, unitPrice: event.target.value } : line))} /></label>
            </div>
          </div>)}
          <label className="block text-sm">Notes<textarea className="input mt-1" value={revisionNotes} maxLength={10000} disabled={!!busy} onChange={event => setRevisionNotes(event.target.value)} /></label>
          <p className="font-semibold text-sm">Revised total: {previewTotal(revisionLines.map(item => ({ quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) })), revision.currencyCode)}</p>
          <div className="flex justify-end gap-2"><Button variant="secondary" disabled={!!busy} onClick={() => setRevision(null)}>Keep existing quote</Button><Button loading={!!busy} onClick={saveRevision}>Save revised quote</Button></div>
        </div>}
      </Modal>

      <Modal open={quantityOrder !== null} onClose={() => { if (!busy) setQuantityOrder(null); }} title={quantityKind === "ship" ? "Record item shipment" : "Cancel item quantities"} size="lg" disableDismiss={!!busy}>
        {quantityOrder && <div className="space-y-4">
          <p className="text-sm text-muted">{quantityKind === "ship" ? "Enter the total quantity shipped so far, including previous dispatches. Cancelled items cannot be shipped." : "Enter only the additional quantities to cancel now. Previously shipped items cannot be cancelled."}</p>
          {formError && <p role="alert" className="text-sm text-danger-fg">{formError}</p>}
          {quantityOrder.lineItems.map(item => {
            const shipped = quantityOrder.shippedQuantityByLine?.[item.id] || 0;
            const cancelled = quantityOrder.cancelledQuantityByLine?.[item.id] || 0;
            const available = Math.max(0, sumQuantitiesExact(item.quantity, -shipped, -cancelled));
            return <div key={item.id} className="rounded-md border border-border-default p-3 space-y-2">
              <p className="font-medium text-sm">{item.productName}</p>
              <p className="text-xs text-muted">Ordered: {item.quantity} · Shipped: {shipped} · Cancelled: {cancelled} · Remaining: {available}{item.unit ? ` ${item.unit}` : ""}</p>
              <label className="block text-sm">{quantityKind === "ship" ? "Total shipped so far" : "Cancel now"}<input className="input mt-1" type="number" step="any" min={quantityKind === "ship" ? shipped : 0} max={quantityKind === "ship" ? sumQuantitiesExact(item.quantity, -cancelled) : available} aria-label={`${quantityKind === "ship" ? "Total shipped" : "Cancel quantity"} for ${item.productName}`} value={quantities[item.id] || ""} disabled={!!busy} onChange={event => setQuantities(current => ({ ...current, [item.id]: event.target.value }))} /></label>
            </div>;
          })}
          {quantityKind === "cancel" && <label className="block text-sm">Reason for cancellation<textarea className="input mt-1" value={cancelReason} maxLength={2000} disabled={!!busy} onChange={event => setCancelReason(event.target.value)} /></label>}
          <div className="flex justify-end gap-2"><Button variant="secondary" disabled={!!busy} onClick={() => setQuantityOrder(null)}>Go back</Button><Button loading={!!busy} onClick={saveQuantities}>{quantityKind === "ship" ? "Save shipped quantities" : "Confirm quantity cancellation"}</Button></div>
        </div>}
      </Modal>

      {/* S6 U-3: accessible confirmation for destructive actions (was window.confirm). */}
      <ConfirmModal
        open={pendingConfirm !== null}
        title={pendingConfirm?.kind === "cancelOrder" ? "Cancel this order?" : pendingConfirm?.kind === "repeatOrder" ? "Repeat this order?" : "Convert this quote?"}
        confirmLabel={pendingConfirm?.kind === "cancelOrder" ? "Cancel order" : pendingConfirm?.kind === "repeatOrder" ? "Create repeat draft" : "Convert to order"}
        tone="danger"
        loading={busy !== ""}
        onConfirm={() => {
          const pc = pendingConfirm;
          setPendingConfirm(null);
          if (!pc) return;
          if (pc.kind === "cancelOrder") void doCancelOrder(pc.id);
          else if (pc.kind === "repeatOrder") void repeatOrder(pc.id);
          else void doConvertQuote(pc.id);
        }}
        onClose={() => setPendingConfirm(null)}
      >
        {pendingConfirm?.kind === "cancelOrder"
          ? "This cannot be undone. The order will be marked cancelled and the customer record preserved."
          : pendingConfirm?.kind === "repeatOrder"
            ? "Create a separate draft with the original item quantities and previous prices. Review it before confirming. The original order is preserved."
            : "The quote will be marked as converted. An order will be created from its line items."}
      </ConfirmModal>
    </div>
  );
}
