import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Container,
  Copy,
  Heading,
  Input,
  Label,
  Select,
  StatusBadge,
  Table,
  Text,
  toast,
} from '@medusajs/ui';
import type { Permission } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import {
  useCustomerAudit,
  useCustomerDetail,
  useCustomerGatewayWithdrawals,
  useCustomerGroupsAdmin,
  useCustomerReferral,
  usePayoutDetails,
  useReferralSettings,
  useSavePayoutDetails,
  useSetCustomerPhone,
  useSetCustomerRealName,
  useSetCustomerReferrer,
  useSetPartnerRate,
  useSetPlayerGroup,
  type CustomerReferralCard,
} from '../../../lib/queries';
import { orderDateTime, rm } from '../../../lib/format';
import type { PayoutDetails } from '../../../lib/admin-rest';
import {
  effectiveOddsSet,
  isDefaultPlayerGroup,
} from '../../../lib/player-groups';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { FieldsDialog, TableState } from './bits';

// Card rule on this tab: every player's facts are readable by whoever may open
// the player at all; a control shows only to a role whose write will pass
// (customer:update, api/admin-rbac.ts), never as a button that 403s.
const useCanEdit = () =>
  usePermissions().hasPermission('customer:update' as Permission);

const BankForm = ({
  customerId,
  seed,
  readOnly,
}: {
  customerId: string;
  seed: PayoutDetails | null;
  readOnly: boolean;
}) => {
  const { t } = useTranslation();
  const save = useSavePayoutDetails();
  const [bankName, setBankName] = useState(seed?.bank_name ?? '');
  const [account, setAccount] = useState(seed?.bank_account_number ?? '');
  const [holder, setHolder] = useState(seed?.account_holder_name ?? '');

  // Compared TRIMMED against what the server holds, because submit trims too:
  // after a save the draft and the refreshed seed agree and Save re-disables
  // itself instead of offering to write the same row again.
  const unchanged =
    bankName.trim() === (seed?.bank_name ?? '') &&
    account.trim() === (seed?.bank_account_number ?? '') &&
    holder.trim() === (seed?.account_holder_name ?? '');

  // No toast here — useSavePayoutDetails already fires one on success and
  // another on error.
  const submit = () =>
    save.mutate({
      id: customerId,
      details: {
        bank_name: bankName.trim(),
        bank_account_number: account.trim(),
        // The column is nullable; '' would persist as an empty holder name.
        account_holder_name: holder.trim() || null,
      },
    });

  return (
    <div className="flex flex-col gap-4 border-t px-6 py-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="payout-bank-name" size="small">
            {t('players.bankName')}
          </Label>
          <Input
            id="payout-bank-name"
            value={bankName}
            disabled={readOnly}
            onChange={(e) => setBankName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="payout-bank-account" size="small">
            {t('players.bankAccount')}
          </Label>
          <Input
            id="payout-bank-account"
            value={account}
            disabled={readOnly}
            onChange={(e) => setAccount(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="payout-holder" size="small">
            {t('players.accountHolder')}
          </Label>
          <Input
            id="payout-holder"
            value={holder}
            disabled={readOnly}
            onChange={(e) => setHolder(e.target.value)}
          />
        </div>
      </div>
      {!readOnly && (
        <div>
          <Button
            size="small"
            onClick={submit}
            isLoading={save.isPending}
            disabled={unchanged || !bankName.trim() || !account.trim()}
          >
            {t('players.saveBank')}
          </Button>
        </div>
      )}
    </div>
  );
};

/** Saved bank details are optional: a player can type an account at the
 *  withdraw sheet without saving one. Says where the money last went, so an
 *  empty form never reads as "this player was never paid". */
const LastPayout = ({
  customerId,
  showEmpty,
}: {
  customerId: string;
  showEmpty: boolean;
}) => {
  const { t } = useTranslation();
  const { data } = useCustomerGatewayWithdrawals(customerId, 0);
  const last = data?.withdrawals[0];
  if (!last) {
    return showEmpty && data ? (
      <TableState empty={t('playerPayments.noWithdrawals')} />
    ) : null;
  }
  return (
    <div className="border-t px-6 py-3">
      <Text size="small" className="text-ui-fg-subtle">
        {t('playerDetail.lastPayout', {
          bank: last.bank_name ?? last.bank_code,
          account: last.account_number,
          holder: last.account_holder_name,
          date: orderDateTime(last.created_at),
        })}
      </Text>
    </div>
  );
};

/** Move a player between player groups. Exclusive by construction: the Select
 *  holds ONE group and the save posts to the repo-side route that clears the
 *  others, so the operator can never leave a player in two groups whose odds
 *  sets disagree. */
const GroupCard = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const permissions = usePermissions();
  // Moving needs the group list too. Without either, the card only names the
  // group, from the customer record every role here can read.
  const canMove =
    permissions.hasPermission('customer:update' as Permission) &&
    permissions.hasPermission('customer_group:read' as Permission);
  const { data: detail, isError: detailError } = useCustomerDetail(customerId);
  const { data: groupList, isError: groupsError } = useCustomerGroupsAdmin({
    enabled: canMove,
  });
  // BOTH error flags: the render below falls back to a skeleton on
  // `!groupList || !detail`, so a failed customer-detail request with a healthy
  // group list would sit on that skeleton forever instead of ever reaching the
  // error message.
  const isError = detailError || (canMove && groupsError);
  const move = useSetPlayerGroup(customerId);
  // Unsaved pick only — undefined re-reads the server value every render, so
  // the post-save refetch is what the Select shows (same rule as the Player
  // Groups page's odds-set column).
  const [picked, setPicked] = useState<string | undefined>();

  const groups = groupList?.customer_groups ?? [];
  // Membership is exclusive on every surface we own, so this is normally the
  // player's only group. The non-DEFAULT preference matches
  // resolveOddsSetForCustomer EXACTLY: a player put in two groups by the
  // prebuilt /customer-groups screen rolls their real group's odds, and this
  // card must name the same one — showing "DEFAULT — Odds set 1" while the spin
  // rolls set 2 would be a lie the operator acts on. Saving collapses the
  // duplicates back to one.
  const memberships = detail?.customer.groups ?? [];
  const member =
    memberships.find((g) => !isDefaultPlayerGroup(g)) ?? memberships[0];
  const current = member?.id ?? '';
  // A player in NO group rolls set 1 — bit-for-bit what the DEFAULT group's
  // members roll (resolveOddsSetForCustomer returns 1 for both) — so the card
  // names DEFAULT instead of reading as an unset field the operator has to
  // interpret. Not cosmetic-only: `current` stays the real membership, so this
  // shows as an unsaved change and Save persists it in one click. That is the
  // whole repair path when the fail-soft subscriber missed someone or the row
  // predates it (see scripts/backfill-default-group.ts).
  const defaultGroupId = groups.find(isDefaultPlayerGroup)?.id ?? '';
  const value = (picked ?? current) || defaultGroupId;
  // `duplicated` keeps Save live when the player holds MORE than one
  // membership, even with nothing picked. That state is the one this card
  // exists to repair — the prebuilt /customer-groups screen is what creates it
  // — and gating purely on `dirty` disabled the button precisely then, so the
  // only way out was to move the player somewhere else and back. Pressing Save
  // as-is collapses them onto the group already shown, which is the group the
  // draw path is already using.
  const duplicated = memberships.length > 1;
  const dirty = value !== current;

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('players.groupTitle')}</Heading>
        <Text className="text-ui-fg-subtle mt-1" size="small">
          {t('players.groupSubtitle')}
        </Text>
      </div>
      {isError ? (
        <div className="border-t px-6 py-6">
          <Text size="small" className="text-ui-fg-error">
            {t('players.groupLoadError')}
          </Text>
        </div>
      ) : !detail || (canMove && !groupList) ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : !canMove ? (
        <div className="border-t px-6 py-4">
          <Text size="small">
            {member
              ? `${member.name} — ${t('players.groupOddsSet', { n: effectiveOddsSet(member) })}`
              : `DEFAULT — ${t('players.groupOddsSet', { n: 1 })}`}
          </Text>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3 border-t px-6 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="player-group" size="small">
              {t('players.groupLabel')}
            </Label>
            <Select value={value} onValueChange={setPicked}>
              <Select.Trigger id="player-group" className="w-64">
                {/* Only reachable when the shop has no DEFAULT row at all —
                    a group-less player otherwise shows DEFAULT (see
                    `defaultGroupId` above). A blank trigger reads as a loading
                    bug rather than a real state. */}
                <Select.Value placeholder={t('players.groupNone')} />
              </Select.Trigger>
              <Select.Content>
                {groups.map((g) => (
                  <Select.Item key={g.id} value={g.id}>
                    {/* effectiveOddsSet, not the raw metadata: the default
                        group always rolls set 1, whatever its row stores. */}
                    {g.name} —{' '}
                    {t('players.groupOddsSet', { n: effectiveOddsSet(g) })}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <Button
            size="small"
            onClick={() =>
              move.mutate(value || null, {
                onSuccess: () => setPicked(undefined),
              })
            }
            isLoading={move.isPending}
            disabled={!dirty && !duplicated}
          >
            {t('players.groupSave')}
          </Button>
          {duplicated ? (
            <Text size="small" className="text-ui-fg-subtle pb-2">
              {t('players.groupDuplicated', { count: memberships.length })}
            </Text>
          ) : (
            // Says out loud that the DEFAULT on screen is the odds this player
            // already rolls but is not yet a stored membership — otherwise a
            // live Save button next to an apparently-correct value looks broken.
            memberships.length === 0 && (
              <Text size="small" className="text-ui-fg-subtle pb-2">
                {t('players.groupUnassigned')}
              </Text>
            )
          )}
        </div>
      )}
    </Container>
  );
};

// When this week's line pays: auto-approval holds a whole run with any line
// over its limit for an admin, and the close voids a line over the ceiling.
// Never promise Wednesday when one of those applies.
const payoutNote = (
  projectedCents: number,
  limits: CustomerReferralCard['payout_limits'],
): string =>
  projectedCents <= 0
    ? 'Nothing to pay yet.'
    : projectedCents > limits.line_ceiling_cents
      ? `Over the ${rm(limits.line_ceiling_cents / 100)} line ceiling — the close voids it for review, so it will not pay as is.`
      : projectedCents > limits.auto_approve_max_cents
        ? `Over ${rm(limits.auto_approve_max_cents / 100)} — an admin must approve the week on the Referrals page before it pays.`
        : 'Usually paid the Wednesday after it closes; a week holding any line over the auto-approve limit waits for an admin.';

// Referral card (rebuild, spec 2026-08-24): who referred them, their direct
// downline, their weekly payout lines, and the partner-rate control. The rate
// REPLACES the tier table for this customer; bounds come from the Referrals
// page settings and are re-enforced server-side.
const ReferralCard = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const { data, isError } = useCustomerReferral(customerId);

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('playerDetail.referralTitle')}</Heading>
      </div>
      {isError ? (
        <TableState isError />
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : (
        <ReferralCardBody customerId={customerId} data={data} />
      )}
    </Container>
  );
};

const ReferralCardBody = ({
  customerId,
  data,
}: {
  customerId: string;
  data: CustomerReferralCard;
}) => {
  const { t } = useTranslation();
  const canEdit = useCanEdit();
  const { data: settings } = useReferralSettings({ enabled: canEdit });
  const setRate = useSetPartnerRate();
  const setReferrer = useSetCustomerReferrer();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<
    'referrer' | 'rate' | 'clearRate' | null
  >(null);
  const reasonField = {
    key: 'reason',
    label: t('playerDetail.reasonAudited'),
  };

  const applyRate = (rateBp: number | null, reason: string) => {
    setDialog(null);
    setRate.mutate(
      { customerId, rateBp, reason },
      {
        onSuccess: () =>
          toast.success(
            rateBp === null
              ? t('playerDetail.rateCleared')
              : t('playerDetail.rateSet'),
          ),
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const boundsHint = settings
    ? `${settings.partner_min_bp / 100}–${settings.partner_max_bp / 100}%`
    : '';
  // Conflict rule (spec 2026-09-09): while the player is in a partner group
  // the group's rate pays them, and the server refuses a manual rate. Lock the
  // control here with the same message, rather than let the operator type a
  // value the Set button then rejects.
  const lockedByGroup = data.partner_group;
  // Which rule sets this week's rate — the order the close applies it in.
  const rateSource = lockedByGroup
    ? `Partner rate · group ${lockedByGroup.name}`
    : data.partner_referral_bp !== null
      ? 'Partner rate'
      : 'Tier rate';
  // shortcut: sums the last 50 lines the route returns (one per week, so all
  // history since the 29 Sep launch); move to a server total past 50 weeks.
  const paidCents = data.lines
    .filter((l) => l.status === 'paid')
    .reduce((sum, l) => sum + l.amount_cents, 0);

  return (
    <div className="border-t px-6 py-4">
      <dl className="grid grid-cols-[9rem_1fr] items-baseline gap-x-4 gap-y-2 text-sm break-words">
        <dt className="text-ui-fg-subtle">{t('playerDetail.referredBy')}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {data.referred_by ? (
            <button
              type="button"
              className="text-ui-fg-interactive text-left hover:underline"
              onClick={() => navigate(`/customers/${data.referred_by}`)}
            >
              {data.referred_by_label ?? data.referred_by}
            </button>
          ) : (
            <span>—</span>
          )}
          {canEdit && (
            <Button
              size="small"
              variant="secondary"
              disabled={setReferrer.isPending}
              onClick={() => setDialog('referrer')}
            >
              {t('playerDetail.change')}
            </Button>
          )}
        </dd>
        <dt className="text-ui-fg-subtle">
          {t('playerDetail.directReferrals')}
        </dt>
        {/* ?? and the week guard: during a rolling deploy an older API
            instance can answer without these fields. */}
        <dd>{data.downline_count ?? data.downline.length}</dd>
        {data.week && (
          <>
            <dt className="text-ui-fg-subtle">{t('playerDetail.thisWeek')}</dt>
            <dd>
              <div className="tabular-nums">
                {rm(data.week.turnover_cents / 100)} spend ×{' '}
                {data.week.rate_bp / 100}% ={' '}
                <span className="font-medium">
                  {rm(data.week.projected_cents / 100)}
                </span>
              </div>
              <Text size="xsmall" className="text-ui-fg-muted">
                {rateSource} · week of {data.week.start}, still open.{' '}
                {payoutNote(data.week.projected_cents, data.payout_limits)}
              </Text>
            </dd>
          </>
        )}
        <dt className="text-ui-fg-subtle">{t('playerDetail.totalPaid')}</dt>
        <dd className="tabular-nums">{rm(paidCents / 100)}</dd>
        <dt className="text-ui-fg-subtle">{t('playerDetail.partnerRate')}</dt>
        <dd>
          {lockedByGroup ? (
            <>
              <div className="flex items-center gap-2">
                <Badge size="small" color="purple">
                  {lockedByGroup.rate_bp / 100}% · {lockedByGroup.name}
                </Badge>
                {/* Clearing stays allowed while the group applies (the
                    server refuses only a NEW rate), so an inert per-customer
                    rate can be removed without a move out and back. */}
                {canEdit && data.partner_referral_bp !== null && (
                  <Button
                    size="small"
                    variant="transparent"
                    disabled={setRate.isPending}
                    onClick={() => setDialog('clearRate')}
                  >
                    {t('playerDetail.clear')}
                  </Button>
                )}
              </div>
              <Text size="xsmall" className="text-ui-fg-muted">
                {t('players.partnerLockedByGroup', {
                  group: lockedByGroup.name,
                })}
                {data.partner_referral_bp !== null &&
                  ` ${t('players.partnerManualShadowed', {
                    rate: data.partner_referral_bp / 100,
                  })}`}
              </Text>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="tabular-nums">
                  {data.partner_referral_bp === null
                    ? t('playerDetail.noPartnerRate')
                    : `${data.partner_referral_bp / 100}%`}
                </span>
                {canEdit && (
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={setRate.isPending}
                    onClick={() => setDialog('rate')}
                  >
                    {t('playerDetail.change')}
                  </Button>
                )}
                {canEdit && data.partner_referral_bp !== null && (
                  <Button
                    size="small"
                    variant="transparent"
                    disabled={setRate.isPending}
                    onClick={() => setDialog('clearRate')}
                  >
                    {t('playerDetail.clear')}
                  </Button>
                )}
              </div>
              {canEdit && boundsHint && (
                <Text size="xsmall" className="text-ui-fg-muted">
                  Allowed range {boundsHint} — replaces the tier table for this
                  customer.
                </Text>
              )}
            </>
          )}
        </dd>
      </dl>
      {data.downline.length > 0 && (
        <div className="mt-4">
          <Text size="small" className="text-ui-fg-subtle">
            Referrals
          </Text>
          <div className="mt-1 max-h-96 overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Player</Table.HeaderCell>
                  <Table.HeaderCell>Referred since</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    This week
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Lifetime
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.downline.map((d) => (
                  <Table.Row key={d.customer_id}>
                    <Table.Cell>
                      <button
                        type="button"
                        className="text-ui-fg-interactive text-left hover:underline"
                        onClick={() => navigate(`/customers/${d.customer_id}`)}
                      >
                        {d.name ?? d.email ?? d.customer_id}
                      </button>
                      {d.name && d.email && (
                        <div className="text-ui-fg-muted text-xs">
                          {d.email}
                        </div>
                      )}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-xs">
                      {orderDateTime(d.since)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(d.week_spend_cents / 100)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(d.lifetime_spend_cents / 100)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <Text size="xsmall" className="text-ui-fg-muted mt-2">
            Spend counts pack opens paid with real money, net of refunds. Opens
            paid with bonus credit earn no commission.
          </Text>
        </div>
      )}
      {data.lines.length > 0 && (
        <div className="mt-4">
          <Text size="small" className="text-ui-fg-subtle">
            Weekly payouts
          </Text>
          <div className="mt-1 max-h-96 overflow-y-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Week of</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Referral spend
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Rate
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Commission
                  </Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.lines.map((l) => (
                  <Table.Row key={l.id}>
                    <Table.Cell className="whitespace-nowrap tabular-nums">
                      {l.week_start ?? '—'}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(l.basis_cents / 100)}
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {l.rate_bp / 100}%
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(l.amount_cents / 100)}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge
                        color={
                          l.status === 'paid'
                            ? 'green'
                            : l.status === 'voided'
                              ? 'red'
                              : 'orange'
                        }
                      >
                        {l.status}
                      </StatusBadge>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </div>
      )}

      {dialog === 'referrer' && (
        <FieldsDialog
          title={t('playerDetail.referrerTitle')}
          fields={[
            {
              key: 'referrer',
              label: t('playerDetail.referrerId'),
              initial: data.referred_by ?? '',
              placeholder: 'cus_…',
              optional: true,
            },
            reasonField,
          ]}
          onClose={() => setDialog(null)}
          onSubmit={({ referrer, reason }) => {
            setDialog(null);
            setReferrer.mutate(
              { customerId, referrerId: referrer || null, reason },
              {
                onSuccess: () =>
                  toast.success(t('playerDetail.referrerUpdated')),
                onError: (e) => toast.error(e.message),
              },
            );
          }}
        />
      )}
      {dialog === 'rate' && (
        <FieldsDialog
          title={t('playerDetail.rateTitle')}
          description={
            boundsHint
              ? t('playerDetail.rateRange', { range: boundsHint })
              : undefined
          }
          fields={[
            {
              key: 'rate',
              label: t('playerDetail.ratePercent'),
              initial:
                data.partner_referral_bp === null
                  ? ''
                  : String(data.partner_referral_bp / 100),
              placeholder: boundsHint,
            },
            reasonField,
          ]}
          onClose={() => setDialog(null)}
          onSubmit={({ rate, reason }) => {
            const pct = Number(rate);
            if (!Number.isFinite(pct)) {
              toast.error(t('playerDetail.rateInvalid'));
              return;
            }
            applyRate(Math.round(pct * 100), reason);
          }}
        />
      )}
      {dialog === 'clearRate' && (
        <FieldsDialog
          title={t('playerDetail.rateClearTitle')}
          fields={[reasonField]}
          onClose={() => setDialog(null)}
          onSubmit={({ reason }) => applyRate(null, reason)}
        />
      )}
    </div>
  );
};

/**
 * Name, email, phone and the two identity facts the customer can no longer
 * change themselves (spec 2026-10-06) — staff match the real name against a
 * Touch 'n Go lookup of the phone, and these buttons are customer service's
 * way to correct either.
 */
const PlayerDetailsCard = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const canEdit = useCanEdit();
  const { data, isError } = useCustomerDetail(customerId);
  const { data: audit } = useCustomerAudit(customerId, 0);
  const setName = useSetCustomerRealName();
  const setPhone = useSetCustomerPhone();
  const [dialog, setDialog] = useState<'name' | 'phone' | null>(null);
  const customer = data?.customer;
  const state = audit?.account_state ?? null;
  const realName = state?.real_name ?? null;
  // metadata is Record<string, unknown> — the handle is only renderable once
  // it has been narrowed to a non-empty string.
  const handle = customer?.metadata?.handle;
  const handleLabel = typeof handle === 'string' && handle ? handle : '—';
  const name =
    [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') ||
    '—';
  const reasonField = {
    key: 'reason',
    label: t('playerDetail.reasonAudited'),
  };

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('players.identityTitle')}</Heading>
      </div>
      {isError ? (
        <TableState isError />
      ) : !customer ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : (
        // break-words (inherited by every dd) so a long email or handle wraps
        // instead of widening the 1fr track past the container.
        <dl className="grid grid-cols-[9rem_1fr] items-baseline gap-x-4 gap-y-2 break-words border-t px-6 py-4 text-sm">
          <dt className="text-ui-fg-subtle">{t('players.name')}</dt>
          <dd>{name}</dd>
          <dt className="text-ui-fg-subtle">{t('playerDetail.realName')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span>{realName ?? t('playerDetail.notEntered')}</span>
            {canEdit && (
              <Button
                size="small"
                variant="secondary"
                disabled={setName.isPending}
                onClick={() => setDialog('name')}
              >
                {realName ? t('playerDetail.correct') : t('playerDetail.set')}
              </Button>
            )}
          </dd>
          <dt className="text-ui-fg-subtle">{t('players.email')}</dt>
          <dd>{customer.email}</dd>
          <dt className="text-ui-fg-subtle">{t('players.phone')}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span>{customer.phone ?? '—'}</span>
            <Badge
              size="2xsmall"
              color={state?.phone_verified_at ? 'green' : 'grey'}
            >
              {state?.phone_verified_at
                ? t('playerDetail.phoneVerified')
                : t('playerDetail.phoneUnverified')}
            </Badge>
            {canEdit && (
              <Button
                size="small"
                variant="secondary"
                disabled={setPhone.isPending}
                onClick={() => setDialog('phone')}
              >
                {t('playerDetail.change')}
              </Button>
            )}
          </dd>
          <dt className="text-ui-fg-subtle">{t('players.handle')}</dt>
          <dd>{handleLabel}</dd>
          <dt className="text-ui-fg-subtle">{t('playerDetail.playerId')}</dt>
          <dd className="flex items-center gap-1.5 font-mono text-xs">
            {customer.id}
            <Copy content={customer.id} />
          </dd>
          <dt className="text-ui-fg-subtle">{t('players.registered')}</dt>
          <dd className="tabular-nums">{orderDateTime(customer.created_at)}</dd>
        </dl>
      )}

      {dialog === 'name' && (
        <FieldsDialog
          title={t('playerDetail.realNameTitle')}
          description={t('playerDetail.realNameDesc')}
          fields={[
            {
              key: 'value',
              label: t('playerDetail.realName'),
              initial: realName ?? '',
            },
            reasonField,
          ]}
          onClose={() => setDialog(null)}
          onSubmit={({ value, reason }) => {
            setDialog(null);
            setName.mutate(
              { customerId, realName: value, reason },
              {
                onSuccess: () =>
                  toast.success(t('playerDetail.realNameUpdated')),
                onError: (e) => toast.error(e.message),
              },
            );
          }}
        />
      )}
      {dialog === 'phone' && (
        <FieldsDialog
          title={t('playerDetail.phoneTitle')}
          description={t('playerDetail.phoneDesc')}
          fields={[
            {
              key: 'value',
              label: t('players.phone'),
              initial: customer?.phone ?? '',
              placeholder: '+60123456789',
            },
            {
              key: 'reason',
              label: t('playerDetail.phoneReason'),
            },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={({ value, reason }) => {
            setDialog(null);
            setPhone.mutate(
              { customerId, phone: value, reason },
              {
                onSuccess: () => toast.success(t('playerDetail.phoneUpdated')),
                onError: (e) => toast.error(e.message),
              },
            );
          }}
        />
      )}
    </Container>
  );
};

const AddressesCard = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const { data } = useCustomerDetail(customerId);
  const addresses = data?.customer.addresses;
  if (!addresses) return null;
  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{t('playerDetail.addressesTitle')}</Heading>
      </div>
      {addresses.length === 0 ? (
        <TableState empty={t('playerDetail.noAddresses')} />
      ) : (
        <div className="grid gap-px border-t md:grid-cols-2">
          {addresses.map((a) => (
            <div key={a.id} className="px-6 py-4 text-sm">
              <div className="flex items-center gap-2">
                <span>
                  {[a.first_name, a.last_name].filter(Boolean).join(' ') || '—'}
                </span>
                {a.is_default_shipping && (
                  <Badge size="2xsmall">{t('playerDetail.default')}</Badge>
                )}
              </div>
              <div className="text-ui-fg-subtle mt-1">
                <div>{a.address_1}</div>
                {a.address_2 && <div>{a.address_2}</div>}
                <div>
                  {[a.city, a.province, a.postal_code]
                    .filter(Boolean)
                    .join(' ')}
                </div>
                {a.country_code && <div>{a.country_code.toUpperCase()}</div>}
                {a.phone && <div>{a.phone}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Container>
  );
};

export const ProfileTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const permissions = usePermissions();
  // Full bank numbers ask their own policy (api/admin-rbac.ts SECRET_READS):
  // the view-only Support viewer gets no bank card and no request for it.
  const canSeeBank = permissions.hasPermission(
    'customer_bank_account:read' as Permission,
  );
  const canSeePayments = permissions.hasPermission('payment:read');
  const canEdit = useCanEdit();
  const { data: payout, isError: payoutError } = usePayoutDetails(
    canSeeBank ? customerId : null,
  );

  return (
    <>
      <PlayerDetailsCard customerId={customerId} />
      <AddressesCard customerId={customerId} />
      <GroupCard customerId={customerId} />
      <ReferralCard customerId={customerId} />

      {(canSeeBank || canSeePayments) && (
        <Container className="p-0">
          <div className="px-6 py-4">
            <Heading level="h2">{t('players.bankTitle')}</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              {t('players.bankSubtitle')}
            </Text>
          </div>
          {canSeeBank &&
            (payoutError ? (
              <TableState isError />
            ) : !payout ? (
              <div className="border-t px-6 py-6">
                <LoadingSkeleton />
              </div>
            ) : (
              // Mounted only once the saved row is in hand, so the three inputs can
              // seed from useState initialisers. Seeding an already-mounted form
              // needs an effect, and that effect races the operator's typing on
              // every background refetch.
              <BankForm
                customerId={customerId}
                seed={payout.details}
                readOnly={!canEdit}
              />
            ))}
          {canSeePayments && (
            <LastPayout customerId={customerId} showEmpty={!canSeeBank} />
          )}
        </Container>
      )}
    </>
  );
};
