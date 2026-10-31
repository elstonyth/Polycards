import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import type { ProfitRange } from '../../lib/admin-rest';
import { useProfitReport } from '../../lib/queries';
import { useScopeParam } from '../../lib/scope-param';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { RangePicker } from '../overview/RangePicker';
import { dayRangeText, todayMyt } from '../overview/helpers';
import { SectionError } from '../overview/SectionState';
import { ScopeSwitch } from './ScopeSwitch';
import { CashCard } from './CashCard';
import { OwedCard } from './OwedCard';
import { ActivityCard } from './ActivityCard';
import { PayoutRateCard } from './PayoutRateCard';

export const config: RouteConfig = {
  label: 'pcNav.profitReport',
  translationNs: 'translation',
  rank: 4,
  nested: '/payments',
  permissions: ['profit_report:read' as Permission],
};

// The Dashboard's presets plus all time, before Custom.
const PROFIT_RANGES: readonly ProfitRange[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'all',
  'custom',
];

// The Profit report (spec docs/superpowers/specs/2026-10-14-admin-finance-
// pages-design.md §4, mockup A "money trail"): cash kept for the period, what
// players could still cash out right now, where credit moved, and each pack's
// payout rate. Real customers by default; the switch shows every account.
const ProfitReportPage = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<ProfitRange>('month');
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const [scope, setScope] = useScopeParam();
  const report = useProfitReport(range, from, to, scope);
  const data = report.data;

  return (
    <div className="pc-dashboard flex flex-col gap-y-3">
      <Container className="pc-settle flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Heading level="h1">{t('profit.title')}</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              {!data
                ? '…'
                : data.window
                  ? t('profit.subtitle', { window: dayRangeText(data.window) })
                  : t('profit.subtitleAll')}
            </Text>
          </div>
          <ScopeSwitch scope={scope} onScope={setScope} />
        </div>
        <RangePicker
          range={range}
          onRange={setRange}
          ranges={PROFIT_RANGES}
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
        />
      </Container>

      {report.isError ? (
        <Container>
          <SectionError onRetry={() => void report.refetch()} />
        </Container>
      ) : !data ? (
        <Container>
          <LoadingSkeleton />
        </Container>
      ) : (
        // The previous numbers stay while a new scope or period loads; dim
        // them so they never read as the answer under the new pill.
        <div
          className={`flex flex-col gap-y-3 transition-opacity ${
            report.isPlaceholderData ? 'opacity-50' : ''
          }`}
          aria-busy={report.isPlaceholderData}
        >
          <CashCard data={data} />
          <OwedCard data={data} />
          <ActivityCard data={data} />
          <PayoutRateCard data={data} />
        </div>
      )}
    </div>
  );
};

export default ProfitReportPage;
