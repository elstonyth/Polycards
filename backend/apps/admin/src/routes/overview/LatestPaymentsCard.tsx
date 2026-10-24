import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Container, Heading, StatusBadge, Text } from '@medusajs/ui';
import {
  useRecentGatewayDeposits,
  useRecentGatewayWithdrawals,
} from '../../lib/queries';
import { rm, timeAgo } from '../../lib/format';
import { latestPayments, paymentStatus } from '../../lib/dashboard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { isForbidden } from './helpers';
import { SectionError } from './SectionState';

const SHOWN = 6;

/** The newest top-ups and withdrawals together; a row opens the player. */
export const LatestPaymentsCard = ({
  className = '',
}: {
  className?: string;
}) => {
  const { t } = useTranslation();
  // The newest few of each, newest first. Top-ups are settled ones only (see
  // useRecentGatewayDeposits); withdrawals are every status.
  const deposits = useRecentGatewayDeposits(SHOWN);
  const withdrawals = useRecentGatewayWithdrawals(SHOWN);
  const forbidden =
    (deposits.isError && isForbidden(deposits.error)) ||
    (withdrawals.isError && isForbidden(withdrawals.error));
  if (forbidden) return null;
  const rows =
    deposits.data && withdrawals.data
      ? latestPayments(
          deposits.data.deposits,
          withdrawals.data.withdrawals,
          SHOWN,
        )
      : undefined;

  return (
    <Container
      className={`pc-settle flex flex-col gap-2 [animation-delay:210ms] ${className}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Heading level="h3">{t('dashboard.paymentsTitle')}</Heading>
        <Link
          to="/ledger"
          className="txt-compact-small text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
        >
          {t('dashboard.viewAll')} <span aria-hidden>→</span>
        </Link>
      </div>
      {deposits.isError || withdrawals.isError ? (
        <SectionError
          onRetry={() => {
            void deposits.refetch();
            void withdrawals.refetch();
          }}
        />
      ) : !rows ? (
        <LoadingSkeleton />
      ) : rows.length === 0 ? (
        <Text size="small" className="text-ui-fg-subtle py-6">
          {t('dashboard.noPayments')}
        </Text>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => {
            const s = paymentStatus(r.kind, r.status);
            const deposit = r.kind === 'deposit';
            return (
              <li key={`${r.kind}-${r.id}`}>
                <Link
                  to={`/customers/${r.customerId}`}
                  className="hover:bg-ui-bg-base-hover -mx-2 grid grid-cols-[32px_minmax(0,1fr)_7.5rem_7.5rem] items-center gap-x-4 rounded-md px-2 py-2.5"
                >
                  <span
                    aria-hidden
                    className="bg-ui-bg-component text-ui-fg-subtle txt-compact-xsmall-plus flex size-8 items-center justify-center rounded-full uppercase"
                  >
                    {(r.email ?? '?').slice(0, 2)}
                  </span>
                  <span className="min-w-0">
                    <Text
                      as="span"
                      size="small"
                      weight="plus"
                      leading="compact"
                      className="block truncate"
                    >
                      {r.email ?? r.customerId}
                    </Text>
                    <Text
                      as="span"
                      size="xsmall"
                      className="text-ui-fg-subtle block"
                    >
                      {t(deposit ? 'dashboard.topUp' : 'dashboard.withdrawal')}{' '}
                      · {timeAgo(r.at)}
                    </Text>
                  </span>
                  {/* Table-like columns: badges share one left edge, amounts the
                      card's right edge, whatever the label or amount width. */}
                  <span className="justify-self-start">
                    <StatusBadge color={s.color}>{t(s.labelKey)}</StatusBadge>
                  </span>
                  <Text
                    size="small"
                    weight="plus"
                    className={`text-right tabular-nums ${deposit ? 'text-ui-tag-green-text' : 'text-ui-fg-base'}`}
                  >
                    {deposit ? '+' : '−'}
                    {rm(r.amount)}
                  </Text>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
};
