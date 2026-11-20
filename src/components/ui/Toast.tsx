/**
 * 2026-07-21 (M1) — Toast notification system.
 *
 * Before this, errors went into a 1-line header pill that got overwritten
 * by the next action (audit 2026-07-21). Toaster fixes that: errors +
 * successes surface as stacked toasts top-right that auto-dismiss.
 *
 * Usage:
 *   - Wrap the app root in <ToastProvider>.
 *   - In any child: const { toast } = useToast(); toast({ tone: "success", title: "Saved." }).
 *
 * Accessibility: each toast is role="status" (info/success) or role="alert"
 * (warning/error). Auto-dismiss is 5s for info/success, never for error.
 */
"use client";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastTone = "success" | "warning" | "danger" | "info";

export type ToastInput = {
  tone: ToastTone;
  title: string;
  description?: string;
  /** Override the default auto-dismiss (ms). 0 = sticky. */
  durationMs?: number;
};

type InternalToast = ToastInput & { id: string };

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_CONFIG: Record<ToastTone, { bg: string; fg: string; border: string; Icon: React.ComponentType<{ className?: string }>; role: "status" | "alert" }> = {
  success: { bg: "bg-success-bg", fg: "text-success-fg", border: "border-success-fg", Icon: CheckCircle2, role: "status" },
  warning: { bg: "bg-warning-bg", fg: "text-warning-fg", border: "border-warning-fg", Icon: AlertTriangle, role: "alert" },
  danger: { bg: "bg-danger-bg", fg: "text-danger-fg", border: "border-danger-fg", Icon: AlertCircle, role: "alert" },
  info: { bg: "bg-info-bg", fg: "text-info-fg", border: "border-info-fg", Icon: Info, role: "status" },
};

const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 5000,
  info: 5000,
  warning: 8000,
  danger: 0, // sticky — never auto-dismiss errors
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<InternalToast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setToasts((current) => [...current, { ...input, id }]);
  }, []);

  const context = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={context}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed right-4 top-4 z-[100] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: InternalToast; onDismiss: () => void }) {
  const config = TONE_CONFIG[toast.tone];
  const duration = toast.durationMs ?? DEFAULT_DURATION[toast.tone];
  const { Icon } = config;

  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  return (
    <div
      role={config.role}
      className={`pointer-events-auto flex items-start gap-2 rounded-md border ${config.border} ${config.bg} p-3 shadow-lg`}
    >
      <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${config.fg}`} aria-hidden="true" />
      <div className="flex-1">
        <p className={`text-sm font-semibold ${config.fg}`}>{toast.title}</p>
        {toast.description && <p className={`mt-0.5 text-xs ${config.fg} opacity-90`}>{toast.description}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className={`rounded p-0.5 ${config.fg} hover:opacity-70`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
