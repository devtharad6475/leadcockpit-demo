/**
 * CP-23 (2026-08-02) — Message batching with a conversation window.
 *
 * PROBLEM: WhatsApp users send fragmented messages — "Hi" / "Price" / "500
 * meters" / "Gold zari" / "Urgent" — as 5 separate messages within seconds.
 * Processing each individually means the AI sees fragments, not the full
 * request. Big platforms (Zendesk, Intercom, WhatsApp Business API itself)
 * solve this by batching: wait for a quiet period, merge, then process.
 *
 * DESIGN:
 *   - Each inbound message from a phone number enters a per-number buffer.
 *   - A quiet-window timer (default 60s) resets on each new message.
 *   - When the window closes (no new message for 60s), all buffered messages
 *     are merged into ONE combined text and passed to handleIncomingWhatsAppMessage.
 *   - The merged message preserves order + readability (newline-separated).
 *
 * HONEST LIMITATION: this is an IN-PROCESS buffer. If the server restarts
 * mid-window, buffered (unprocessed) messages are lost. A future Redis/queue
 * backend would externalize this for durability. For the pilot this is
 * acceptable — the window is 60s and the webhook dedup ensures Meta redelivers.
 *
 * SAFETY: the dedup check in WhatsAppWebhookService runs BEFORE batching, so
 * duplicate deliveries never enter the buffer. DNC check also runs before
 * batching (a DNC sender's messages are blocked, not buffered).
 */
import type { WhatsAppConversationInput } from "./WhatsAppConversationEngine";
import type { RepositoryBundle } from "@/repositories/interfaces";

type BufferedMessage = {
  text: string;
  providerMessageId?: string;
  receivedAt: number;
};

type PendingBuffer = {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout>;
  input: WhatsAppConversationInput; // the first message's input (leadId, phone, etc.)
  repos: RepositoryBundle;
  allowRealSend: boolean;
};

/** The quiet window in milliseconds. Default 60s (operator choice 2026-08-02). */
const DEFAULT_WINDOW_MS = 60_000;

export class MessageBatcher {
  private buffers = new Map<string, PendingBuffer>(); // key: `${workspaceId}:${phone}`
  private windowMs: number;
  private onProcess: (input: WhatsAppConversationInput, repos: RepositoryBundle, allowRealSend: boolean) => Promise<unknown>;

  constructor(
    onProcess: (input: WhatsAppConversationInput, repos: RepositoryBundle, allowRealSend: boolean) => Promise<unknown>,
    windowMs = DEFAULT_WINDOW_MS,
  ) {
    this.onProcess = onProcess;
    this.windowMs = windowMs;
  }

  /**
   * Add a message to the batch buffer for this phone number. If the buffer
   * doesn't exist yet, create it + start the timer. If it exists, append +
   * reset the timer. When the timer fires (quiet window elapsed), merge +
   * process.
   */
  addMessage(input: WhatsAppConversationInput, repos: RepositoryBundle, allowRealSend: boolean): void {
    const key = `${input.workspaceId}:${input.phone || input.leadId || "unknown"}`;
    const existing = this.buffers.get(key);

    const msg: BufferedMessage = {
      text: input.rawText,
      providerMessageId: input.providerMessageId,
      receivedAt: Date.now(),
    };

    if (existing) {
      // Append to the existing buffer + reset the timer.
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(key), this.windowMs);
      return;
    }

    // New buffer for this phone number.
    const buffer: PendingBuffer = {
      messages: [msg],
      input: { ...input }, // capture leadId, phone, workspaceId from the first message
      repos,
      allowRealSend,
      timer: setTimeout(() => this.flush(key), this.windowMs),
    };
    this.buffers.set(key, buffer);
  }

  /**
   * Merge + process the buffered messages for a key. Called when the quiet
   * window elapses. Combines all messages into one text (newline-separated,
   * deduped), then calls the processor with the combined input.
   */
  private async flush(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key); // remove before processing so new messages start fresh

    // Merge: deduplicate exact-duplicate texts (a user might re-send), preserve
    // order, join with newlines so the AI reads them as one conversation.
    const seen = new Set<string>();
    const uniqueTexts = buffer.messages
      .filter((m) => { const d = m.text.trim().toLowerCase(); if (seen.has(d)) return false; seen.add(d); return true; })
      .map((m) => m.text.trim())
      .filter((t) => t.length > 0);

    if (uniqueTexts.length === 0) return;

    const combinedText = uniqueTexts.join("\n");
    const mergedProviderIds = buffer.messages.map((m) => m.providerMessageId).filter(Boolean).join(",");

    const mergedInput: WhatsAppConversationInput = {
      ...buffer.input,
      rawText: combinedText,
      providerMessageId: mergedProviderIds || buffer.input.providerMessageId,
      metadata: {
        ...buffer.input.metadata,
        batchedMessageCount: uniqueTexts.length,
        batchedAt: new Date().toISOString(),
      },
    };

    try {
      await this.onProcess(mergedInput, buffer.repos, buffer.allowRealSend);
    } catch {
      // No silent failure: the error surfaces inside onProcess (the engine logs
      // to the auto-reply log). Here we swallow so the timer doesn't crash the
      // process — the next message from this number starts a fresh buffer.
    }
  }

  /** For testing: how many phone numbers currently have pending buffers. */
  pendingCount(): number { return this.buffers.size; }

  /** For testing/graceful shutdown: flush all pending buffers immediately. */
  async flushAll(): Promise<void> {
    const keys = [...this.buffers.keys()];
    await Promise.all(keys.map((k) => this.flush(k)));
  }
}

/**
 * The singleton batcher instance. The webhook service calls batchOrProcess()
 * instead of handleIncomingWhatsAppMessage directly. If batching is disabled
 * (the operator hasn't enabled it), it processes immediately (no buffer).
 */
let batcherInstance: MessageBatcher | null = null;
let batchingEnabled = false;

export function isMessageBatchingEnabled(): boolean { return batchingEnabled; }
export function setMessageBatchingEnabled(enabled: boolean): void { batchingEnabled = enabled; }

/** `enabledForWorkspace` — the company's saved setting; when given it decides, not the process-wide switch. */
export function getBatcher(enabledForWorkspace?: boolean): MessageBatcher | null {
  if (!(enabledForWorkspace ?? batchingEnabled)) return null;
  if (!batcherInstance) {
    // Lazy-import to avoid a circular dependency at module load.
    import("@/services/WhatsAppConversationEngine").then(({ handleIncomingWhatsAppMessage }) => {
      if (!batcherInstance) {
        batcherInstance = new MessageBatcher(
          (input, repos, allowRealSend) => handleIncomingWhatsAppMessage(input, repos, { allowRealSend }),
        );
      }
    });
  }
  return batcherInstance;
}
