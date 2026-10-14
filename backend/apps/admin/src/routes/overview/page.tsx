import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import { House } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import type { StatsRange } from '../../lib/admin-rest';
import { useStats } from '../../lib/queries';
import { RangePicker } from './RangePicker';
import { isForbidden, todayMyt, windowText } from './helpers';
import { MoneyFlowCard } from './MoneyFlowCard';
import { AttentionCard } from './AttentionCard';
import { KpiTiles } from './KpiTiles';
import { ReferralCard } from './ReferralCard';
import { LatestPaymentsCard } from './LatestPaymentsCard';
import { SectionError } from './SectionState';

// The admin's home page (docs/superpowers/specs/2026-10-14-admin-redesign-
// design.md §7). Login and `/` reach it through the /orders redirect. Every
// figure comes from an existing endpoint; the economy report and the live
// gateway balance are deliberately not loaded here (slow / live gateway call).
export const config: RouteConfig = {
  label: 'pcNav.dashboard',
  translationNs: 'translation',
  icon: House,
  rank: 0,
};

const OverviewPage = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatsRange>('30d');
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const custom = range === 'custom';
  const stats = useStats(range, custom ? from : '', custom ? to : '');
  const statsHidden = stats.isError && isForbidden(stats.error);

  return (
    <div className="pc-dashboard flex flex-col gap-y-3">
      <Container className="pc-settle flex flex-col gap-3">
        <div>
          <Heading level="h1">{t('dashboard.title')}</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('dashboard.subtitle', {
              window: stats.data ? windowText(stats.data.current) : '…',
            })}
          </Text>
        </div>
        <RangePicker
          range={range}
          onRange={setRange}
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
        />
        {stats.isError && !statsHidden && (
          <SectionError onRetry={() => void stats.refetch()} />
        )}
      </Container>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {!statsHidden && (
          <MoneyFlowCard stats={stats.data} className="xl:col-span-2" />
        )}
        <AttentionCard className={statsHidden ? 'xl:col-span-3' : ''} />
      </div>

      {!statsHidden && <KpiTiles report={stats.data} />}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <ReferralCard className="xl:col-span-5" />
        <LatestPaymentsCard className="xl:col-span-7" />
      </div>
    </div>
  );
};

export default OverviewPage;
