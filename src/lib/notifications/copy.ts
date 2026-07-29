import {
  Bell,
  CreditCard,
  Gift,
  Package,
  Sparkles,
  Ticket,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { rm } from '@/lib/format';

/**
 * Whether the notification feed is allowed to raise a toast for a template.
 *
 * 'never' does NOT mean silent — it means something else already announced it
 * on the tab that caused it (a client toast, or PrizeReveal). Toasting again
 * would double up, and de-duplicating by notification id cannot catch that
 * because a client toast has no notification id.
 */
export type ToastPolicy = 'always' | 'never';

export type NotificationVariant = 'success' | 'info' | 'reward';

export type NotificationCopy = {
  icon: LucideIcon;
  variant: NotificationVariant;
  policy: ToastPolicy;
  /** Static — titles never depend on payload data. */
  title: string;
  /** Payload-derived detail line. Returns null when there is nothing to add. */
  body: (data: Record<string, unknown> | null) => string | null;
  /** Where tapping goes, or null when there is nowhere useful. */
  href: string | null;
  /** Visible affordance label. Always set together with href. */
  action: string | null;
};

// --- payload readers ---------------------------------------------------------
// `data` is whatever the backend wrote, parsed through a loose Zod schema, so
// every read is defensive. A malformed payload degrades to a missing detail
// line, never a crash in a toast or a feed row.

function numOf(
  data: Record<string, unknown> | null,
  key: string,
): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOf(
  data: Record<string, unknown> | null,
  key: string,
): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function numsOf(data: Record<string, unknown> | null, key: string): number[] {
  const v = data?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x),
  );
}

/** "23" · "22 and 23" · "21, 22 and 23" — an Oxford-less list, read aloud well. */
function joinNatural(items: (string | number)[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return String(items[0]);
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// --- the registry ------------------------------------------------------------

export const NOTIFICATION_COPY: Record<string, NotificationCopy> = {
  vip_level_up: {
    icon: Sparkles,
    variant: 'reward',
    // Nothing else announces a level-up: the slot machine never mentions it.
    // This is the gap that started the whole feature.
    policy: 'always',
    title: 'You leveled up!',
    body: (data: Record<string, unknown> | null) => {
      const levels = numsOf(data, 'levels');
      if (levels.length === 0) return null;
      return levels.length === 1
        ? `You reached level ${levels[0]}.`
        : `You reached levels ${joinNatural(levels)}.`;
    },
    href: null,
    action: null,
  },

  commission_matured: {
    icon: TrendingUp,
    variant: 'success',
    policy: 'always',
    title: 'Commission unlocked',
    body: (data) =>
      data?.frozen === true
        ? 'It will be available once your account is unfrozen.'
        : 'Your commission is now available to spend.',
    href: '/transactions',
    action: 'View ledger',
  },

  delivery_status: {
    icon: Package,
    variant: 'info',
    policy: 'always',
    title: 'Delivery update',
    body: (data) => {
      const status = strOf(data, 'status');
      const tracking = strOf(data, 'tracking_number');
      if (status === 'shipped') {
        return tracking
          ? `Your order is on its way. Tracking: ${tracking}`
          : 'Your order is on its way.';
      }
      // `completed` is the wire status; "delivered" is the customer's word.
      // 'delivered' = legacy token — persisted notification rows and
      // rollback-era backends still emit it during the expand window.
      if (status === 'completed' || status === 'delivered') {
        return 'Your order was delivered.';
      }
      if (status === 'canceled') {
        return 'Your delivery was canceled. Contact support if this was unexpected.';
      }
      return null;
    },
    href: '/orders',
    action: 'View orders',
  },

  reward_won: {
    icon: Gift,
    variant: 'reward',
    // PrizeReveal is already a full-screen announcement on the tab that drew.
    policy: 'never',
    title: 'You won a reward!',
    body: (data) => {
      const title = strOf(data, 'title');
      const amount = numOf(data, 'amount_myr');
      if (title) return `You won ${title}.`;
      if (amount && amount > 0) {
        // A voucher is a grant, not money: nothing reaches the balance until
        // it is claimed (claiming is suspended alongside the VIP page — spec
        // 2026-07-29). Saying "in credit" here would claim a payment that has
        // not happened, and could leave the grant sitting unclaimed.
        // PrizeReveal already draws this distinction — the feed row must not
        // contradict it.
        return strOf(data, 'prize_kind') === 'voucher'
          ? `You won a ${rm(amount)} voucher.`
          : `You won ${rm(amount)} in credit.`;
      }
      return null;
    },
    // /rewards was a redirect stub into /vip, so it 404s with the rest of the
    // suspended reward surfaces (spec 2026-07-29) — historical reward_won rows
    // would otherwise still render a live "View rewards →" into a dead route.
    href: null,
    action: null,
  },

  voucher_claimed: {
    icon: Ticket,
    variant: 'success',
    // The claim flow raises its own toast on the tab that claimed.
    policy: 'never',
    title: 'Voucher redeemed',
    body: (data) => {
      const amount = numOf(data, 'amount_myr');
      const level = numOf(data, 'level');
      if (amount === null) return null;
      return level
        ? `${rm(amount)} credited from your Level ${level} voucher.`
        : `${rm(amount)} credited to your balance.`;
    },
    href: null,
    action: null,
  },

  topup_credited: {
    icon: CreditCard,
    variant: 'success',
    // The top-up sheet confirms the charge on the tab that made it.
    policy: 'never',
    title: 'Top-up complete',
    body: (data) => {
      const amount = numOf(data, 'amount_myr');
      return amount === null ? null : `${rm(amount)} added to your balance.`;
    },
    href: '/transactions',
    action: 'View ledger',
  },
};

/**
 * Copy for a template, with a safe fallback.
 *
 * An unknown template means the backend shipped one the storefront has not
 * learned yet. Showing the raw template name is ugly but honest, and the
 * 'never' policy keeps an unknown payload from raising a toast whose body no
 * one has reviewed.
 */
export function copyFor(template: string): NotificationCopy {
  return (
    NOTIFICATION_COPY[template] ?? {
      icon: Bell,
      variant: 'info',
      policy: 'never',
      title: template,
      body: () => null,
      href: null,
      action: null,
    }
  );
}
