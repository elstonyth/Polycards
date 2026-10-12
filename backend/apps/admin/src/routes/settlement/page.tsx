import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Container, Heading, Tabs, Text } from '@medusajs/ui';
import { Receipt } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { usePaymentGateway } from '../../lib/queries';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { RailCard } from './RailCard';
import { RegionalFxCard } from './RegionalFxCard';
import { ReportCard } from './ReportCard';
import { AuditCard } from './AuditCard';

// Settlement — one tab per currency the site takes money in (RM, then each
// regional rail: SGD today, USDT when it ships). Every tab reads the same way,
// top to bottom: the gateway and its live wallet, the exchange rate (regional
// rails only), the weekly/monthly result from this database, and the audit of
// our rows against the gateway. The tab is in the URL (?currency=SGD), so each
// currency is a page an operator can link to.
//
// The tab list comes from the backend's gateway registry, so a new rail gets
// its tab without a change here.
export const config: RouteConfig = {
  label: 'Settlement',
  icon: Receipt,
  // After the Economy (30) / Ledger (31) money-reporting cluster. NOT 32 —
  // Daily rewards already holds that and a collision leaves the order
  // tie-break-dependent; 34 sits after Weekly Challenge (33) in a slot
  // nothing owns.
  rank: 34,
};

const LEDGER_CURRENCY = 'MYR';

const SettlementPage = () => {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const gateway = usePaymentGateway();
  // Until the registry answers, RM is the one tab that always exists.
  const currencies = gateway.data?.currencies ?? [LEDGER_CURRENCY];
  const asked = params.get('currency')?.toUpperCase();
  const currency =
    asked && currencies.includes(asked) ? asked : LEDGER_CURRENCY;
  const waiting = !gateway.data && !gateway.isError && asked !== undefined;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="p-0">
        <div className="px-6 pt-4 pb-3">
          <Heading level="h1">{t('settlement.title')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('settlement.subtitle')}
          </Text>
        </div>
        <div className="border-t px-6 py-3">
          <Tabs
            value={currency}
            onValueChange={(next) => setParams({ currency: next })}
          >
            <Tabs.List aria-label={t('settlement.tabsLabel')}>
              {currencies.map((c) => (
                <Tabs.Trigger key={c} value={c}>
                  {t(`settlement.rail.${c}`, { defaultValue: c })}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {waiting ? (
        <Container className="px-6 py-8">
          <LoadingSkeleton />
        </Container>
      ) : (
        // Keyed: a tab switch starts every card fresh, never with the other
        // currency's form state.
        <div key={currency} className="flex flex-col gap-y-3">
          <RailCard currency={currency} />
          {currency !== LEDGER_CURRENCY ? (
            <RegionalFxCard currency={currency} />
          ) : null}
          <ReportCard currency={currency} />
          <AuditCard currency={currency} />
        </div>
      )}
    </div>
  );
};

export default SettlementPage;
