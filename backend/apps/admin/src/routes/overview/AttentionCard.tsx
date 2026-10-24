import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, Container, Heading, Label, Switch, Text } from '@medusajs/ui';
import {
  ArrowUpTray,
  Clock,
  ExclamationCircle,
  Gift,
  TruckFast,
} from '@medusajs/icons';
import {
  useDeliveryOrderCount,
  useGatewayAudit,
  useGatewayDeposits,
  useGatewayWithdrawals,
  useReferralSettlements,
  usePricingHealth,
} from '../../lib/queries';
import { rm, timeAgo } from '../../lib/format';
import {
  attentionWithdrawals,
  doublePayAcross,
  stuckDeposits,
} from '../../lib/dashboard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { isForbidden } from './helpers';
import { SectionError } from './SectionState';
import { useAttentionAlert } from './use-attention-alert';

interface Item {
  id: string;
  icon: ReactNode;
  title: string;
  detail: string;
  to: string;
  action: string;
  urgent?: boolean;
}

const Row = ({ item }: { item: Item }) => (
  <div className="bg-ui-bg-subtle flex items-center gap-3 rounded-lg px-3 py-2.5">
    <div className="bg-ui-bg-base shadow-borders-base relative flex size-9 shrink-0 items-center justify-center rounded-md text-ui-fg-subtle">
      {item.icon}
      {item.urgent && <span className="pc-ping" aria-hidden />}
    </div>
    <div className="min-w-0 flex-1">
      <Text size="small" weight="plus" leading="compact">
        {item.title}
      </Text>
      <Text size="xsmall" className="text-ui-fg-subtle truncate">
        {item.detail}
      </Text>
    </div>
    <Button
      size="small"
      variant={item.urgent ? 'primary' : 'secondary'}
      asChild
    >
      {/* Several rows share a verb ("Review"); the label names the queue. */}
      <Link to={item.to} aria-label={`${item.action}: ${item.title}`}>
        {item.action}
      </Link>
    </Button>
  </div>
);

/** Work waiting on an operator; each row links to the page that resolves it. */
export const AttentionCard = ({ className = '' }: { className?: string }) => {
  const { t } = useTranslation();
  const held = useGatewayWithdrawals(0, 'held');
  const pending = useGatewayDeposits(0, 'pending');
  const requested = useDeliveryOrderCount('requested');
  const processed = useDeliveryOrderCount('processed');
  const ready = useDeliveryOrderCount('ready_to_ship');
  const runs = useReferralSettlements();
  // Every rail: a refunded payout any gateway still holds or paid.
  const auditRm = useGatewayAudit('MYR');
  const auditSgd = useGatewayAudit('SGD');
  const auditUsdt = useGatewayAudit('USDT');
  const pricing = usePricingHealth();
  const queries = [
    held,
    pending,
    requested,
    processed,
    ready,
    runs,
    auditRm,
    auditSgd,
    auditUsdt,
    pricing,
  ];
  const shipping = [requested, processed, ready];

  const w = held.data
    ? attentionWithdrawals(held.data.withdrawals, held.data.total)
    : undefined;
  const s = pending.data
    ? stuckDeposits(pending.data.deposits, pending.data.total)
    : undefined;
  const toShip = shipping.every((q) => q.data !== undefined)
    ? shipping.reduce((n, q) => n + (q.data ?? 0), 0)
    : undefined;
  const drafts = runs.data?.filter((r) => r.status === 'draft');
  const twice = doublePayAcross([auditRm.data, auditSgd.data, auditUsdt.data]);

  // Only queues that loaded are counted, so a failed read is never "zero".
  const counts: Record<string, number> = {};
  if (w) counts.withdrawals = w.count;
  if (s) counts.deposits = s.count;
  if (toShip !== undefined) counts.orders = toShip;
  if (drafts) counts.referrals = drafts.length;
  if (twice) counts.doublePay = twice.count;
  if (pricing.data && !pricing.isError)
    counts.pricing = pricing.data.cards.issues.length;
  const { soundOn, setSound } = useAttentionAlert(counts);

  // A query this role may not read is left out; any other failure shows.
  // If the role can read none of them, the card hides rather than claim
  // "all clear" about queues it can't see.
  if (queries.every((q) => q.isError && isForbidden(q.error))) return null;
  const failed = queries.filter((q) => q.isError && !isForbidden(q.error));
  const loading = queries.some((q) => q.isPending);

  const items: Item[] = [];
  // First: money that may leave twice outranks every queue below.
  if (twice && twice.count > 0) {
    items.push({
      id: 'double-pay',
      icon: <ExclamationCircle />,
      title: t('dashboard.doublePay', {
        count: twice.count,
        shown: String(twice.count),
      }),
      detail: t(
        twice.paid > 0 ? 'dashboard.doublePayPaid' : 'dashboard.doublePayHeld',
        { amount: rm(twice.amount), count: twice.paid },
      ),
      to: '/settlement',
      action: t('dashboard.check'),
      urgent: true,
    });
  }
  if (w && w.count > 0) {
    items.push({
      id: 'withdrawals',
      icon: <ArrowUpTray />,
      title: t('dashboard.withdrawalsToApprove', {
        count: w.count,
        shown: String(w.count),
      }),
      detail: t(
        w.amountPartial
          ? 'dashboard.withdrawalsDetailCapped'
          : 'dashboard.withdrawalsDetail',
        { amount: rm(w.amount), age: w.oldest ? timeAgo(w.oldest) : '—' },
      ),
      to: '/withdrawals',
      action: t('dashboard.review'),
      urgent: true,
    });
  }
  if (pricing.data && pricing.data.cards.issues.length > 0) {
    items.push({
      id: 'pricing',
      icon: <ExclamationCircle />,
      title: t('dashboard.pricingAttention', {
        count: pricing.data.cards.issues.length,
      }),
      detail: t('dashboard.pricingDetail', {
        count: pricing.data.cards.pending_confirmation,
      }),
      to: '/cards?pricing=attention',
      action: t('dashboard.review'),
      urgent: true,
    });
  }
  // Stuck only (2026-10-25): a customer who opened the cashier and walked away
  // is not shown — operators read that as a gateway fault. What is left is
  // rare and real: the gateway never confirmed a top-up the customer may have
  // paid. Calm (no ping), and the link opens the pending view, oldest first.
  if (s && s.count > 0) {
    const shown = s.capped ? `${s.count}+` : String(s.count);
    items.push({
      id: 'deposits',
      icon: <Clock />,
      title: t('dashboard.stuckTopups', { count: s.count, shown }),
      detail: t('dashboard.stuckDetail', {
        age: s.oldest ? timeAgo(s.oldest) : '—',
      }),
      to: '/deposits?view=pending',
      action: t('dashboard.check'),
    });
  }
  if (toShip) {
    items.push({
      id: 'orders',
      icon: <TruckFast />,
      title: t('dashboard.ordersToShip', {
        count: toShip,
        shown: String(toShip),
      }),
      detail: t('dashboard.ordersDetail'),
      to: '/deliveries',
      action: t('dashboard.ship'),
    });
  }
  if (drafts?.length) {
    items.push({
      id: 'referrals',
      icon: <Gift />,
      title: t('dashboard.referralReview', {
        count: drafts.length,
        shown: String(drafts.length),
      }),
      detail: t('dashboard.referralDetail', {
        amount: rm(
          drafts.reduce((sum, r) => sum + r.total_commission_cents, 0) / 100,
        ),
      }),
      to: '/referrals',
      action: t('dashboard.review'),
    });
  }

  return (
    <Container
      className={`pc-settle flex flex-col gap-3 [animation-delay:40ms] ${className}`}
    >
      <div className="flex items-center justify-between gap-3">
        <Heading level="h3">{t('dashboard.attentionTitle')}</Heading>
        <div className="flex items-center gap-2">
          <Switch
            id="pc-attention-sound"
            size="small"
            checked={soundOn}
            onCheckedChange={setSound}
          />
          <Label
            htmlFor="pc-attention-sound"
            size="small"
            className="text-ui-fg-subtle"
            title={t('dashboard.soundHint')}
          >
            {t('dashboard.sound')}
          </Label>
        </div>
      </div>
      {items.map((item) => (
        <Row key={item.id} item={item} />
      ))}
      {failed.length > 0 && (
        <SectionError onRetry={() => failed.forEach((q) => void q.refetch())} />
      )}
      {loading && items.length === 0 ? (
        <LoadingSkeleton />
      ) : (
        items.length === 0 &&
        failed.length === 0 && (
          <Text size="small" className="text-ui-fg-subtle py-4">
            {t('dashboard.allClear')}
          </Text>
        )
      )}
    </Container>
  );
};
