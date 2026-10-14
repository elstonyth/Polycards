import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Container, Heading, Text } from '@medusajs/ui';
import { useGatewayAudit, useGatewayBalance } from '../../lib/queries';
import { inCurrency, LEDGER_CURRENCY, rm } from '../../lib/format';
import { Hint } from '../../components/Hint';
import { GatewaySwitchDrawer } from './GatewaySwitchDrawer';

// The top of every currency tab, in one strip: which gateway moves this
// currency and whether it is open, its live wallet (the payout float that
// says whether a refused payout was an empty wallet), and whether the hourly
// audit agrees with our rows. The wallet is its own endpoint (a live upstream
// call, 20s worst case), so a gateway outage degrades this strip and never
// the report below it.

const Tile = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <div className="bg-ui-bg-subtle flex min-w-0 flex-col gap-1 px-6 py-4">
    <div className="flex items-center gap-1.5">
      <Text size="small" className="text-ui-fg-subtle">
        {label}
      </Text>
      {hint && <Hint text={hint} />}
    </div>
    {children}
  </div>
);

export const GatewayStrip = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const balance = useGatewayBalance(currency);
  const audit = useGatewayAudit(currency);
  const [switching, setSwitching] = useState(false);
  const b = balance.data;

  // Three degraded states, each distinct: gateway off here (enabled:false),
  // gateway unreachable (200 + error, no balance), and OUR endpoint failing
  // (isError — expired session, network). Without the last one the tiles pin
  // at '…' forever, indistinguishable from loading.
  const status = balance.isError
    ? { color: 'red' as const, text: t('settlement.railUnknown') }
    : !b
      ? null
      : !b.enabled
        ? { color: 'grey' as const, text: t('settlement.railOff') }
        : !b.balance
          ? { color: 'red' as const, text: t('settlement.railUnreachable') }
          : { color: 'green' as const, text: t('settlement.railOpen') };

  const walletCurrency = b?.balance?.currency_code ?? currency;
  // TGPay keeps two wallets (pay-in, payout) and reports no T+1, so its
  // tiles are named for the wallets; A3Pay has one wallet and a T+1 figure.
  const wallets: (readonly [string, number | null | undefined])[] = b?.balance
    ?.separate_wallets
    ? [
        ['balancePayoutWallet', b.balance.available],
        ['balancePayinWallet', b.balance.current],
      ]
    : [
        ['balanceAvailable', b?.balance?.available],
        ['balanceCurrent', b?.balance?.current],
        ['balanceT1', b?.balance?.t1],
      ];
  const showWallets =
    !balance.isError && b?.enabled !== false && b?.balance !== null;

  const a = audit.data;
  const check = audit.isError
    ? { color: 'red' as const, text: t('settlement.auditLoadError') }
    : !a
      ? null
      : a.findings_total > 0
        ? {
            color: 'orange' as const,
            text: t('settlement.checkDiffers', { count: a.findings_total }),
          }
        : a.last_audited_at
          ? { color: 'green' as const, text: t('settlement.checkAllMatch') }
          : { color: 'grey' as const, text: t('settlement.checkNever') };
  const history = (a?.history ?? []).map((h) =>
    t('settlement.auditHistory', {
      gateway: h.gateway,
      deposits: h.deposits.count,
      depositsGross: rm(h.deposits.gross),
      withdrawals: h.withdrawals.count,
      withdrawalsGross: rm(h.withdrawals.gross),
    }),
  );

  const tiles = 2 + (showWallets ? wallets.length : 0);
  const cols =
    tiles >= 5
      ? 'lg:grid-cols-5'
      : tiles === 4
        ? 'lg:grid-cols-4'
        : 'lg:grid-cols-2';

  return (
    <Container className="p-0" data-testid={`rail-card-${currency}`}>
      <div
        className={`bg-ui-border-base grid grid-cols-1 gap-px sm:grid-cols-2 ${cols}`}
      >
        <Tile label={t('settlement.gatewayLabel')}>
          <div className="flex flex-wrap items-center gap-2">
            <Heading level="h2">{b?.label ?? '…'}</Heading>
            {status ? (
              <Badge size="2xsmall" color={status.color}>
                {status.text}
              </Badge>
            ) : null}
          </div>
          {/* Only RM has a choice of gateway; a regional rail runs beside it. */}
          {currency === LEDGER_CURRENCY ? (
            <Button
              variant="transparent"
              size="small"
              className="text-ui-fg-interactive -ml-2 self-start"
              onClick={() => setSwitching(true)}
            >
              {t('settlement.switchGateway')}
            </Button>
          ) : null}
        </Tile>

        {showWallets
          ? wallets.map(([key, value]) => (
              <Tile
                key={key}
                label={t(`settlement.${key}`)}
                hint={t(`settlement.${key}Hint`)}
              >
                <Heading level="h2" className="tabular-nums">
                  {value == null ? '…' : inCurrency(value, walletCurrency)}
                </Heading>
              </Tile>
            ))
          : null}

        <Tile
          label={t('settlement.gatewayCheck')}
          hint={[t('settlement.checkHint'), ...history].join(' ')}
        >
          {check ? (
            <Badge size="small" color={check.color} className="self-start">
              {check.text}
            </Badge>
          ) : (
            <Text size="small" className="text-ui-fg-muted">
              …
            </Text>
          )}
          {a?.last_audited_at ? (
            <Text size="xsmall" className="text-ui-fg-muted">
              {t('settlement.checkedAt', {
                when: new Date(a.last_audited_at).toLocaleString('en-MY'),
              })}
            </Text>
          ) : null}
        </Tile>
      </div>

      {balance.isError ? (
        <Text size="small" className="text-ui-fg-error border-t px-6 py-3">
          {t('settlement.balanceError', {
            message: t('settlement.balanceFetchFailed'),
          })}
        </Text>
      ) : b && !b.enabled ? (
        <Text size="small" className="text-ui-fg-subtle border-t px-6 py-3">
          {t('settlement.balanceDisabled')}
        </Text>
      ) : null}
      {b?.error ? (
        <Text size="small" className="text-ui-fg-error border-t px-6 py-3">
          {t('settlement.balanceError', { message: b.error })}
        </Text>
      ) : null}
      {b?.warning ? (
        <Text size="small" className="text-ui-fg-subtle border-t px-6 py-3">
          {t('settlement.balanceWarning', { message: b.warning })}
        </Text>
      ) : null}

      {currency === LEDGER_CURRENCY ? (
        <GatewaySwitchDrawer open={switching} onOpenChange={setSwitching} />
      ) : null}
    </Container>
  );
};
