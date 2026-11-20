/**
 * 2026-07-21 (M1) — Tabs primitive.
 *
 * Replaces the bespoke tab strips in page.tsx (StructuredSettingsPanel,
 * KnowledgeBase sidebar, main app nav — 3 different patterns). One
 * consistent tab component with proper role="tab" / aria-selected /
 * aria-controls so screen readers can navigate it.
 *
 * Controlled: caller manages activeTab + onSelect. The Tab id can be
 * any string; the caller renders the matching panel content.
 */
"use client";
import React from "react";

export type Tab = {
  id: string;
  label: string;
  /** Optional count badge (e.g. "Tickets (3)"). */
  count?: number;
};

export type TabsProps = {
  tabs: Tab[];
  activeTab: string;
  onSelect: (id: string) => void;
  className?: string;
};

export function Tabs({ tabs, activeTab, onSelect, className = "" }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Sections"
      className={`flex flex-wrap gap-1 border-b border-border-default ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((item) => item.id === tab.id);
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
                : event.key === "Home" ? 0
                : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              // Scope focus to this strip: nested tab groups may share labels.
              const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              buttons?.[next]?.focus();
              onSelect(tabs[next].id);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                  isActive ? "bg-primary text-white" : "bg-surface-tint text-muted"
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ tabId, children, hidden = false }: { tabId: string; children: React.ReactNode; hidden?: boolean }) {
  return (
    <div role="tabpanel" id={`tabpanel-${tabId}`} aria-labelledby={`tab-${tabId}`} hidden={hidden} tabIndex={0} className="pt-4 focus-visible:outline-primary">
      {children}
    </div>
  );
}
