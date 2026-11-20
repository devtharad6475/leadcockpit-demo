/**
 * Add or edit products — the editor behind Catalogue → "Add or edit products".
 *
 * 2026-09-30 (page guide, redesign round 2): this editor used to be the
 * "Products" tab inside Settings, while the Catalogue screen — the page named
 * for products — could only show them and sent the owner to Settings to add
 * one. It now lives with the catalogue. Same endpoint, same fields, same
 * "paste in your words" drafting; nothing is saved until the owner presses Save.
 */
"use client";
import React, { useCallback, useEffect, useState } from "react";
import { Button, ConfirmModal } from "@/components/ui";
import { Field } from "@/components/ui/primitives";
import { Sparkles, Trash2, Plus } from "lucide-react";
import { api } from "@/lib/api-client";
import { joinList, splitList } from "@/lib/settings-field-shapes";
import type { ProductSetting, ProductSettings } from "@/lib/types";
import { workspaceId } from "@/app/page";
import { mergeProducts } from "@/app/sections/StructuredSettings";

export function ProductEditor({ onSaved, onDirtyChange, onBusyChange }: { onSaved?: () => void; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const [products, setProducts] = useState<ProductSetting[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedProducts, setSavedProducts] = useState("[]");
  const [savedNotes, setSavedNotes] = useState("");
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoaded(false);
    setLoadError(null);
    try {
      const data = await api<ProductSettings>("/api/settings/products");
      setProducts(data.products || []);
      setSavedProducts(JSON.stringify(data.products || []));
    } catch (e) { setLoadError(e instanceof Error ? e.message : "Couldn't load your products."); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const dirty = loaded && (JSON.stringify(products) !== savedProducts || notes !== savedNotes || Object.entries(priceInputs).some(([id, value]) => {
    const product = products.find(item => item.id === id);
    return product && value !== (product.price === undefined ? "" : String(product.price));
  }));
  useEffect(() => { onDirtyChange?.(Boolean(dirty)); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(saving || drafting); }, [saving, drafting, onBusyChange]);

  function update(index: number, field: keyof ProductSetting, value: unknown) {
    setProducts((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }

  function add() {
    setProducts((prev) => [...prev, {
      id: `prod_${Date.now()}`, name: "", category: "", material: "", packaging: "", moq: "",
      inStockDispatchTime: "", productionDispatchTime: "", customizationAvailable: false, useCaseTags: [], notes: "",
    }]);
  }

  async function draftFromNotes() {
    if (saving || drafting) return;
    setDrafting(true);
    setDraftMessage("");
    try {
      const result = await api<{ products: ProductSetting[]; warnings: string[] }>("/api/settings/products/draft", { method: "POST", body: { workspaceId, notes } });
      if (!result.products.length) {
        setDraftMessage(result.warnings[0] || "No products were found in that text.");
        return;
      }
      setProducts((prev) => mergeProducts(prev, result.products));
      setDraftMessage(`Added ${result.products.length} product${result.products.length === 1 ? "" : "s"} below for you to check. Nothing is saved until you press Save.`);
    } catch (e) {
      setDraftMessage(e instanceof Error ? e.message : "Couldn't read that text.");
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    if (saving || drafting) return;
    const reviewed = products.map(product => {
      const raw = priceInputs[product.id] ?? (product.price === undefined ? "" : String(product.price));
      const amount = Number(raw.trim());
      if (raw.trim() && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()) || !Number.isFinite(amount) || amount < 0)) return null;
      return { ...product, price: raw.trim() ? amount : undefined };
    });
    if (reviewed.some(product => product === null)) {
      setMessage({ tone: "danger", text: "Enter a valid price of zero or more. Leave the price blank if it is not known. Nothing was saved." });
      return;
    }
    const validProducts = reviewed.filter(product => product !== null);
    setSaving(true);
    setMessage(null);
    try {
      await api("/api/settings/products", { method: "PUT", body: { workspaceId, products: validProducts } });
      setProducts(validProducts);
      setSavedProducts(JSON.stringify(validProducts));
      setSavedNotes(notes);
      setPriceInputs({});
      setMessage({ tone: "success", text: "Saved. The AI uses these products and prices from now on." });
      onSaved?.();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't save your products." });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="space-y-3"><p role="alert" className="text-sm text-danger-fg">{loadError}</p><Button variant="secondary" onClick={() => void load()}>Try products again</Button></div>;
  if (!loaded) return <p className="text-sm text-muted animate-pulse">Loading your products…</p>;

  return (
    <fieldset disabled={saving || drafting} className="space-y-5 min-w-0">
      <section className="rounded-md border border-border-default bg-surface-tint p-3">
        <p className="flex items-center gap-2 font-semibold text-foreground"><Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> Paste product details in your words</p>
        <p className="mt-1 text-sm text-muted-2">One product per line. The AI turns them into rows below for you to check.</p>
        <textarea
          className="input mt-2 min-h-24"
          aria-label="Product details in your words"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Gold zari thread – Rs. 250 per kg, MOQ 5 kg, dispatch 3 days"
        />
        <Button className="mt-2" size="sm" variant="secondary" icon={Sparkles} loading={drafting} disabled={!notes.trim()} onClick={draftFromNotes}>
          Turn into product rows
        </Button>
        {draftMessage ? <p role="status" className="mt-2 text-sm text-muted-2">{draftMessage}</p> : null}
      </section>

      {products.map((product, index) => (
        <section key={product.id} className="rounded-md border border-border-default bg-surface p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-semibold text-foreground">{product.name || `Product ${index + 1}`}</p>
            <button type="button" className="btn secondary text-xs text-danger-fg" onClick={() => setRemoving(product.id)} aria-label={`Remove ${product.name || `Product ${index + 1}`}`}>
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" value={product.name} onChange={(v) => update(index, "name", v)} />
            <Field label="Category" value={product.category || ""} onChange={(v) => update(index, "category", v)} />
            {/* 2026-09-08 — price and its unit: blank clears the price rather than storing 0. */}
            <Field
              label="Price (number only)"
              value={priceInputs[product.id] ?? (product.price === undefined ? "" : String(product.price))}
              onChange={(v) => setPriceInputs(current => ({ ...current, [product.id]: v }))}
            />
            <Field label="Price per (kg, piece, metre)" value={product.priceUnit || ""} onChange={(v) => update(index, "priceUnit", v)} />
            <Field label="Minimum order" value={product.moq || ""} onChange={(v) => update(index, "moq", v)} />
            <Field label="Material" value={product.material || ""} onChange={(v) => update(index, "material", v)} />
            <Field label="Packaging" value={product.packaging || ""} onChange={(v) => update(index, "packaging", v)} />
            <Field label="Dispatch time when in stock" value={product.inStockDispatchTime || ""} onChange={(v) => update(index, "inStockDispatchTime", v)} />
            <Field label="Dispatch time when made to order" value={product.productionDispatchTime || ""} onChange={(v) => update(index, "productionDispatchTime", v)} />
            <Field label="Used for (comma-separated)" value={joinList(product.useCaseTags)} onChange={(v) => update(index, "useCaseTags", splitList(v))} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={product.customizationAvailable || false} onChange={(e) => update(index, "customizationAvailable", e.target.checked)} />
              Can be customised
            </label>
            <Field label="Notes" value={product.notes || ""} onChange={(v) => update(index, "notes", v)} />
          </div>
        </section>
      ))}

      {!products.length ? (
        <p className="rounded-md border border-dashed border-border-default bg-surface p-4 text-sm text-muted-2">
          No products yet. Paste them above, or add one at a time.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
        <Button loading={saving} onClick={save}>Save products</Button>
        <Button variant="secondary" icon={Plus} onClick={add}>Add a product</Button>
        {dirty && <span className="text-xs text-warning-fg">Unsaved product changes</span>}
      </div>
      <ConfirmModal open={removing !== null} title="Remove this product from the list?" confirmLabel="Remove from draft" cancelLabel="Keep product" tone="danger" onClose={() => setRemoving(null)} onConfirm={() => {
        setProducts(current => current.filter(product => product.id !== removing));
        setPriceInputs(current => { const next = { ...current }; if (removing) delete next[removing]; return next; });
        setRemoving(null);
      }}>
        This only changes your draft. The saved catalogue changes when you press Save products.
      </ConfirmModal>
      {message ? (
        <p role="status" className={`text-sm ${message.tone === "danger" ? "text-danger-fg" : "text-success-fg"}`}>{message.text}</p>
      ) : null}
    </fieldset>
  );
}
