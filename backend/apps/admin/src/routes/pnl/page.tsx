import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Container, Heading, Text, toast } from '@medusajs/ui';
import { Spinner } from '@medusajs/icons';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import { exportPnlXlsx, type ProfitRange } from '../../lib/admin-rest';
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
import { CheckMenu } from './ViewMenu';
import { useStoredSet } from './view-prefs';

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
  const [hiddenSections, toggleSection] = useStoredSet('pnl.hiddenSections');
  const [exporting, setExporting] = useState(false);
  // Same query as the page, so the backend answers from the cached report.
  const runExport = () => {
    setExporting(true);
    exportPnlXlsx(range, from, to, scope)
      .catch(() => toast.error(t('pnl.exportFailed')))
      .finally(() => setExporting(false));
  };
  const sections: { id: string; label: string; card: ReactNode }[] = data
    ? [
        {
          id: 'packSales',
          label: t('pnl.packSales.title'),
          card: <PackSalesCard data={data.pack_sales} />,
        },
        {
          id: 'cogs',
          label: t('pnl.cogs.title'),
          card: <CogsCard data={data.cogs} />,
        },
        {
          id: 'marketing',
          label: t('pnl.marketing.title'),
          card: <MarketingCard data={data.marketing} />,
        },
        {
          id: 'coinFlip',
          label: t('pnl.coinFlip.title'),
          card: <CoinFlipCard data={data.coin_flip} />,
        },
        {
          id: 'luckyDraw',
          label: t('pnl.luckyDraw.title'),
          card: <LuckyDrawCard data={data.lucky_draw} />,
        },
        {
          id: 'shipping',
          label: t('pnl.shipping.title'),
          card: <ShippingCard data={data.shipping} />,
        },
        {
          id: 'totals',
          label: t('pnl.totals.title'),
          card: <TotalsCard data={data.totals} />,
        },
        {
          id: 'assets',
          label: t('pnl.assets.title'),
          card: <AssetsCard data={data.assets} />,
        },
        {
          id: 'floating',
          label: t('pnl.floating.title'),
          card: <FloatingMoneyCard data={data.floating} />,
        },
      ]
    : [];
  // A period not in the cache takes ~20 s to work out (about 40 statements,
  // one at a time); say so instead of leaving old figures greyed out silently.
  const slow = report.isFetching && (!data || report.isPlaceholderData);
  // A closed period (it ended before its figures were worked out) is kept 6
  // hours; say when they were worked out.
  const keptSince =
    data?.window && Date.parse(data.window.to) < Date.parse(data.as_of)
      ? new Date(data.as_of).toLocaleString('en-GB', {
          timeZone: 'Asia/Kuala_Lumpur',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;

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
            {keptSince && (
              <Text size="small" className="text-ui-fg-muted mt-1">
                {t('pnl.keptSince', { time: keptSince })}
              </Text>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ScopeSwitch scope={scope} onScope={setScope} />
            {sections.length > 0 && (
              <CheckMenu
                label={t('pnl.view.sections')}
                options={sections}
                hidden={hiddenSections}
                onToggle={toggleSection}
              />
            )}
            <Button
              variant="secondary"
              size="small"
              onClick={runExport}
              isLoading={exporting}
              disabled={!data || report.isPlaceholderData || exporting}
            >
              {t('pnl.export')}
            </Button>
          </div>
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
        {slow && (
          <Text
            size="small"
            className="text-ui-fg-subtle flex items-center gap-2"
            role="status"
          >
            <Spinner className="animate-spin" />
            {t('pnl.loading')}
          </Text>
        )}
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
          {sections
            .filter((s) => !hiddenSections.has(s.id))
            .map((s) => (
              <Fragment key={s.id}>{s.card}</Fragment>
            ))}
        </div>
      )}
    </div>
  );
};

export default PnlPage;
