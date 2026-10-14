import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Drawer,
  Input,
  RadioGroup,
  Text,
  usePrompt,
} from '@medusajs/ui';
import { usePaymentGateway, useSavePaymentGateway } from '../../lib/queries';
import { gatewayPreflightRefusal } from '../../lib/admin-rest';
import type { PaymentGatewayId } from '../../lib/admin-rest';

type GatewaySave = ReturnType<typeof useSavePaymentGateway>;

/** "Switch gateway…" — the active RM gateway (plan 130 §runtime switch), in a
 *  side panel opened by `children` (its trigger, so focus returns there on
 *  close): rarely used, and switching mid-day moves real money. The save
 *  lives here and the panel can't close while it runs, so the "Switch
 *  anyway" answer to a refused live check is never lost. */
export const GatewaySwitchDrawer = ({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactElement;
}) => {
  const { t } = useTranslation();
  const saveGateway = useSavePaymentGateway();
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (next || !saveGateway.isPending) onOpenChange(next);
      }}
    >
      <Drawer.Trigger asChild>{children}</Drawer.Trigger>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{t('settlement.gatewayTitle')}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="overflow-y-auto">
          <GatewaySwitch
            saveGateway={saveGateway}
            onDone={() => onOpenChange(false)}
          />
        </Drawer.Body>
      </Drawer.Content>
    </Drawer>
  );
};

const GatewaySwitch = ({
  saveGateway,
  onDone,
}: {
  saveGateway: GatewaySave;
  onDone: () => void;
}) => {
  const { t } = useTranslation();
  const gateway = usePaymentGateway();
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
      onDone();
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
    <div className="flex flex-col gap-4">
      {gateway.data?.setting === null ? (
        <Text size="small" className="text-ui-fg-subtle">
          {t('settlement.gatewayEnvDefault')}
        </Text>
      ) : null}
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
            className="flex flex-col gap-3"
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
                  <Text size="small" className="text-ui-fg-subtle">
                    {t('settlement.gatewayNotConfigured')}
                  </Text>
                ) : null}
              </label>
            ))}
          </RadioGroup>
          {gatewayDirty ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-y-1">
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
                className="self-end"
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
