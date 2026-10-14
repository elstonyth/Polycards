import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, Container, Heading, Text } from '@medusajs/ui';
import { ArrowUpTray, Clock, Gift, TruckFast } from '@medusajs/icons';
import {
  useDeliveryOrderCount,
  useGatewayDeposits,
  useGatewayWithdrawals,
  useReferralSettlements,
} from '../../lib/queries';
import { rm, timeAgo } from '../../lib/format';
import { attentionWithdrawals, staleDeposits } from '../../lib/dashboard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { isForbidden } from './helpers';
import { SectionError } from './SectionState';

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
  const queries = [held, pending, requested, processed, ready, runs];
  // A query this role may not read is left out; any other failure shows.
  // If the role can read none of them, the card hides rather than claim
  // "all clear" about queues it can't see.
  if (queries.every((q) => q.isError && isForbidden(q.error))) return null;
  const failed = queries.filter((q) => q.isError && !isForbidden(q.error));
  const loading = queries.some((q) => q.isPending);

  const items: Item[] = [];
  if (held.data) {
    const w = attentionWithdrawals(held.data.withdrawals, held.data.total);
    if (w.count > 0) {
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
  }
  if (pending.data) {
    const s = staleDeposits(pending.data.deposits, pending.data.total);
    if (s.count > 0) {
      const shown = s.capped ? `${s.count}+` : String(s.count);
      items.push({
        id: 'deposits',
        icon: <Clock />,
        title: t('dashboard.staleTopups', { count: s.count, shown }),
        detail: t('dashboard.staleDetail', {
          age: s.oldest ? timeAgo(s.oldest) : '—',
        }),
        to: '/deposits',
        action: t('dashboard.check'),
        urgent: true,
      });
    }
  }
  const toShip = [requested, processed, ready].reduce(
    (n, q) => n + (q.data ?? 0),
    0,
  );
  if (toShip > 0) {
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
  const drafts = (runs.data ?? []).filter((r) => r.status === 'draft');
  if (drafts.length > 0) {
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
      <div className="flex items-center justify-between">
        <Heading level="h3">{t('dashboard.attentionTitle')}</Heading>
        {items.length > 0 && (
          <Text size="small" className="text-ui-fg-subtle tabular-nums">
            {items.length}
          </Text>
        )}
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
