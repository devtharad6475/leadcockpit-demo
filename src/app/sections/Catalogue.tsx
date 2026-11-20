/**
 * 2026-07-21 (M8) — Product Catalogue screen.
 *
 * Per docs/UI-DESIGN.md M8: shows the workspace's products with their
 * variants + prices. Includes a "Preview price-change notifications"
 * action that calls the preview endpoint (read-only, no sends).
 *
 * Backend: existing /api/settings/products GET/PUT + the new
 * /api/price-change/preview endpoint (read-only).
 *
 * Uses the new design system + displayLabel.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, Badge, Button, EmptyState, Spinner, ConfirmModal, Drawer, DrawerBody } from "@/components/ui";
import { ProductEditor } from "@/app/sections/ProductEditor";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui";
import { Package, AlertCircle, Tag, Bell, Pencil } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatINR } from "@/lib/money"; // 2026-08-02 audit P2-1: ONE shared currency formatter

type CatalogueProduct = {
  id: string;
  name: string;
  category?: string;
  price?: number;
  priceUnit?: string;
  productMode?: "simple" | "variant";
  variants?: Array<{ id: string; name: string; sku?: string; price?: number; priceUnit?: string }>;
  inStockNote?: string;
};

type ProductSettingsResponse = {
  products: CatalogueProduct[];
};

type PriceChangePreview = {
  productId: string;
  productName: string;
  oldPrice: number;
  newPrice: number;
  recipientCount: number;
  skippedDncCount: number;
  messages: Array<{
    leadId: string;
    customerName: string;
    body: string;
    direction: "increased" | "decreased";
    diff: number;
  }>;
};

// 2026-09-30 (page guide, redesign round 2): products are added and edited
// here now ("Add or edit products" opens the editor in a side panel). The page
// used to be read-only and send the owner to Settings → Products.
export function Catalogue(_props: { setActive?: (tab: "settings") => void } = {}) {
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [editing, setEditing] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [confirmEditorClose, setConfirmEditorClose] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
    // 2026-08-05 E-P1-1: action errors show inline (list stays visible), not full-screen wipe.
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [preview, setPreview] = useState<PriceChangePreview | null>(null);
  // F4 (2026-08-04 CONTINUOUS-2 audit): per-product new-price state. Previously
  // a single shared string — typing in row 1 then row 5 made BOTH inputs show
  // the latest value, and Preview on row 1 sent row 5's price. Keyed by
  // productId so each row owns its own value.
  const [newPriceByProduct, setNewPriceByProduct] = useState<Record<string, string>>({});
  // R6 — send state.
  const [sending, setSending] = useState(false);
  const [sendResults, setSendResults] = useState<{
    sentCount: number;
    skippedCount: number;
    results: Array<{ leadId: string; customerName: string; status: string; error?: string }>;
    providerConfigured: boolean;
  } | null>(null);

  // quiet: refresh the list without swapping the page for a spinner — used
  // after a save, while the editor side panel is still open on top of it.
  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const data = await api<ProductSettingsResponse>(`/api/settings/products`);
      setProducts(data.products || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function previewPriceChange(productId: string, productName: string, oldPrice: number) {
    const np = Number(newPriceByProduct[productId]);
    if (!np || np <= 0) {
      setActionError("Enter a valid new price first.");
      return;
    }
    setPreviewing(productId);
    setError(null);
    setSendResults(null);
    try {
      const url = `/api/price-change/preview?productId=${encodeURIComponent(productId)}&newPrice=${np}`;
      const result = await api<PriceChangePreview>(url);
      setPreview(result);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(null);
    }
  }

  /**
   * R6 2026-07-21 — Actually send the price-change notifications to all
   * previewed recipients. Two-step approval: this is step 2 (the owner's
   * explicit click). Per AGENTS.md this is NOT auto-outreach — it's a
   * human-approved send, same as approveAutoReplyLog.
   */
  // S6 U-3: confirm-dialog state for the price-change broadcast.
  const [confirmBroadcast, setConfirmBroadcast] = useState(false);

  async function sendAllNotifications() {
    if (!preview) return;
    // S6 U-3: was window.confirm() — replaced with an accessible ConfirmModal.
    setConfirmBroadcast(true);
  }
  async function doSendAllNotifications() {
    if (!preview) return;
    setSending(true);
    setError(null);
    try {
      const result = await api<{
        sentCount: number;
        skippedCount: number;
        results: Array<{ leadId: string; customerName: string; status: string; error?: string }>;
        providerConfigured: boolean;
      }>("/api/price-change/send", {
        method: "POST",
        body: {
          productId: preview.productId,
          oldPrice: preview.oldPrice,
          newPrice: preview.newPrice,
          leadIds: preview.messages.map((m) => m.leadId),
        },
      });
      setSendResults(result);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <Card title="Product catalogue" icon={Package}>
        <div className="flex items-center gap-2 justify-center py-8 text-muted">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card title="Product catalogue" icon={AlertCircle}>
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load"
          description={error}
          action={<Button onClick={() => void load()}>Try again</Button>}
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

  const editor = (
    <>
    <Drawer open={editing} onOpenChange={(o) => {
      if (!o && editorBusy) return;
      if (!o && editorDirty) { setConfirmEditorClose(true); return; }
      setEditing(o);
      if (!o) void load(true);
    }} disableDismiss={editorBusy || confirmEditorClose} title="Add or edit products" description="Your products, prices and minimum orders" size="lg">
      <DrawerBody>
        <ProductEditor onSaved={() => void load(true)} onDirtyChange={setEditorDirty} onBusyChange={setEditorBusy} />
        <ConfirmModal open={confirmEditorClose} title="Leave without saving your products?" confirmLabel="Discard changes" cancelLabel="Keep editing" tone="danger" onClose={() => setConfirmEditorClose(false)} onConfirm={() => {
      setConfirmEditorClose(false); setEditorDirty(false); setEditing(false); void load(true);
    }}>
      Your saved catalogue stays as it is. These unfinished edits will be discarded.
    </ConfirmModal>
      </DrawerBody>
    </Drawer>
    </>
  );

  if (products.length === 0) {
    return (
      <>
      <Card title="Product catalogue" icon={Package}>
        {/* N-UX-13 (2026-09-01) — this was a dead end: the only screen in the
            product with zero controls. It told the operator to go to
            "Settings → Products" and then made them find it themselves. An
            empty state that names a destination should be able to reach it. */}
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add what you sell, with its price and minimum order. The AI needs these before it can quote anyone."
          action={<Button icon={Package} onClick={() => setEditing(true)}>Add your products</Button>}
        />
      </Card>
      {editor}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {actionBanner}
      <Card
        title={`Product catalogue (${products.length})`}
        icon={Package}
        padding="none"
        action={<Button size="sm" icon={Pencil} onClick={() => setEditing(true)}>Add or edit products</Button>}
      >
        <Table caption="Products">
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Variants</TableHead>
              <TableHead>Tell customers about a new price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <p className="font-semibold text-foreground">{p.name}</p>
                  {p.category && <p className="text-xs text-muted">{p.category}</p>}
                </TableCell>
                <TableCell>
                  {p.price !== undefined ? (
                    <span>{formatINR(p.price)} <span className="text-xs text-muted">{p.priceUnit || ""}</span></span>
                  ) : (
                    <Badge tone="warning">No price set</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {p.variants && p.variants.length > 0 ? (
                    <ul className="text-xs text-muted space-y-0.5">
                      {p.variants.slice(0, 3).map((v) => (
                        <li key={v.id}>
                          <Tag className="inline h-3 w-3 mr-1" />
                          {v.name}
                          {v.price !== undefined && ` — ${formatINR(v.price)}`}
                        </li>
                      ))}
                      {p.variants.length > 3 && <li>... {p.variants.length - 3} more</li>}
                    </ul>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      className="input input-sm w-24"
                      placeholder="New ₹"
                      value={newPriceByProduct[p.id] ?? ""}
                      onChange={(e) => setNewPriceByProduct((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      aria-label={`New price for ${p.name}`}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={previewing === p.id}
                      icon={Bell}
                      onClick={() => previewPriceChange(p.id, p.name, p.price ?? 0)}
                    >
                      Preview
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {preview && (
        <Card
          title={`Price-change preview: ${preview.productName}`}
          icon={Bell}
          action={<Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Close</Button>}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-surface-muted p-3">
              <div>
                <p className="label">Old price</p>
                <p className="font-semibold text-foreground">{formatINR(preview.oldPrice)}</p>
              </div>
              <div>
                <p className="label">New price</p>
                <p className="font-semibold text-foreground">{formatINR(preview.newPrice)}</p>
              </div>
              <div>
                <p className="label">Difference</p>
                <p className={`font-semibold ${preview.newPrice > preview.oldPrice ? "text-danger-fg" : "text-success-fg"}`}>
                  {preview.newPrice > preview.oldPrice ? "+" : "-"}{formatINR(Math.abs(preview.newPrice - preview.oldPrice))}
                </p>
              </div>
              <div>
                <p className="label">Would notify</p>
                <p className="font-semibold text-foreground">{preview.recipientCount} customer{preview.recipientCount === 1 ? "" : "s"}</p>
              </div>
              {preview.skippedDncCount > 0 && (
                <div>
                  <p className="label">Skipped (asked not to be contacted)</p>
                  <p className="font-semibold text-foreground">{preview.skippedDncCount}</p>
                </div>
              )}
            </div>

            <p className="text-sm text-muted">
              A preview only — nothing has been sent. &ldquo;Send all&rdquo; sends these on WhatsApp.
              Anyone who asks not to be contacted before then is skipped, and every message is recorded in Activity.
            </p>

            {preview.messages.length > 0 && (
              <ul className="space-y-2">
                {preview.messages.map((m) => (
                  <li key={m.leadId} className="rounded-md border border-border-subtle bg-surface-muted p-2 text-sm">
                    <p className="font-semibold text-foreground">{m.customerName}</p>
                    <p className="mt-1 text-foreground">{m.body}</p>
                  </li>
                ))}
              </ul>
            )}

            {/* R6 — Send button + results */}
            {preview.messages.length > 0 && !sendResults && (
              <div className="flex items-center gap-2">
                <Button variant="primary" loading={sending} onClick={sendAllNotifications}>
                  Send all ({preview.messages.length})
                </Button>
                <span className="text-xs text-muted">
                  Needs WhatsApp set up on the Integrations page; without it nothing is delivered.
                </span>
              </div>
            )}

            {sendResults && (
              <div className="space-y-2 rounded-md border border-border-subtle bg-surface-muted p-3 text-sm">
                <div className="flex flex-wrap gap-3">
                  <div>
                    <p className="label">Sent</p>
                    <p className="font-semibold text-success-fg">{sendResults.sentCount}</p>
                  </div>
                  <div>
                    <p className="label">Skipped / failed</p>
                    <p className="font-semibold text-warning-fg">{sendResults.skippedCount}</p>
                  </div>
                  <div>
                    <p className="label">WhatsApp set up</p>
                    <p className="font-semibold text-foreground">{sendResults.providerConfigured ? "Yes" : "No — set it up on the Integrations page"}</p>
                  </div>
                </div>
                <ul className="space-y-1 text-xs">
                  {sendResults.results.map((r) => (
                    <li key={r.leadId} className="flex gap-2">
                      <span className="font-semibold text-foreground">{r.customerName}:</span>
                      <span className={
                        r.status === "sent" ? "text-success-fg" :
                        r.status === "skipped_dnc" ? "text-muted" :
                        "text-danger-fg"
                      }>
                        {r.status === "sent" ? "Delivered" :
                         r.status === "skipped_dnc" ? "Skipped (asked not to be contacted)" :
                         r.status === "no_number" ? "No WhatsApp number on file" :
                         r.status === "not_configured" ? "WhatsApp not set up" :
                         `Failed: ${r.error || "unknown error"}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted">
                  Recorded in Activity. The price itself was not changed — change it with &ldquo;Add or edit products&rdquo;.
                </p>
              </div>
            )}
          </div>
        </Card>
      )}

      {editor}

      {/* S6 U-3: accessible confirmation for the price-change broadcast (was window.confirm). */}
      <ConfirmModal
        open={confirmBroadcast}
        title={preview ? `Send ${preview.recipientCount} price-change message${preview.recipientCount === 1 ? "" : "s"}?` : "Send price-change messages?"}
        confirmLabel="Send messages"
        tone="danger"
        onConfirm={() => { setConfirmBroadcast(false); void doSendAllNotifications(); }}
        onClose={() => setConfirmBroadcast(false)}
      >
        This sends the price-change message to each customer on WhatsApp. Customers who asked not to be contacted are skipped. Every message is recorded in Activity.
      </ConfirmModal>
    </div>
  );
}
