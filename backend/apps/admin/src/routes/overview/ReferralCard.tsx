import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Container, Heading, Text } from '@medusajs/ui';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from 'recharts';
import { useReferralSettlements } from '../../lib/queries';
import { rm } from '../../lib/format';
import { referralSeries, type RefPoint } from '../../lib/dashboard';
import { prefersReducedMotion } from '../../lib/use-count-up';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { isForbidden } from './helpers';
import { SectionError } from './SectionState';

// The latest week is the one an operator acts on: emphasis colour; the rest recede.
const LATEST = 'var(--tag-orange-icon)';
const REST = 'var(--border-strong)';

const RefTooltip = ({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: RefPoint }[];
}) => {
  const { t } = useTranslation();
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  return (
    <div className="bg-ui-bg-base shadow-elevation-flyout rounded-lg px-3 py-2">
      <Text size="xsmall" className="text-ui-fg-subtle">
        {t('dashboard.weekOf', { label: p.label })}
      </Text>
      <Text size="xsmall" weight="plus" className="tabular-nums">
        {rm(p.amount)}
      </Text>
    </div>
  );
};

/** Weekly referral commission runs (GET /admin/referrals/settlements). */
export const ReferralCard = ({ className = '' }: { className?: string }) => {
  const { t } = useTranslation();
  const runs = useReferralSettlements();
  if (runs.isError && isForbidden(runs.error)) return null;
  const series = referralSeries(runs.data ?? [], 12);
  const last = series.length - 1;
  // Only the latest week carries a value label (keyed by position, not value).
  const data = series.map((p, i) => ({
    ...p,
    top: i === last ? rm(p.amount) : '',
  }));

  return (
    <Container
      className={`pc-settle flex flex-col gap-3 [animation-delay:180ms] ${className}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Heading level="h3">{t('dashboard.refTitle')}</Heading>
        <Link
          to="/referrals"
          className="txt-compact-small text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
        >
          {t('dashboard.openReferrals')} <span aria-hidden>→</span>
        </Link>
      </div>
      <Text size="xsmall" className="text-ui-fg-muted">
        {t('dashboard.refHint')}
      </Text>
      {runs.isError ? (
        <SectionError onRetry={() => void runs.refetch()} />
      ) : !runs.data ? (
        <LoadingSkeleton />
      ) : series.every((p) => p.amount === 0) ? (
        <Text size="small" className="text-ui-fg-subtle py-10 text-center">
          {t(
            series.length === 0 ? 'dashboard.noRefs' : 'dashboard.noCommission',
          )}
        </Text>
      ) : (
        <>
          <ul className="sr-only">
            {series.map((p) => (
              <li key={p.key}>
                {t('dashboard.weekOf', { label: p.label })}: {rm(p.amount)}
              </li>
            ))}
          </ul>
          <div className="h-52 w-full" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 24, right: 4, bottom: 0, left: 4 }}
              >
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'var(--fg-subtle)', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <Tooltip
                  cursor={{ fill: 'var(--bg-base-hover)' }}
                  content={<RefTooltip />}
                />
                <Bar
                  dataKey="amount"
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={!prefersReducedMotion()}
                  animationDuration={700}
                >
                  {series.map((p, i) => (
                    <Cell key={p.key} fill={i === last ? LATEST : REST} />
                  ))}
                  <LabelList
                    dataKey="top"
                    position="top"
                    className="fill-ui-fg-base text-xs font-medium"
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Container>
  );
};
