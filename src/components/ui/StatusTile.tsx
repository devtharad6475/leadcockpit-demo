/**
 * StatusTile — one headline fact with a coloured icon chip, used at the top of
 * a screen to say "what needs you" before any detail.
 *
 * 2026-09-25 — first written inside AI Settings; moved here when the Knowledge
 * Base adopted the same summary row, so the two screens cannot drift apart.
 * Pass `onClick` to make the tile a filter/shortcut; `active` marks the one
 * currently applied.
 */
"use client";
import React from "react";

const TILE_TONE = {
  success: { chip: "bg-success-bg text-success-fg", value: "text-success-fg" },
  warning: { chip: "bg-warning-bg text-warning-fg", value: "text-warning-fg" },
  danger: { chip: "bg-danger-bg text-danger-fg", value: "text-danger-fg" },
  info: { chip: "bg-info-bg text-info-fg", value: "text-foreground" },
  neutral: { chip: "bg-surface-muted text-muted", value: "text-foreground" },
} as const;

export type StatusTileTone = keyof typeof TILE_TONE;

export type StatusTileProps = {
  tone: StatusTileTone;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note: string;
  onClick?: () => void;
  active?: boolean;
};

export function StatusTile({ tone, icon: Icon, label, value, note, onClick, active = false }: StatusTileProps) {
  const body = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TILE_TONE[tone].chip}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        <span className={`mt-0.5 block text-base font-semibold ${TILE_TONE[tone].value}`}>{value}</span>
        <span className="mt-0.5 block text-xs text-muted">{note}</span>
      </span>
    </>
  );
  const frame = `flex w-full items-start gap-3 rounded-xl border bg-surface p-4 shadow-sm ${active ? "border-primary ring-2 ring-primary/30" : "border-border-default"}`;
  return onClick
    ? <button type="button" aria-pressed={active} onClick={onClick} className={`${frame} transition-colors hover:border-primary`}>{body}</button>
    : <div className={frame}>{body}</div>;
}
