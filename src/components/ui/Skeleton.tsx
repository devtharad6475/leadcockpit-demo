/**
 * 2026-08-02 (UX redesign Phase 1) — Skeleton primitive.
 *
 * Perceived-performance pattern (NN/g + SaaS Factor): a skeleton mirroring the
 * final layout is "perceived as faster" than a spinner, because the user sees
 * the shape of what's coming instead of a blank wait. Use while data loads for
 * tables, drawers, and KPI cards — anywhere a Spinner currently sits alone.
 *
 * Pure presentational; no behavior to hand-roll, so no Radix needed.
 */
"use client";
import React from "react";

export type SkeletonProps = {
  /** Shape preset. text = thin line; rect = block; circle = avatar/indicator. */
  variant?: "text" | "rect" | "circle";
  /** Width. Pass a Tailwind width class (w-24) or px (px-[120px]). */
  width?: string;
  /** Height. Pass a Tailwind height class (h-4) or px. */
  height?: string;
  className?: string;
};

export function Skeleton({ variant = "text", width, height, className = "" }: SkeletonProps) {
  const shape =
    variant === "circle"
      ? "rounded-full"
      : variant === "rect"
        ? "rounded-md"
        : "rounded";
  const size =
    variant === "circle"
      ? `${width ?? "h-10"} ${height ?? "w-10"}`
      : variant === "rect"
        ? `${width ?? "w-full"} ${height ?? "h-24"}`
        : `${width ?? "w-full"} ${height ?? "h-4"}`;
  // The animate-pulse keyframe comes from Tailwind. surface-muted → surface
  // gives a subtle shimmer on the cream palette.
  return (
    <div
      aria-hidden="true"
      className={`bg-surface-muted ${shape} ${size} animate-pulse ${className}`}
    />
  );
}

/** Convenience: render N text lines stacked (a paragraph skeleton). */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        // Last line shorter, like a real paragraph tail.
        <Skeleton key={i} variant="text" height="h-3" width={i === lines - 1 ? "w-2/3" : "w-full"} />
      ))}
    </div>
  );
}
