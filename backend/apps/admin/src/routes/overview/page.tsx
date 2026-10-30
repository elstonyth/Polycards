import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Heading, Text } from '@medusajs/ui';
import { House } from '@medusajs/icons';
import type { Permission, RouteConfig } from '@mercurjs/dashboard-sdk';
import type { StatsRange } from '../../lib/admin-rest';
import { useStats } from '../../lib/queries';
import { useScopeParam } from '../../lib/scope-param';
import { ScopeSwitch } from '../economy/ScopeSwitch';
import { RangePicker } from './RangePicker';
import {
  isForbidden,
  savedRange,
  saveRange,
  todayMyt,
  windowText,
} from './helpers';
import { MoneyFlowCard } from './MoneyFlowCard';
import { AttentionCard } from './AttentionCard';
import { KpiTiles } from './KpiTiles';
import { ReferralCard } from './ReferralCard';
import { LatestPaymentsCard } from './LatestPaymentsCard';
import { SectionError } from './SectionState';
import { LiveBadge } from './LiveBadge';
import { OnlineNow } from './OnlineNow';
import { useLiveRefresh } from './use-live-refresh';

// The admin's home page (docs/superpowers/specs/2026-10-14-admin-redesign-
// design.md §7). Login and `/` reach it through the /orders redirect. Every
// figure comes from an existing endpoint; the economy report and the live
// gateway balance are deliberately not loaded here (slow / live gateway call).
export const config: RouteConfig = {
  label: 'pcNav.dashboard',
  translationNs: 'translation',
  icon: House,
  rank: 0,
  permissions: ['stats:read' as Permission],
};

// Login lands here (via /orders). A role without the dashboard's figures goes
// to the Players page instead — the Support viewer's home; the automation
// operator, without Players either, is passed on from there to Automation.
export const handle = { permissions: 'stats:read', redirectTo: '/players' };

const OverviewPage = () => {
  const { t } = useTranslation();
  const [range, setRange] = useState<StatsRange>(savedRange);
  const [from, setFrom] = useState(todayMyt);
  const [to, setTo] = useState(todayMyt);
  const custom = range === 'custom';
  // Real customers by default (spec 2026-10-14-admin-finance-pages §5): the
  // tiles and the money chart follow the switch; work queues never do.
  const [scope, setScope] = useScopeParam();
  const stats = useStats(range, custom ? from : '', custom ? to : '', scope);
  const statsHidden = stats.isError && isForbidden(stats.error);
  const statsFailed = stats.isError && !statsHidden;
  // Live: refreshes every section every 30s while this tab is visible.
  useLiveRefresh();

  return (
    <div className="pc-dashboard flex flex-col gap-y-3">
      <Container className="pc-settle flex flex-col gap-3">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Heading level="h1">{t('dashboard.title')}</Heading>
            <div className="flex flex-wrap items-center gap-4">
              <ScopeSwitch
                scope={scope}
                onScope={setScope}
                hint={t('dashboard.scopeHint')}
              />
              <OnlineNow scope={scope} />
              <LiveBadge updatedAt={stats.dataUpdatedAt} />
            </div>
          </div>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            {t('dashboard.subtitle', {
              window: stats.data ? windowText(stats.data.current) : '…',
            })}
          </Text>
        </div>
        <RangePicker
          range={range}
          onRange={(r) => {
            setRange(r);
            saveRange(r);
          }}
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
        />
        {statsFailed && <SectionError onRetry={() => void stats.refetch()} />}
      </Container>

      <div className="flex flex-col gap-y-3">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          {!statsHidden && (
            <MoneyFlowCard
              scope={scope}
              stats={stats.data}
              statsStale={stats.isPlaceholderData}
              statsFailed={statsFailed}
              className="xl:col-span-2"
            />
          )}
          {/* The work queue ignores the switch and the period: never dimmed. */}
          <AttentionCard className={statsHidden ? 'xl:col-span-3' : ''} />
        </div>

        {/* Dimmed while a new scope or period loads (the old numbers stay). */}
        {!statsHidden && (
          <div
            className={`transition-opacity ${
              stats.isPlaceholderData ? 'opacity-50' : ''
            }`}
            aria-busy={stats.isPlaceholderData}
          >
            <KpiTiles report={stats.data} failed={statsFailed} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <ReferralCard className="xl:col-span-5" />
        <LatestPaymentsCard className="xl:col-span-7" />
      </div>
    </div>
  );
};

export default OverviewPage;
