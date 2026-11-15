import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import type { ProfitRange } from '../../lib/admin-rest';
import { usePnlReport } from '../../lib/queries';
import { useScopeParam } from '../../lib/scope-param';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { RangePicker } from '../overview/RangePicker';
import { dayRangeText, todayMyt } from '../overview/helpers';
import { SectionError } from '../overview/SectionState';
import { ScopeSwitch } from '../economy/ScopeSwitch';
import { PackSalesCard } from './PackSalesCard';
import { CogsCard } from './CogsCard';
import { CoinFlipCard, LuckyDrawCard } from './GamesCards';
import { ShippingCard, TotalsCard } from './SummaryCards';
import { MarketingCard } from './MarketingCard';
import { AssetsCard, FloatingMoneyCard } from './BalanceCards';

export const config: RouteConfig = {
  label: 'pcNav.pnl',
  translationNs: 'translation',
  rank: 5,
  nested: '/payments',
  // Served under /admin/profit-report, so the Profit report's permission.
  permissions: ['profit_report:read' as Permission],
};

// This month and last month first (owner 2026-11-15), then the other presets.
const PNL_RANGES: readonly ProfitRange[] = [
  'month',
  'last_month',
  'today',
  'yesterday',
  '7d',
  '30d',
  'all',
  'custom',
];

// The P&L report (spec plans/pnl-report/SPEC.md): sections in the owner's
// order. Real customers by default; the switch shows every account.
const PnlPage = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<ProfitRange>('month');
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const [scope, setScope] = useScopeParam();
  const report = usePnlReport(range, from, to, scope);
  const data = report.data;

  return (
    <div className="pc-dashboard flex flex-col gap-y-3">
      <Container className="pc-settle flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Heading level="h1">{t('pnl.title')}</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              {!data
                ? '…'
                : data.window
                  ? t('pnl.subtitle', { window: dayRangeText(data.window) })
                  : t('pnl.subtitleAll')}
            </Text>
          </div>
          <ScopeSwitch scope={scope} onScope={setScope} />
        </div>
        <RangePicker
          range={range}
          onRange={setRange}
          ranges={PNL_RANGES}
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
        <div
          className={`flex flex-col gap-y-3 transition-opacity ${
            report.isPlaceholderData ? 'opacity-50' : ''
          }`}
          aria-busy={report.isPlaceholderData}
        >
          <PackSalesCard data={data.pack_sales} />
          <CogsCard data={data.cogs} />
          <MarketingCard data={data.marketing} />
          <CoinFlipCard data={data.coin_flip} />
          <LuckyDrawCard data={data.lucky_draw} />
          <ShippingCard data={data.shipping} />
          <TotalsCard data={data.totals} />
          <AssetsCard data={data.assets} />
          <FloatingMoneyCard data={data.floating} />
        </div>
      )}
    </div>
  );
};

export default PnlPage;
