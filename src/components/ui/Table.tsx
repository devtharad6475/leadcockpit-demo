/**
 * 2026-07-21 (M1) — Table primitives.
 *
 * Replaces the ~3 near-identical inline tables in page.tsx (LeadTable,
 * CRM pipeline, Outreach Queue). Provides Table + TableHeader +
 * TableBody + TableRow + TableHead + TableCell, each with consistent
 * styling. Caller composes them like a normal <table>.
 *
 * Accessibility: <caption> is optional but recommended; the table
 * element gets a default `aria-busy` slot the caller can wire up.
 */
import React from "react";

export type TableProps = React.TableHTMLAttributes<HTMLTableElement> & {
  caption?: string;
  children: React.ReactNode;
};

export function Table({ caption, children, className = "", ...rest }: TableProps) {
  return (
    // 2026-08-05 M-P1-4: on mobile, wide tables force horizontal scroll and the
    // action buttons end up off-screen with no indication. The scroll-hint label
    // (visible only on small screens) tells the operator there's more to the right.
    <div className="relative">
      <div className="overflow-x-auto rounded-md border border-border-default">
        <table className={`w-full border-collapse text-sm ${className}`} {...rest}>
          {caption && <caption className="sr-only">{caption}</caption>}
          {children}
        </table>
      </div>
      <p className="mt-1 text-right text-[10px] text-muted-2 sm:hidden">scroll → for more columns</p>
    </div>
  );
}

export function TableHeader({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-border-default bg-surface-muted">
      {children}
    </thead>
  );
}

export function TableBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TableRow({ children, className = "", ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={`border-b border-border-subtle last:border-b-0 hover:bg-surface-muted ${className}`} {...rest}>
      {children}
    </tr>
  );
}

export function TableHead({ children, className = "", ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  // Cluster 8 / P1-12 fix: default scope="col" so screen-reader users can
  // associate cells with their column headers. Callers can override via
  // the rest props (e.g. scope="row" for a row-header cell). This one
  // change covers every <TableHead> across the app (15+ sites) per the
  // build-right "fix the entire pattern not just the one instance" rule.
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TableCell({ children, className = "", ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-3 py-2 text-foreground ${className}`} {...rest}>
      {children}
    </td>
  );
}
