// Shared display formatters for the gacha admin pages. Pure and dependency-free
// so they can be unit-tested in a node environment (see format.test.ts). The
// one import below is type-only, so it is erased at compile time and the node
// test never loads admin-rest (which needs the injected __BACKEND_URL__).

import type { DeliveryStatus } from './admin-rest';

// Display labels only — state/API keep the raw lowercase values. This is the
// OPERATOR surface: 'completed' reads "Completed" here, while the same status
// is worded "delivered" to the customer (see delivery.ts). Shared rather than
// per-page so the All Orders table and its packing slip can never drift.
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  requested: 'Requested',
  processed: 'Processed',
  ready_to_ship: 'Ready to ship',
  shipped: 'Shipped',
  completed: 'Completed',
  canceled: 'Canceled',
};

// Label for a status that came off the wire. Falls back to the raw token
// because the delivery-order CHECK still accepts the pre-rename
// 'packing'/'delivered' during the expand window (see
// Migration20260727000000), so a rollback or PRE_DEPLOY skew can put a value
// here that the six-key map has no entry for — and a bare lookup renders an
// empty badge / empty packing slip, which reads as "the order is broken".
// Use this for anything the API supplied; index DELIVERY_STATUS_LABEL directly
// only for literals we control (the tab and select lists), which keeps the map
// exhaustive so a seventh canonical status stays a compile error.
export const deliveryStatusLabel = (status: string): string =>
  DELIVERY_STATUS_LABEL[status as DeliveryStatus] ?? status;

export const rm = (n: number | null): string =>
  n === null
    ? '—'
    : `RM ${n.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

// USD → MYR at the given rate (2dp), mirroring the backend displayMarketPrice at
// multiplier 1. Card FMV is tracked in USD (PriceCharting-native); the admin
// shows RM at the live rate, no markup (markup lives on the sale price). Bad
// inputs — non-finite, fx <= 0, or negative usd (FMV is never negative) —
// collapse to 0 rather than emitting NaN.
// COUPLED MIRROR of displayMarketPrice(usd, fx, 1) in
// backend/packages/api/src/modules/packs/pricing.ts — keep in sync; parity
// asserted in ./format.test.ts (separate packages, no shared import).
export const usdToMyr = (usd: number, fx: number): number =>
  Number.isFinite(usd) && usd >= 0 && Number.isFinite(fx) && fx > 0
    ? Math.round(usd * fx * 100) / 100
    : 0;

// MYR → USD at the given rate (2dp) — the inverse, used when an operator authors
// a value in RM but the stored/submitted FMV must stay USD so the daily
// PriceCharting sync and buyback math keep their USD source of truth.
export const myrToUsd = (myr: number, fx: number): number =>
  Number.isFinite(myr) && Number.isFinite(fx) && fx > 0
    ? Math.round((myr / fx) * 100) / 100
    : 0;

// `now` is injectable so the function is pure and testable with a fixed clock;
// the default keeps every existing callsite (`timeAgo(iso)`) byte-identical.
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// `dd-MM-yyyy hh:mm a` in the operator's local timezone — the order-table and
// packing-slip date format. Hand-rolled rather than Intl because no locale
// gives this exact shape (en-GB → slashes + lowercase am/pm, en-US → MM/dd),
// and formatToParts costs more than the four lines below.
export function orderDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const h = d.getHours();
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(h % 12 || 12)}:${p(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

export const fmtPct = (n: number): string =>
  `${Number.isInteger(n) ? n : n.toFixed(2)}%`;

// Client mirror of backend/packages/api/src/modules/packs/pricecharting-grades.ts
// gradeToGrader — the admin app and the Medusa backend are separate builds with
// no shared package, so this ~5-line pure function is duplicated rather than
// wired through a new workspace package. Keep in sync if the backend changes.
// Used by both the from-PriceCharting page and the register-card modal to
// derive an operator-facing grader/grade suggestion from a PC tier label.
export function gradeToGrader(label: string): { grader: string; grade: string } {
  for (const g of ['PSA', 'BGS', 'CGC', 'SGC']) {
    if (label.startsWith(g + ' ')) {
      return { grader: g, grade: label.slice(g.length + 1) };
    }
  }
  if (label.startsWith('Grade ')) return { grader: '', grade: label.slice(6) };
  return { grader: '', grade: label };
}
