/**
 * Shared UI primitives extracted from the page.tsx monolith (Session 14).
 *
 * These are pure presentation components with no dependency on the main Home
 * component's state. Extracting them is the first, safest step of the
 * mega-file split: they're used everywhere, they're self-contained, and
 * moving them changes nothing about behavior.
 */
import React from "react";
import { isAiScored } from "@/lib/lead-rules";
import { leadScoreBandClass } from "@/lib/display-labels";

export function Panel({ title, icon: Icon, children, tone = "default" }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; tone?: "default" | "urgent" }) {
  // 2026-07-29 (UI sweep, build-right Human-Centric Rule 4 "fix the entire
  // pattern"): `min-w-0` is the standard CSS fix that lets a flex/grid child
  // shrink below its content's intrinsic width. Without it, any wide child
  // (e.g. a <table className="min-w-[680px]"> wrapped in overflow-x-auto)
  // inflates the Panel and overflows the page on narrow viewports (mobile).
  // This one change fixes all 3 min-w-[...] tables (Leads/CRM, Discovery,
  // LeadTable) because they all render inside Panel. `min-w-0` is safe — it
  // only relaxes the minimum-width floor, never clips content (overflow-x-auto
  // on the table wrapper still provides the internal horizontal scroll).
  //
  // 2026-08-02 (UI polish): replaced hardcoded hex palette (#cbd6ca, #fbfcf8,
  // #1f7a5a) with design tokens (border-border-default, bg-surface,
  // text-primary) so Panels match the Card-based screens and adapt to any
  // theme. Also demoted the title <h2> to a styled <div> — a Panel is a
  // container, and its title duplicated the shell <h1> page title on every
  // page (build-right "fix the pattern, not the instance").
  //
  // 2026-08-31 (N-UI-5) — the <div> title is promoted BACK to a real <h2>,
  // with the visual styling byte-identical so nothing on any screen moves.
  //
  // The 2026-08-02 demotion above solved a real problem (a lone Panel whose
  // title echoed the page <h1>) but paid for it everywhere: a screen built
  // from nine Panels — AI Settings — reported ZERO headings. With no h2 there
  // is no scan hierarchy for a sighted operator and no landmark list at all
  // for a screen-reader user; every section carries the same weight as the one
  // before it, which is exactly the "hard to understand" the CEO reported.
  //
  // A duplicated heading on a one-Panel screen is a small redundancy. No
  // headings on a nine-Panel screen is a broken document. `aria-labelledby`
  // also turns each Panel into a NAMED region, so the sections become
  // navigable rather than being one flat wall.
  // N-UX-10 (2026-09-03) — `tone="urgent"` is the shared way for a screen to
  // say "of everything here, THIS is the one waiting on you".
  //
  // The operator's rule: "whatever is the main topic should get highlighted."
  // On a screen showing both a real customer waiting for a price and a setup
  // form, the two were rendered identically, so the screen never said which to
  // do first. It lives on Panel rather than being hand-rolled per screen so
  // urgency looks the same everywhere and one screen cannot invent its own
  // louder version. Colour is not the only signal — the heavier left edge
  // carries it for anyone who cannot separate the hues.
  const headingId = React.useId();
  const urgent = tone === "urgent";
  return (
    <section
      aria-labelledby={headingId}
      className={
        "min-w-0 rounded-xl border bg-surface p-4 shadow-sm ring-1 ring-black/[0.03] "
        + (urgent
          ? "border-warning-bg border-l-4 border-l-warning-fg"
          : "border-border-default")
      }
    >
      {/* 2026-09-25 — icon chip + a rule under the title, so a screen made of
          several Panels reads as separate sections, not one white wall. */}
      <div className="-mx-4 mb-4 flex items-center gap-2.5 border-b border-border-subtle px-4 pb-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${urgent ? "bg-warning-bg text-warning-fg" : "bg-surface-tint text-primary"}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <h2 id={headingId} className={urgent ? "font-semibold text-warning-fg" : "font-semibold text-foreground"}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-xl border border-border-default bg-surface p-4 shadow-md ring-1 ring-black/[0.02]">
      <Icon className="mb-3 h-5 w-5 text-primary" aria-hidden="true" />
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

/**
 * `hint` (2026-09-01, N-UX-10) is an optional one-line plain-English meaning
 * printed under the label. Optional on purpose: every existing caller keeps
 * rendering exactly what it rendered before. It exists because a number with a
 * correct label can still be unreadable — "Marketing qualified: 1" means
 * nothing to an operator who has never met the term.
 */
export function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  // 2026-09-04 N-UX-16 — this was `flex flex-wrap`, and a flex container wraps
  // an item onto the next line BEFORE it shrinks the item beside it. So as soon
  // as a `hint` made the label column wider than about half the panel, the
  // number jumped to its own line, right-aligned, under a sentence — on
  // Analytics you read "Prospects found / Businesses added to this campaign so
  // far." and then a lonely "15" below it, with no way to tell which label the
  // number belonged to. Some rows wrapped and some didn't, which is worse than
  // all of them wrapping.
  //
  // A two-column grid cannot do that: the value column always sits on the same
  // line as its label.
  //
  // The hint moved OUT of the label cell and onto its own full-width row
  // underneath. That is what makes one layout work for two opposite shapes of
  // row. Analytics rows are a short label with a long HINT; Settings rows are
  // a short label with a long VALUE. While the hint lived inside the label
  // cell it set that column's width, so any fixed ratio had to be wrong for
  // one of them: a 3:2 split that kept the Analytics hint readable squeezed
  // "Stand-in encryption while in demo" onto three lines, and the ratio that
  // fixed Settings shredded the hint.
  //
  // With the hint on its own row, the label column sizes to the label alone.
  // Short labels leave the value all the room it needs, the number sits
  // immediately beside the words it belongs to, and the explanation runs the
  // full width of the row instead of down a narrow column.
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 border-b border-border-subtle py-2 text-sm">
      <span className="min-w-0 text-muted">{label}</span>
      <span className="min-w-0 break-words text-right font-medium text-foreground">{value}</span>
      {hint ? <span className="col-span-2 mt-0.5 text-xs text-muted-2">{hint}</span> : null}
    </div>
  );
}

export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-surface-muted px-2 py-1 text-xs font-semibold text-foreground">{children}</span>;
}

export function Empty({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed border-border-default p-4 text-sm text-muted">{text}</div>;
}

export function StatusPill({ text, active }: { text: string; active: boolean }) {
  return <span className={`rounded-md px-3 py-2 text-sm ${active ? "bg-warning-bg text-warning-fg" : "bg-surface-muted text-muted"}`}>{text}</span>;
}

export function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span className="label">{label}</span><input className="input" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function SecretField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span className="label">{label}</span><input className="input" type="password" autoComplete="off" placeholder="Optional. Saved masked in demo mode." value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function Chips({ items }: { items: string[] }) {
  return <div className="mt-3 flex flex-wrap gap-2">{items.filter(Boolean).map((item) => <span key={item} className="rounded-md bg-surface-muted px-2 py-1 text-xs text-muted">{item}</span>)}</div>;
}

export function ProfileRows({ items }: { items: Record<string, string> }) {
  return <div>{Object.entries(items).map(([label, value]) => <Row key={label} label={label} value={value} />)}</div>;
}

/**
 * 2026-09-25 — the one score badge for every screen. Lead scoring is AI only:
 * a number is shown only when the AI produced it; otherwise "Not scored".
 */
export function LeadScoreChip({ lead }: { lead: { leadScore?: number; qualificationStatus?: string; scoreReason?: unknown } }) {
  if (!isAiScored(lead)) {
    return (
      <span className="inline-flex h-7 items-center justify-center rounded-md bg-surface-muted px-2 text-xs font-medium text-muted ring-1 ring-inset ring-border-default" title="The AI has not scored this lead yet">
        Not scored
      </span>
    );
  }
  const score = lead.leadScore || 0;
  return <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-xs font-bold ${leadScoreBandClass(score)}`}>{score}</span>;
}
