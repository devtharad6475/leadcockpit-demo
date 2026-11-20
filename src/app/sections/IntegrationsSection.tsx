/**
 * Integrations screen — what this workspace is connected to.
 *
 * 2026-09-30 redesign (page guide, CEO-approved "worst first"). The screen used
 * to stack seven unrelated sections: a WhatsApp status banner, the credential
 * form, integration keys, a server environment checklist, the Meta webhook
 * guide, the media gallery, and eight "future" cards. It now reads at a glance:
 *
 *   1. Your connections — one row each for WhatsApp, web search and email:
 *      what it does, whether it is set up, one button. The forms open in a
 *      side panel (Drawer), so the page itself stays short.
 *   2. Files the AI may send — the media gallery, with upload in a side panel.
 *   3. Coming later — one quiet line instead of eight cards.
 *
 * It also fixes three things the page said wrong:
 *   - "WhatsApp Cloud API: Credentials Missing" showed while this workspace's
 *     own saved credentials were working (it only looked at the server's
 *     settings). Set up now means: saved for this workspace OR on the server.
 *   - The webhook panel said no verify token was set when one was saved here.
 *   - The top "Test connection" tested the server's settings only (fixed in
 *     the route: it now resolves the workspace's provider like every send).
 *
 * Endpoints and confirm steps are unchanged.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Card, EmptyState, Button, ConfirmModal, Badge, Drawer, DrawerBody } from "@/components/ui";
import {
  Plug, MessageCircle, AlertCircle, Clipboard, Upload, Trash2, Link2, Package, Search, Mail, ChevronRight,
} from "lucide-react";
import { api, apiForm } from "@/lib/api-client";
import { displayLabel } from "@/lib/display-labels";
import { formatFileSize } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";
import type { MediaCatalogItem } from "@/lib/types";
import type { Runner } from "@/app/page";

type WhatsAppConfigStatus = {
  accessToken: boolean;
  phoneNumberId: boolean;
  businessAccountId: boolean;
  verifyToken: boolean;
  isConfigured: boolean;
};
type WaCredView = { hasCredentials: boolean; accessTokenPreview?: string; phoneNumberId?: string; businessAccountId?: string; hasVerifyToken?: boolean };
type TestResult = { ok: boolean; status: string; message: string; displayPhoneNumber?: string };
type KeyName = "serpapi" | "resend";

const KEY_SERVICES: Array<{ key: KeyName; name: string; does: string; icon: React.ComponentType<{ className?: string }>; placeholder: string; help: string }> = [
  { key: "serpapi", name: "Web search", does: "Finds new buyers and researches markets on Google.", icon: Search, placeholder: "Paste your SerpApi key", help: "From your SerpApi account (serpapi.com → Dashboard → API key)." },
  { key: "resend", name: "Email", does: "Sends the email replies you approve.", icon: Mail, placeholder: "re_…", help: "From your Resend account (resend.com → API Keys). Keys start with “re_”." },
];

const COMING_LATER = ["Gmail", "Instagram", "LinkedIn", "Google Sheets", "HubSpot / Zoho", "Website forms", "Zapier / Make"];

/** One connection: what it is, whether it is set up, one button. */
function ConnectionRow({ icon: Icon, name, does, status, extra, action }: {
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  does: string;
  status: React.ReactNode;
  extra?: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 py-4 first:pt-0 last:pb-0">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-tint text-primary" aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-foreground">{name}</p>
          {status}
        </div>
        <p className="mt-0.5 text-sm text-muted-2">{does}</p>
        {extra}
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function ResultLine({ result }: { result: { ok: boolean; message: string } | null }) {
  if (!result) return null;
  return (
    <p role="status" className={`text-sm font-medium ${result.ok ? "text-success-fg" : "text-danger-fg"}`}>
      {result.ok ? "✓ " : "✗ "}{result.message}
    </p>
  );
}

export function IntegrationsSection({ mediaItems, run, reload, workspaceId }: { mediaItems: MediaCatalogItem[]; run: Runner; reload?: () => void; workspaceId: string }) {
  const [waSettings, setWaSettings] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  // Which side panel is open.
  const [panel, setPanel] = useState<null | "whatsapp" | KeyName | "upload">(null);
  // F-UI-7 (2026-08-04): confirm before hard-deleting a media gallery item.
  const [pendingMediaDelete, setPendingMediaDelete] = useState<MediaCatalogItem | null>(null);
  // 2026-08-05 UX audit: removing credentials always confirms first.
  const [pendingCredRemove, setPendingCredRemove] = useState<null | { kind: "whatsapp" } | { kind: "intkey"; key: KeyName }>(null);
  // D-2026-08-02 / CP-17 — per-workspace WhatsApp Cloud credentials.
  const [waCredView, setWaCredView] = useState<WaCredView | null>(null);
  const [waCredInput, setWaCredInput] = useState({ accessToken: "", phoneNumberId: "", businessAccountId: "", verifyToken: "" });
  const [waCredSaving, setWaCredSaving] = useState(false);
  const [waCredTesting, setWaCredTesting] = useState(false);
  const [waCredResult, setWaCredResult] = useState<TestResult | null>(null);
  const [waCredMsg, setWaCredMsg] = useState<string | null>(null);
  // 2026-08-05 E-P1-6: a failed check must not read as "not set up".
  const [credLoadError, setCredLoadError] = useState<string | null>(null);
  // CP-18: per-workspace integration keys.
  const [intKeyInput, setIntKeyInput] = useState<Record<string, string>>({ serpapi: "", resend: "" });
  const [intKeyView, setIntKeyView] = useState<Record<string, { hasKey: boolean; keyPreview?: string }>>({});
  const [intKeyBusy, setIntKeyBusy] = useState<Record<string, boolean>>({});
  const [intKeyMsg, setIntKeyMsg] = useState<Record<string, string>>({});
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaTitle, setMediaTitle] = useState("");
  const [mediaCaption, setMediaCaption] = useState("");
  const [mediaCategory, setMediaCategory] = useState<MediaCatalogItem["category"]>("catalog");

  async function load() {
    try {
      setLoadError(null);
      const data = await api<Record<string, unknown>>("/api/whatsapp-agent/settings");
      setWaSettings(data);
      setCredLoadError(null);
      try {
        const view = await api<WaCredView>("/api/whatsapp-agent/credentials");
        setWaCredView(view);
        if (view.phoneNumberId) setWaCredInput((prev) => ({ ...prev, phoneNumberId: view.phoneNumberId || "" }));
        if (view.businessAccountId) setWaCredInput((prev) => ({ ...prev, businessAccountId: view.businessAccountId || "" }));
      } catch (e) {
        setWaCredView({ hasCredentials: false });
        setCredLoadError(e instanceof Error ? e.message : "Couldn't check saved details.");
      }
      try {
        const serpView = await api<{ hasKey: boolean; keyPreview?: string }>("/api/integrations/credentials/serpapi");
        const reView = await api<{ hasKey: boolean; keyPreview?: string }>("/api/integrations/credentials/resend");
        setIntKeyView({ serpapi: serpView, resend: reView });
      } catch (e) {
        setIntKeyView({});
        setCredLoadError((prev) => prev || (e instanceof Error ? e.message : "Couldn't check your keys."));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load your connections.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const server: WhatsAppConfigStatus = (waSettings?.configStatus && typeof waSettings.configStatus === "object" && !Array.isArray(waSettings.configStatus)
    ? waSettings.configStatus as WhatsAppConfigStatus
    : { accessToken: false, phoneNumberId: false, businessAccountId: false, verifyToken: false, isConfigured: false });
  // Set up = this workspace's own saved details, or the server's. Sending uses
  // the workspace's first (WhatsAppCredentialService.resolveProvider).
  const waSetUp = Boolean(waCredView?.hasCredentials) || server.isConfigured;
  const repliesSetUp = Boolean(waCredView?.hasVerifyToken) || server.verifyToken;

  const callbackUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/inbound/whatsapp-webhook`
    : "/api/inbound/whatsapp-webhook";

  const handleCopyUrl = async () => {
    const ok = await copyToClipboard(callbackUrl, (msg) => setLoadError(msg));
    if (ok) {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  async function saveWhatsApp() {
    setWaCredSaving(true);
    setWaCredMsg(null);
    try {
      // An empty verify-password box means "keep the saved one". The server
      // treats "" as "clear it", and the old screen always sent "", so every
      // re-save silently wiped the saved password and inbound replies stopped.
      const { verifyToken, ...rest } = waCredInput;
      await api("/api/whatsapp-agent/credentials", { method: "PUT", body: verifyToken.trim() ? { ...rest, verifyToken } : rest });
      setWaCredInput((prev) => ({ ...prev, accessToken: "", verifyToken: "" }));
      setWaCredMsg("Saved. This company now uses these WhatsApp details.");
      await load();
    } catch (e) {
      setWaCredMsg(`Couldn't save: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setWaCredSaving(false);
    }
  }

  async function testWhatsApp() {
    setWaCredTesting(true);
    setWaCredResult(null);
    try {
      // With nothing typed, test what is saved; with a new token typed, test that before saving.
      const typed = waCredInput.accessToken.trim();
      const result = typed
        ? await api<TestResult>("/api/whatsapp-agent/credentials/test", { method: "POST", body: waCredInput })
        : await api<TestResult>("/api/integrations/test", { method: "POST" });
      setWaCredResult(result);
    } catch (e) {
      setWaCredResult({ ok: false, status: "network_error", message: e instanceof Error ? e.message : "Test failed." });
    } finally {
      setWaCredTesting(false);
    }
  }

  async function keyAction(key: KeyName, action: "save" | "test") {
    setIntKeyBusy((prev) => ({ ...prev, [key]: true }));
    setIntKeyMsg((prev) => ({ ...prev, [key]: "" }));
    try {
      if (action === "save") {
        await api(`/api/integrations/credentials/${key}`, { method: "PUT", body: { apiKey: intKeyInput[key] } });
        setIntKeyInput((prev) => ({ ...prev, [key]: "" }));
        setIntKeyMsg((prev) => ({ ...prev, [key]: "✓ Saved." }));
        await load();
      } else {
        const result = await api<{ ok: boolean; message: string }>(`/api/integrations/credentials/${key}/test`, { method: "POST", body: { apiKey: intKeyInput[key] } });
        setIntKeyMsg((prev) => ({ ...prev, [key]: `${result.ok ? "✓ " : "✗ "}${result.message}` }));
      }
    } catch (e) {
      setIntKeyMsg((prev) => ({ ...prev, [key]: `✗ ${action === "save" ? "Couldn't save" : "Test failed"}: ${e instanceof Error ? e.message : "error"}` }));
    } finally {
      setIntKeyBusy((prev) => ({ ...prev, [key]: false }));
    }
  }

  if (loadError) {
    return (
      <Card title="Integrations" icon={Plug}>
        <EmptyState icon={AlertCircle} title="Couldn't load" description={loadError} action={<Button onClick={load}>Try again</Button>} />
      </Card>
    );
  }

  const openKey = KEY_SERVICES.find((s) => s.key === panel);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-2">
        Whatever is connected here, risky messages are always held for your review first.
      </p>

      {/* 1 — Your connections */}
      <Card title="Your connections" icon={Plug}>
        {loading ? (
          <p className="text-sm text-muted animate-pulse">Checking your connections…</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            <ConnectionRow
              icon={MessageCircle}
              name="WhatsApp"
              does="Sends the replies you approve, and receives your customers' messages."
              status={credLoadError
                ? <Badge tone="danger">Couldn&apos;t check</Badge>
                : waSetUp ? <Badge tone="success">Set up</Badge> : <Badge tone="warning">Not set up</Badge>}
              extra={waSetUp && !credLoadError ? (
                <p className="mt-1 text-xs text-muted">
                  {repliesSetUp ? "Customer replies: ready to receive." : "Customer replies: not set up yet — open WhatsApp to finish."}
                </p>
              ) : null}
              action={
                <Button variant={waSetUp ? "secondary" : "primary"} size="sm" icon={ChevronRight} iconPosition="right" onClick={() => setPanel("whatsapp")}>
                  {waSetUp ? "Manage" : "Set up"}
                </Button>
              }
            />
            {KEY_SERVICES.map((s) => (
              <ConnectionRow
                key={s.key}
                icon={s.icon}
                name={s.name}
                does={s.does}
                status={intKeyView[s.key]?.hasKey
                  ? <Badge tone="success">Your own key</Badge>
                  : <Badge tone="neutral">Using the shared key</Badge>}
                action={
                  <Button variant="secondary" size="sm" icon={ChevronRight} iconPosition="right" onClick={() => setPanel(s.key)}>
                    Manage
                  </Button>
                }
              />
            ))}
          </div>
        )}
      </Card>

      {/* 2 — Files the AI may send */}
      <Card
        title={`Files the AI may send${mediaItems.length ? ` (${mediaItems.length})` : ""}`}
        icon={Package}
        action={<Button size="sm" variant="secondary" icon={Upload} onClick={() => setPanel("upload")}>Upload a file</Button>}
      >
        <p className="mb-3 text-sm text-muted-2">Catalogues, product photos, certificates and policies you can attach when you approve a reply.</p>
        {mediaItems.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {mediaItems.map((item) => (
              <div key={item.id} className="rounded-md border border-border-default bg-surface p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-foreground" title={item.title}>{item.title}</p>
                    <p className="text-xs text-muted">{displayLabel(item.category)} · {formatFileSize(item.fileSize)}</p>
                  </div>
                  <button className="icon-btn" title="Delete" aria-label={`Delete media item ${item.title}`} onClick={() => setPendingMediaDelete(item)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {item.caption ? <p className="mt-2 text-xs text-muted-2">{item.caption}</p> : null}
                {/* 2026-09-10 (session 55): a missing file is said out loud and never offered to the AI. */}
                {item.fileMissing ? (
                  <p className="mt-2 rounded-md border border-dashed border-border-default bg-surface p-2 text-xs text-muted">
                    The file behind this entry is not stored, so it cannot be sent. Upload it again to use it in replies.
                  </p>
                ) : (
                  <a className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary underline" href={item.url} target="_blank" rel="noreferrer">
                    <Link2 className="h-3 w-3" /> Open file
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border-default bg-surface p-4 text-sm text-muted">
            No files yet. Upload a catalogue, certificate or product photo to use it in customer replies.
          </p>
        )}
      </Card>

      {/* 3 — Coming later: honest, one line (Cluster 7 / D-2026-07-26-7: not built). */}
      <div className="rounded-lg border border-dashed border-border-default bg-surface px-4 py-3">
        <p className="text-sm text-muted-2">
          <span className="font-semibold text-foreground">Coming later</span> — not available yet, nothing to set up:{" "}
          {COMING_LATER.join(" · ")}.
        </p>
      </div>

      {/* WhatsApp side panel */}
      <Drawer open={panel === "whatsapp"} onOpenChange={(o) => setPanel(o ? "whatsapp" : null)} title="WhatsApp" description="Connect your WhatsApp Business number" size="lg">
        <DrawerBody>
        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-foreground">1. Connect your number</h3>
              {waCredView?.hasCredentials
                ? <Badge tone="success">Saved ({waCredView.accessTokenPreview || "••••"})</Badge>
                : server.isConfigured ? <Badge tone="info">Using the server&apos;s number</Badge> : <Badge tone="warning">Not set up</Badge>}
            </div>
            <p className="text-sm text-muted-2">
              Copy these from Meta for Developers → your app → WhatsApp → API Setup. They are stored encrypted and never shown again.
            </p>
            <label className="flex flex-col gap-1 text-sm font-semibold text-foreground">
              Access token
              <input
                type="password"
                className="input font-normal"
                autoComplete="off"
                placeholder={waCredView?.hasCredentials ? "Saved — paste a new one only to replace it" : "Paste the token from Meta"}
                value={waCredInput.accessToken}
                onChange={(e) => setWaCredInput((prev) => ({ ...prev, accessToken: e.target.value }))}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-semibold text-foreground">
                Phone number ID
                <input type="text" className="input font-normal" placeholder="e.g. 106540352242922" value={waCredInput.phoneNumberId} onChange={(e) => setWaCredInput((prev) => ({ ...prev, phoneNumberId: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-foreground">
                <span>Business account ID <span className="font-normal text-muted">(optional)</span></span>
                <input type="text" className="input font-normal" placeholder="e.g. 102290129340398" value={waCredInput.businessAccountId} onChange={(e) => setWaCredInput((prev) => ({ ...prev, businessAccountId: e.target.value }))} />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={waCredSaving} onClick={saveWhatsApp}>Save</Button>
              <Button size="sm" variant="secondary" loading={waCredTesting} onClick={testWhatsApp}>Test connection</Button>
              {waCredView?.hasCredentials ? (
                <button type="button" className="btn secondary text-xs py-1.5 px-3 text-danger-fg" onClick={() => setPendingCredRemove({ kind: "whatsapp" })}>Remove</button>
              ) : null}
            </div>
            {waCredMsg ? <p role="status" className="text-sm text-muted-2">{waCredMsg}</p> : null}
            <ResultLine result={waCredResult} />
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-foreground">2. Receive customer replies</h3>
              {repliesSetUp ? <Badge tone="success">Verify password saved</Badge> : <Badge tone="warning">Not set up</Badge>}
            </div>
            <p className="text-sm text-muted-2">
              So that customers&apos; messages reach you here. In Meta: WhatsApp → Configuration → Webhook → Edit, then:
            </p>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
              <li>
                Paste this address as the <b>Callback URL</b>:
                <div className="mt-1 flex gap-2">
                  <input type="text" readOnly aria-label="Callback URL to paste into Meta" value={callbackUrl} className="input flex-1 bg-surface font-mono text-xs select-all" />
                  <Button size="sm" variant="secondary" icon={Clipboard} onClick={handleCopyUrl}>{copiedUrl ? "Copied" : "Copy"}</Button>
                </div>
              </li>
              <li>
                Choose any password, type it below and save, then type the same one as the <b>Verify token</b> in Meta and press Verify and save.
                <div className="mt-1 flex gap-2">
                  <input
                    type="password"
                    className="input flex-1"
                    autoComplete="off"
                    aria-label="Verify password"
                    placeholder={waCredView?.hasVerifyToken ? "Saved — type a new one only to replace it" : "e.g. balaji-webhook-2026"}
                    value={waCredInput.verifyToken}
                    onChange={(e) => setWaCredInput((prev) => ({ ...prev, verifyToken: e.target.value }))}
                  />
                  <Button size="sm" variant="secondary" loading={waCredSaving} disabled={!waCredInput.verifyToken.trim()} onClick={saveWhatsApp}>Save</Button>
                </div>
              </li>
              <li>Next to <b>Webhook fields</b>, click Manage and turn on <b>messages</b>.</li>
            </ol>
            <p className="text-xs text-muted">Meta only reaches the live website, not a copy running on your own computer.</p>
          </section>

          <details className="rounded-md border border-border-subtle bg-surface p-3 text-sm">
            <summary className="cursor-pointer font-semibold text-foreground">For whoever runs the server</summary>
            <p className="mt-2 text-muted-2">
              The server can also hold one WhatsApp number for every company. Details saved above always come first.
            </p>
            <ul className="mt-2 space-y-1 text-muted-2">
              <li>Access token on the server: <b>{server.accessToken ? "set" : "not set"}</b></li>
              <li>Phone number ID on the server: <b>{server.phoneNumberId ? "set" : "not set"}</b></li>
              <li>Business account ID on the server: <b>{server.businessAccountId ? "set" : "not set (optional)"}</b></li>
              <li>Verify password on the server: <b>{server.verifyToken ? "set" : "not set"}</b></li>
            </ul>
          </details>
        </div>
        </DrawerBody>
      </Drawer>

      {/* Web search / email side panel */}
      <Drawer open={Boolean(openKey)} onOpenChange={(o) => { if (!o) setPanel(null); }} title={openKey?.name || ""} description={openKey?.does} size="md">
        <DrawerBody>
        {openKey ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              {intKeyView[openKey.key]?.hasKey
                ? <Badge tone="success">Your own key ({intKeyView[openKey.key]?.keyPreview || "••••"})</Badge>
                : <Badge tone="neutral">Using the shared key</Badge>}
            </div>
            <p className="text-sm text-muted-2">
              Optional. Add your own key if you want this company&apos;s use billed to your own account; otherwise the shared key is used.
            </p>
            <label className="flex flex-col gap-1 text-sm font-semibold text-foreground">
              Your key
              <input
                type="password"
                className="input font-normal"
                autoComplete="off"
                placeholder={intKeyView[openKey.key]?.hasKey ? "Saved — paste a new one only to replace it" : openKey.placeholder}
                value={intKeyInput[openKey.key] || ""}
                onChange={(e) => setIntKeyInput((prev) => ({ ...prev, [openKey.key]: e.target.value }))}
              />
            </label>
            <p className="text-xs text-muted">{openKey.help}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={intKeyBusy[openKey.key]} disabled={!(intKeyInput[openKey.key] || "").trim()} onClick={() => keyAction(openKey.key, "save")}>Save</Button>
              <Button size="sm" variant="secondary" disabled={intKeyBusy[openKey.key] || !(intKeyInput[openKey.key] || "").trim()} onClick={() => keyAction(openKey.key, "test")}>Test</Button>
              {intKeyView[openKey.key]?.hasKey ? (
                <button type="button" className="btn secondary text-xs py-1.5 px-3 text-danger-fg" onClick={() => setPendingCredRemove({ kind: "intkey", key: openKey.key })}>Remove my key</button>
              ) : null}
            </div>
            {intKeyMsg[openKey.key] ? <p role="status" className="text-sm text-muted-2">{intKeyMsg[openKey.key]}</p> : null}
          </div>
        ) : null}
        </DrawerBody>
      </Drawer>

      {/* Upload side panel */}
      <Drawer open={panel === "upload"} onOpenChange={(o) => setPanel(o ? "upload" : null)} title="Upload a file" description="Add a file the AI may attach to replies you approve" size="md">
        <DrawerBody>
        <div className="space-y-3">
          <label className="block text-sm font-semibold text-foreground">
            File
            <input className="input mt-1 font-normal" type="file" onChange={(event) => setMediaFile(event.target.files?.[0] || null)} />
          </label>
          <label className="block text-sm font-semibold text-foreground">
            Name customers will see
            <input className="input mt-1 font-normal" placeholder="e.g. Zari lace catalogue 2026" value={mediaTitle} onChange={(event) => setMediaTitle(event.target.value)} />
          </label>
          <label className="block text-sm font-semibold text-foreground">
            What kind of file is this?
            <select className="input mt-1 font-normal" value={mediaCategory} onChange={(event) => setMediaCategory(event.target.value as MediaCatalogItem["category"])}>
              <option value="catalog">Catalogue</option>
              <option value="product_image">Product photo</option>
              <option value="certificate">Certificate</option>
              <option value="policy_document">Policy document</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block text-sm font-semibold text-foreground">
            Note <span className="font-normal text-muted">(optional)</span>
            <textarea className="input mt-1 min-h-20 font-normal" placeholder="When should the AI use this file?" value={mediaCaption} onChange={(event) => setMediaCaption(event.target.value)} />
          </label>
          <Button icon={Upload} disabled={!mediaFile} onClick={() => run("Upload media", async () => {
            if (!mediaFile) return;
            const formData = new FormData();
            formData.append("workspaceId", workspaceId);
            formData.append("file", mediaFile);
            formData.append("title", mediaTitle);
            formData.append("caption", mediaCaption);
            formData.append("category", mediaCategory);
            await apiForm<MediaCatalogItem>("/api/media/upload", formData);
            setMediaFile(null);
            setMediaTitle("");
            setMediaCaption("");
            setPanel(null);
          })}>
            Upload
          </Button>
        </div>
        </DrawerBody>
      </Drawer>

      {/* F-UI-7 (2026-08-04): confirm before hard-deleting a media gallery item. */}
      <ConfirmModal
        open={pendingMediaDelete !== null}
        title={pendingMediaDelete ? `Delete "${pendingMediaDelete.title}"?` : ""}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          const target = pendingMediaDelete;
          setPendingMediaDelete(null);
          if (target) run("Delete media", () => api(`/api/media/${target.id}`, { method: "DELETE" }).then(() => reload?.()));
        }}
        onClose={() => setPendingMediaDelete(null)}
      >
        This permanently removes the file. Replies that used it keep their text but lose the attachment. This cannot be undone.
      </ConfirmModal>

      {/* 2026-08-05 UX audit — confirm before removing saved credentials. */}
      <ConfirmModal
        open={pendingCredRemove !== null}
        title={pendingCredRemove?.kind === "whatsapp" ? "Remove your WhatsApp details?" : "Remove your key?"}
        confirmLabel="Remove"
        tone="danger"
        onConfirm={async () => {
          const target = pendingCredRemove;
          setPendingCredRemove(null);
          if (!target) return;
          if (target.kind === "whatsapp") {
            setWaCredMsg(null);
            try {
              await api("/api/whatsapp-agent/credentials", { method: "DELETE" });
              setWaCredInput({ accessToken: "", phoneNumberId: "", businessAccountId: "", verifyToken: "" });
              setWaCredMsg("Removed. WhatsApp now uses the server's number, if there is one; otherwise it is off.");
              await load();
            } catch (e) {
              setWaCredMsg(`Couldn't remove: ${e instanceof Error ? e.message : "unknown error"}`);
            }
          } else {
            setIntKeyBusy((prev) => ({ ...prev, [target.key]: true }));
            try {
              await api(`/api/integrations/credentials/${target.key}`, { method: "DELETE" });
              setIntKeyMsg((prev) => ({ ...prev, [target.key]: "Removed. The shared key is used again." }));
              await load();
            } catch (e) {
              setIntKeyMsg((prev) => ({ ...prev, [target.key]: `✗ Couldn't remove: ${e instanceof Error ? e.message : "error"}` }));
            } finally {
              setIntKeyBusy((prev) => ({ ...prev, [target.key]: false }));
            }
          }
        }}
        onClose={() => setPendingCredRemove(null)}
      >
        {pendingCredRemove?.kind === "whatsapp"
          ? "WhatsApp messages from this company stop until new details are added (unless the server has its own number). Drafts and messages already received are not affected."
          : "This company goes back to the shared key, if there is one. Features using it may stop working."}
      </ConfirmModal>
    </div>
  );
}
