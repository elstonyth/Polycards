import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { ProfitReport } from '../../lib/admin-rest';
import { rm } from '../../lib/format';
import { Hint } from '../../components/Hint';
import { CountUp } from '../overview/KpiTiles';
import { NetChange } from '../overview/MoneyFlowCard';
import { moneyTrail, type TrailRow } from './money-trail';

const BAR: Record<TrailRow['tone'], string> = {
  in: 'bg-ui-tag-green-icon',
  out: 'bg-ui-tag-red-icon',
  kept: 'bg-ui-tag-green-icon opacity-50',
  loss: 'bg-ui-tag-red-icon opacity-50',
};

const signed = (n: number) =>
  n < 0 ? `− ${rm(Math.abs(n))}` : n > 0 ? rm(n) : rm(0);

/** Cash kept, and the trail that explains it: in, fees, out, what stayed. */
export const CashCard = ({ data }: { data: ProfitReport }) => {
  const { t } = useTranslation();
  const { cash } = data;
  const trail = moneyTrail(cash);
  const missing = cash.topups.missing_fees + cash.withdrawals.missing_fees;
  const loss = cash.kept < 0;
  return (
    <Container className="pc-settle flex flex-col gap-5 [animation-delay:40ms]">
      <div>
        <div className="flex items-center gap-1.5">
          <Text size="small" className="text-ui-fg-subtle">
            {t('profit.cashKept')}
          </Text>
          <Hint text={t('profit.cashKeptHint')} />
        </div>
        <Heading
          level="h1"
          className={`mt-1 text-3xl tabular-nums ${loss ? 'text-ui-fg-error' : 'text-ui-tag-green-text'}`}
        >
          <CountUp value={cash.kept} format={rm} />
        </Heading>
        {cash.previous_kept !== null && (
          <div className="mt-1.5 flex items-center gap-2">
            <NetChange cur={cash.kept} prev={cash.previous_kept} />
            <Text size="xsmall" className="text-ui-fg-muted">
              {t('profit.vsLast')}
            </Text>
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-2.5">
        {trail.rows.map((r) => {
          const total = r.key === 'kept';
          return (
            <li
              key={r.key}
              className={`grid grid-cols-[minmax(0,10rem)_1fr_8.5rem] items-center gap-3 ${total ? 'border-t pt-2.5' : ''}`}
            >
              <Text
                size="small"
                weight={total ? 'plus' : 'regular'}
                className={total ? '' : 'text-ui-fg-subtle'}
              >
                {t(`profit.trail.${r.key}`)}
              </Text>
              <div
                className="bg-ui-bg-component relative h-3 overflow-hidden rounded-full"
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
                {signed(r.amount)}
              </Text>
            </li>
          );
        })}
      </ul>

      {missing > 0 && (
        <Text size="xsmall" className="text-ui-fg-muted">
          {t('profit.feeFloor', { count: missing })}
        </Text>
      )}
    </Container>
  );
};
