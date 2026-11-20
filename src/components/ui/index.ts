/**
 * 2026-07-21 (M1) — Barrel export for the new design system.
 *
 * New screens import from "@/components/ui" — one entry point.
 *
 * The legacy primitives.tsx is re-exported with `Legacy` prefixes for
 * back-compat during the screen-by-screen migration (existing inline
 * buttons still use Panel / Metric / Row / etc.).
 */
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";
export { Card } from "./Card";
export type { CardProps } from "./Card";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";
export { Spinner } from "./Spinner";
export type { SpinnerProps } from "./Spinner";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { Modal } from "./Modal";
export type { ModalProps } from "./Modal";
// Stage A+ / Cluster 10b (P2-16): replaces window.prompt() with an accessible Modal.
export { PromptModal } from "./PromptModal";
export type { PromptModalProps } from "./PromptModal";
// Session 6 U-3: replaces window.confirm() with an accessible Modal.
export { ConfirmModal } from "./ConfirmModal";
export type { ConfirmModalProps } from "./ConfirmModal";
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./Table";
export type { TableProps } from "./Table";
export { Tabs, TabPanel } from "./Tabs";
export type { Tab, TabsProps } from "./Tabs";
export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";
export { Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";
export { Checkbox } from "./Checkbox";
export type { CheckboxProps } from "./Checkbox";
export { ToastProvider, useToast } from "./Toast";
export type { ToastTone, ToastInput } from "./Toast";

// 2026-08-02 (UX redesign Phase 1): CRM-pattern primitives.
// Drawer = the #1 CRM pattern (NN/g top-ranked master-detail). Avatar, Dropdown,
// Skeleton, Tooltip fill the gaps the redesign surfaced. Drawer/Dropdown/Tooltip
// use @radix-ui for behavior (focus trap, positioning, keyboard nav); Avatar
// uses Radix for image-fallback; Skeleton is presentational only.
export { Drawer, DrawerBody, DrawerFooter } from "./Drawer";
export type { DrawerProps } from "./Drawer";
export { Avatar } from "./Avatar";
export type { AvatarProps, AvatarSize } from "./Avatar";
export { Dropdown, DropdownItem, DropdownSeparator, DropdownLabel } from "./Dropdown";
export type { DropdownProps, DropdownItemProps } from "./Dropdown";
export { Skeleton, SkeletonText } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";
export { Tooltip, TooltipWrapped, TooltipProvider } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

// Legacy primitives — prefixed so the new Badge doesn't clash with the
// old Badge. Existing screens import the specific name they need from
// "@/components/ui/primitives" directly; this is just a convenience.
export {
  Panel,
  Metric,
  Row,
  Empty as LegacyEmpty,
  StatusPill,
  Field,
  SecretField,
  Chips,
  ProfileRows,
} from "./primitives";
// 2026-09-25 — headline "what needs you" tile (AI Settings, Knowledge Base).
export { StatusTile } from "./StatusTile";
export type { StatusTileProps, StatusTileTone } from "./StatusTile";
// 2026-09-28 — finishing actions; sticky at the bottom on phones, inline on desktop.
export { ActionBar } from "./ActionBar";
export type { ActionBarProps } from "./ActionBar";
