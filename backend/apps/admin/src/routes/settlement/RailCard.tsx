import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  RadioGroup,
  Text,
  usePrompt,
} from '@medusajs/ui';
import {
  useGatewayBalance,
  usePaymentGateway,
  useSavePaymentGateway,
} from '../../lib/queries';
import { gatewayPreflightRefusal } from '../../lib/admin-rest';
import type { PaymentGatewayId } from '../../lib/admin-rest';
import { inCurrency } from '../../lib/format';

// The top of every currency tab: which gateway moves this currency, whether
// it is open, and its live wallet — the payout float that says whether a
// refused payout was an empty wallet before support gets involved. The
// wallet is its own endpoint (a live upstream call, 20s worst case), so a
// gateway outage degrades this card and never the report below it.

export const RailCard = ({ currency }: { currency: string }) => {
  const { t } = useTranslation();
  const balance = useGatewayBalance(currency);
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
  return (
    <Container className="p-0" data-testid={`rail-card-${currency}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
        <div>
          <Heading level="h2">{b?.label ?? '…'}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {currency === 'MYR'
              ? t('settlement.railSubtitleLedger')
              : t('settlement.railSubtitleRegional', { currency })}
          </Text>
        </div>
        {status ? (
          <Badge size="small" color={status.color}>
            {status.text}
          </Badge>
        ) : null}
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
      ) : (
        <>
          {b?.balance !== null ? (
            <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base sm:grid-cols-3">
              {(
                [
                  ['balanceAvailable', b?.balance?.available],
                  ['balanceCurrent', b?.balance?.current],
                  ['balanceT1', b?.balance?.t1],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="bg-ui-bg-subtle px-6 py-3">
                  <Text size="small" className="text-ui-fg-subtle">
                    {t(`settlement.${key}`)}
                  </Text>
                  <Heading level="h2" className="mt-0.5 tabular-nums">
                    {value === undefined
                      ? '…'
                      : inCurrency(value, walletCurrency)}
                  </Heading>
                  <Text size="xsmall" className="text-ui-fg-muted">
                    {t(`settlement.${key}Hint`)}
                  </Text>
                </div>
              ))}
            </div>
          ) : null}
          {b?.error ? (
            <Text size="small" className="text-ui-fg-error border-t px-6 py-3">
              {t('settlement.balanceError', { message: b.error })}
            </Text>
          ) : null}
        </>
      )}

      {/* Only RM has a choice of gateway; a regional rail runs beside it. */}
      {currency === 'MYR' ? <GatewaySwitch /> : null}
    </Container>
  );
};

// The active RM gateway (plan 130 §runtime switch).
const GatewaySwitch = () => {
  const { t } = useTranslation();
  const gateway = usePaymentGateway();
  const saveGateway = useSavePaymentGateway();
  const prompt = usePrompt();
  const [chosen, setChosen] = useState<PaymentGatewayId | null>(null);
  const [gatewayReason, setGatewayReason] = useState('');
  const activeGateway = gateway.data?.active ?? null;
  const wantedGateway = chosen ?? activeGateway;
  const gatewayDirty =
    wantedGateway !== null && wantedGateway !== activeGateway;
  const canSwitch =
    gatewayDirty && !saveGateway.isPending && gatewayReason.trim().length > 0;
  const switchGateway = async () => {
    if (!canSwitch || !wantedGateway) return;
    const label =
      gateway.data?.gateways.find((g) => g.id === wantedGateway)?.label ??
      wantedGateway;
    const confirmed = await prompt({
      title: t('settlement.gatewayTitle'),
      description: t('settlement.gatewayConfirm', { label }),
      confirmText: t('settlement.gatewaySave'),
    });
    if (!confirmed) return;
    const done = () => {
      setChosen(null);
      setGatewayReason('');
    };
    const input = { gateway: wantedGateway, reason: gatewayReason.trim() };
    saveGateway.mutate(input, {
      onSuccess: done,
      // The backend tests the gateway live before switching. When it will not
      // serve us (keys, IP whitelist, callback allowlist), show why and let
      // the operator switch anyway — never get stuck in an emergency.
      onError: async (error) => {
        const refusal = gatewayPreflightRefusal(error);
        if (!refusal) return;
        const force = await prompt({
          title: t('settlement.gatewayPreflightTitle', { label }),
          description: [
            // The dialog renders plain text (no line breaks), so each problem
            // gets its own full stop before the warning.
            ...refusal.problems.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)),
            t('settlement.gatewayPreflightForceHint'),
          ].join(' '),
          confirmText: t('settlement.gatewayPreflightForce'),
          variant: 'danger',
        });
        if (force) {
          saveGateway.mutate({ ...input, force: true }, { onSuccess: done });
        }
      },
    });
  };

  return (
    <div className="flex flex-col gap-3 border-t px-6 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Text size="small" weight="plus">
          {t('settlement.gatewayTitle')}
        </Text>
        {gateway.data?.setting === null ? (
          <Text size="small" className="text-ui-fg-muted">
            ({t('settlement.gatewayEnvDefault')})
          </Text>
        ) : null}
      </div>
      {gateway.isError ? (
        <Text size="small" className="text-ui-fg-error">
          {t('settlement.gatewayLoadError')}
        </Text>
      ) : !gateway.data ? null : (
        <>
          <Text size="small" className="text-ui-fg-subtle">
            {t('settlement.gatewaySubtitle')}
          </Text>
          <RadioGroup
            value={wantedGateway ?? undefined}
            onValueChange={(value) => setChosen(value as PaymentGatewayId)}
            className="flex flex-wrap gap-x-6 gap-y-2"
          >
            {gateway.data.gateways.map((g) => (
              <label
                key={g.id}
                className="flex items-center gap-2"
                htmlFor={`gateway-${g.id}`}
              >
                <RadioGroup.Item
                  id={`gateway-${g.id}`}
                  value={g.id}
                  disabled={!g.configured}
                />
                <Text size="small" weight="plus">
                  {g.label}
                </Text>
                {g.id === activeGateway ? (
                  <Badge size="2xsmall" color="blue">
                    {t('settlement.gatewayActiveShort')}
                  </Badge>
                ) : !g.configured ? (
                  <Text size="small" className="text-ui-fg-muted">
                    {t('settlement.gatewayNotConfigured')}
                  </Text>
                ) : null}
              </label>
            ))}
          </RadioGroup>
          {gatewayDirty ? (
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex min-w-64 flex-1 flex-col gap-y-1">
                <Text size="small" weight="plus">
                  {t('settlement.gatewayReason')}
                </Text>
                <Input
                  value={gatewayReason}
                  onChange={(e) => setGatewayReason(e.target.value)}
                  placeholder={t('settlement.gatewayReasonPlaceholder')}
                />
              </div>
              <Button
                onClick={switchGateway}
                isLoading={saveGateway.isPending}
                disabled={!canSwitch}
              >
                {t('settlement.gatewaySave')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
