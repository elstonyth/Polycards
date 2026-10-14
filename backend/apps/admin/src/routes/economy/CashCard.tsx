import { useTranslation } from 'react-i18next';
import { Badge, Container, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { Hint } from '../../components/Hint';
import { CountUp } from '../overview/KpiTiles';
import { NetChange } from '../overview/MoneyFlowCard';
import { moneyTrail, type TrailRow } from './money-trail';
import { signed } from './signs';

const BAR: Record<TrailRow['tone'], string> = {
  in: 'bg-ui-tag-green-icon',
  out: 'bg-ui-tag-red-icon',
  kept: 'bg-ui-tag-green-icon opacity-50',
  loss: 'bg-ui-tag-red-icon opacity-50',
};

/** Cash kept, and the trail that explains it: in, fees, out, what stayed. */
export const CashCard = ({ data }: { data: ProfitReport }) => {
  const { t } = useTranslation();
  const { cash } = data;
  const trail = moneyTrail(cash);
  const missing = cash.topups.missing_fees + cash.withdrawals.missing_fees;
  // Top-ups settled by hand have no amount on file: the sum is a minimum.
  const grossFloor = cash.topups.missing_gross > 0;
  const loss = cash.kept < 0;
  const hints: Partial<Record<TrailRow['key'], string>> = {
    fees: t('profit.feeSplit', {
      topups: rm(cash.topups.fees),
      payouts: rm(cash.withdrawals.fees),
    }),
    fx: t('profit.fxHint'),
  };
  return (
    <Container className="pc-settle flex flex-col gap-5 [animation-delay:40ms]">
      <div>
        <div className="flex items-center gap-1.5">
          <Text size="small" className="text-ui-fg-subtle">
            {t('profit.cashKept')}
          </Text>
          <Hint text={t('profit.cashKeptHint')} />
          {(grossFloor || missing > 0) && (
            <Badge size="2xsmall" color="orange">
              {t('profit.estimate')}
            </Badge>
          )}
        </div>
        <Text
          className={`mt-1 text-3xl font-semibold tabular-nums ${loss ? 'text-ui-fg-error' : 'text-ui-tag-green-text'}`}
        >
          <CountUp value={cash.kept} format={signed} />
        </Text>
        {cash.previous_kept !== null && (
          <div className="mt-1.5 flex items-center gap-2">
            <NetChange cur={cash.kept} prev={cash.previous_kept} />
            <Text size="xsmall" className="text-ui-fg-subtle">
              {t('profit.vsLast')}
            </Text>
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-2.5">
        {trail.rows.map((r) => {
          const total = r.key === 'kept';
          const hint = hints[r.key];
          return (
            // Phones: label and amount on one line, the bar under them.
            <li
              key={r.key}
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,10rem)_minmax(6rem,1fr)_8.5rem] ${total ? 'border-t pt-2.5' : ''}`}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <Text
                  size="small"
                  weight={total ? 'plus' : 'regular'}
                  className={total ? '' : 'text-ui-fg-subtle'}
                >
                  {t(`profit.trail.${r.key}`)}
                </Text>
                {hint && <Hint text={hint} />}
              </div>
              <div
                className="bg-ui-bg-component relative col-span-2 row-start-2 h-3 overflow-hidden rounded-full sm:col-span-1 sm:row-start-auto"
                aria-hidden
              >
                <div
                  className={`pc-grow absolute inset-y-0 origin-left rounded-full ${BAR[r.tone]}`}
                  style={{ left: `${r.left}%`, width: `${r.width}%` }}
                />
              </div>
              <Text
                size="small"
                weight="plus"
                className={`text-right tabular-nums ${
                  r.tone === 'loss' ? 'text-ui-fg-error' : ''
                }`}
              >
                {r.key === 'topups' && grossFloor ? '≥ ' : ''}
                {r.key === 'fx' && r.amount > 0 ? '+ ' : ''}
                {signed(r.amount)}
              </Text>
            </li>
          );
        })}
      </ul>

      {grossFloor && (
        <Text size="xsmall" className="text-ui-fg-subtle">
          {t('profit.grossFloor', { count: cash.topups.missing_gross })}
        </Text>
      )}
      {missing > 0 && (
        <Text size="xsmall" className="text-ui-fg-subtle">
          {t('profit.feeFloor', { count: missing })}
        </Text>
      )}
    </Container>
  );
};
