import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Prompt,
  Select,
  StatusBadge,
  Table,
  Tabs,
  Text,
  toast,
} from '@medusajs/ui';
import { ArrowLeft } from '@medusajs/icons';
import {
  useAdjustCredits,
  useCustomerAudit,
  useCustomerDetail,
  useCustomerGacha,
  useCustomerReferral,
  useCustomerGroupsAdmin,
  useCustomerPulls,
  useCustomerTransactions,
  useDeliveryOrders,
  useFreezeCustomer,
  usePayoutDetails,
  usePulls,
  useSavePayoutDetails,
  useReferralSettings,
  useSetCustomerReferrer,
  useSetPartnerRate,
  useSetPlayerGroup,
  useSpendReport,
  useUnfreezeCustomer,
  type CustomerReferralCard,
} from '../../../lib/queries';
import { deliveryStatusLabel, orderDateTime, rm } from '../../../lib/format';
import type {
  CustomerAudit,
  DeliveryStatus,
  PayoutDetails,
} from '../../../lib/admin-rest';
import { resolveImageUrl } from '../../../lib/image-url';
import {
  effectiveOddsSet,
  isDefaultPlayerGroup,
} from '../../../lib/player-groups';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { PullsTable } from '../../../components/PullsTable';

// ponytail: no config export — keeps route out of sidebar nav (mirrors packs/[slug]/page.tsx)

// StatusBadge tone per delivery status, mirroring the All Orders table. A
// ternary chain rather than a second copy of that page's exhaustive Record: an
// unknown status from the API lands on 'orange' instead of `undefined`.
const deliveryTone = (
  status: DeliveryStatus,
): 'orange' | 'blue' | 'green' | 'grey' =>
  status === 'completed'
    ? 'green'
    : status === 'canceled'
      ? 'grey'
      : status === 'shipped'
        ? 'blue'
        : 'orange';

// Which modal is open. null = none.
type ModalKind = 'freeze' | 'unfreeze' | 'credits';

type TabKey =
  'profile' | 'lvl' | 'wallet' | 'vault' | 'orders' | 'pulls' | 'history';

// ── Tab bodies ──────────────────────────────────────────────────────────────
// One component per tab, following routes/deliveries/page.tsx: an inactive
// tab's queries never fire — the payout details, the credit-ledger page and the
// vaulted-pull page are three requests the operator doesn't pay for until they
// ask for them.
//
// The trade is that a tab body's OWN state resets when the tab unmounts (a
// table offset, an unsaved bank draft — verified, not assumed). State that has
// to outlive a tab switch is therefore held by the parent instead: the modal,
// and History's two table offsets. Nothing here is destructive on reset — the
// bank form only ever writes on an explicit Save.
//
// Each tab body returns its OWN top-level Container(s), not a wrapper <div>:
// the page root is a `flex flex-col gap-y-3`, so a wrapper would swallow the
// gap between a tab's sections (Profile has two, History three).
//
// History is the exception that keeps its queries in the PARENT. The header's
// frozen badge and its Freeze/Unfreeze button read `account_state` off the
// very same /audit response, so that query cannot move down here. This tab is
// a JSX move, nothing else.

const BankForm = ({
  customerId,
  seed,
}: {
  customerId: string;
  seed: PayoutDetails | null;
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
            onChange={(e) => setHolder(e.target.value)}
          />
        </div>
      </div>
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
    </div>
  );
};

/** Move a player between player groups. Exclusive by construction: the Select
 *  holds ONE group and the save posts to the repo-side route that clears the
 *  others, so the operator can never leave a player in two groups whose odds
 *  sets disagree. */
const GroupCard = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const { data: detail, isError: detailError } = useCustomerDetail(customerId);
  const { data: groupList, isError: groupsError } = useCustomerGroupsAdmin();
  // BOTH error flags: the render below falls back to a skeleton on
  // `!groupList || !detail`, so a failed customer-detail request with a healthy
  // group list would sit on that skeleton forever instead of ever reaching the
  // error message.
  const isError = detailError || groupsError;
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
  const current =
    (memberships.find((g) => !isDefaultPlayerGroup(g)) ?? memberships[0])?.id ??
    '';
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
      ) : !groupList || !detail ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
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

// Referral card (rebuild, spec 2026-08-24): who referred them, their direct
// downline, their weekly payout lines, and the partner-rate control. The rate
// REPLACES the tier table for this customer; bounds come from the Referrals
// page settings and are re-enforced server-side.
const ReferralCard = ({ customerId }: { customerId: string }) => {
  const { data, isError } = useCustomerReferral(customerId);

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Referral</Heading>
      </div>
      {isError ? (
        <div className="border-t px-6 py-6">
          <Text size="small" className="text-ui-fg-error">
            Failed to load.
          </Text>
        </div>
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : (
        // Mounted only once the card is in hand so the rate input seeds from
        // its useState initialiser (BankForm precedent).
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
  const { data: settings } = useReferralSettings();
  const setRate = useSetPartnerRate();
  const setReferrer = useSetCustomerReferrer();
  const [referrerInput, setReferrerInput] = useState(
    () => data.referred_by ?? '',
  );
  const [ratePct, setRatePct] = useState(() =>
    data.partner_referral_bp === null
      ? ''
      : String(data.partner_referral_bp / 100),
  );

  const apply = (rateBp: number | null) => {
    const reason = window.prompt('Reason (audited):')?.trim();
    if (!reason) return;
    setRate.mutate(
      { customerId, rateBp, reason },
      {
        onSuccess: () =>
          toast.success(
            rateBp === null ? 'Partner rate cleared.' : 'Partner rate set.',
          ),
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const boundsHint = settings
    ? `${settings.partner_min_bp / 100}–${settings.partner_max_bp / 100}%`
    : '';

  return (
    <div className="border-t px-6 py-4">
      <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm break-words">
        <dt className="text-ui-fg-subtle">Referred by</dt>
        <dd>
          <div className="flex items-center gap-2">
            <Input
              value={referrerInput}
              onChange={(e) => setReferrerInput(e.target.value)}
              placeholder="cus_… (blank = none)"
              className="w-64 font-mono text-xs"
            />
            <Button
              size="small"
              variant="secondary"
              disabled={
                setReferrer.isPending ||
                (referrerInput.trim() || null) === data.referred_by
              }
              onClick={() => {
                const reason = window.prompt('Reason (audited):')?.trim();
                if (!reason) return;
                setReferrer.mutate(
                  {
                    customerId,
                    referrerId: referrerInput.trim() || null,
                    reason,
                  },
                  {
                    onSuccess: () => toast.success('Attribution updated.'),
                    onError: (e) => toast.error(e.message),
                  },
                );
              }}
            >
              Set
            </Button>
          </div>
        </dd>
        <dt className="text-ui-fg-subtle">Direct referrals</dt>
        <dd>{data.downline.length}</dd>
        <dt className="text-ui-fg-subtle">Partner rate</dt>
        <dd>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={ratePct}
              onChange={(e) => setRatePct(e.target.value)}
              placeholder={boundsHint}
              className="w-24"
            />
            <Text size="small" className="text-ui-fg-muted">
              %
            </Text>
            <Button
              size="small"
              variant="secondary"
              disabled={setRate.isPending || ratePct.trim() === ''}
              onClick={() => apply(Math.round(Number(ratePct) * 100))}
            >
              Set
            </Button>
            {data.partner_referral_bp !== null && (
              <Button
                size="small"
                variant="transparent"
                disabled={setRate.isPending}
                onClick={() => {
                  setRatePct('');
                  apply(null);
                }}
              >
                Clear
              </Button>
            )}
          </div>
          {boundsHint && (
            <Text size="xsmall" className="text-ui-fg-muted">
              Allowed range {boundsHint} — replaces the tier table for this
              customer.
            </Text>
          )}
        </dd>
      </dl>
      {data.lines.length > 0 && (
        <div className="mt-4">
          <Text size="small" className="text-ui-fg-subtle">
            Weekly payouts
          </Text>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {data.lines.slice(0, 8).map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <Badge size="2xsmall">
                  {l.kind === 'referral_commission' ? 'Commission' : 'Rebate'}
                </Badge>
                <span className="tabular-nums">{rm(l.amount_cents / 100)}</span>
                <span className="text-ui-fg-muted text-xs">{l.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const ProfileTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  const { data, isError } = useCustomerDetail(customerId);
  const { data: payout, isError: payoutError } = usePayoutDetails(customerId);
  const customer = data?.customer;
  // metadata is Record<string, unknown> — the handle is only renderable once
  // it has been narrowed to a non-empty string.
  const handle = customer?.metadata?.handle;
  const handleLabel = typeof handle === 'string' && handle ? handle : '—';
  const name =
    [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') ||
    '—';

  return (
    <>
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('players.identityTitle')}</Heading>
        </div>
        {isError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !customer ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          // break-words (inherited by every dd) so a long email or handle wraps
          // instead of widening the 1fr track past the container.
          <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 break-words border-t px-6 py-4 text-sm">
            <dt className="text-ui-fg-subtle">{t('players.name')}</dt>
            <dd>{name}</dd>
            <dt className="text-ui-fg-subtle">{t('players.email')}</dt>
            <dd>{customer.email}</dd>
            <dt className="text-ui-fg-subtle">{t('players.phone')}</dt>
            <dd>{customer.phone ?? '—'}</dd>
            <dt className="text-ui-fg-subtle">{t('players.handle')}</dt>
            <dd>{handleLabel}</dd>
            <dt className="text-ui-fg-subtle">{t('players.registered')}</dt>
            <dd className="tabular-nums">
              {orderDateTime(customer.created_at)}
            </dd>
          </dl>
        )}
      </Container>

      {customerId && <GroupCard customerId={customerId} />}

      {customerId && <ReferralCard customerId={customerId} />}

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('players.bankTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('players.bankSubtitle')}
          </Text>
        </div>
        {payoutError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !payout || !customerId ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : (
          // Mounted only once the saved row is in hand, so the three inputs can
          // seed from useState initialisers. Seeding an already-mounted form
          // needs an effect, and that effect races the operator's typing on
          // every background refetch.
          <BankForm customerId={customerId} seed={payout.details} />
        )}
      </Container>
    </>
  );
};

const LvlTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  // Same query key as the header's — served from cache, not a second request.
  const { data: view, isError: viewError } = useCustomerGacha(customerId);
  const { data: detail } = useCustomerDetail(customerId);
  const { data: report, isError: reportError } = useSpendReport(customerId);
  const vip = view?.vip ?? null;
  const next = vip?.next ?? null;
  const periods = report?.periods ?? [];

  // Clamped both ends: a 0 threshold would divide by zero, and spend can sit
  // PAST the next rung's threshold in the window between a qualifying purchase
  // and the level-up saga writing the new projection.
  const pct =
    next && next.threshold > 0
      ? Math.min(100, Math.max(0, (vip!.spend / next.threshold) * 100))
      : 100;

  return (
    <>
      <Container className="p-0">
        {viewError ? (
          <div className="px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !view ? (
          <div className="px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : !vip ? (
          // The ladder is empty or this player has never spent — there is no
          // level to draw, and a "LV 0 / 0% to LV 1" card would be a fiction.
          <div className="px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('players.noLevel')}</Text>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-3 px-6 py-4">
              <Heading level="h1">
                {t('players.levelHeading', { level: vip.level })}
              </Heading>
              <Badge size="small" color="purple">
                {t('customer360.vipPeakLevel', {
                  level: vip.highest_level_ever,
                })}
              </Badge>
            </div>

            <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base md:grid-cols-2">
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t('players.memberSince')}
                </Text>
                <Heading level="h2" className="mt-1 tabular-nums">
                  {detail ? orderDateTime(detail.customer.created_at) : '—'}
                </Heading>
              </div>
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipSpend')}
                </Text>
                <Heading level="h2" className="mt-1 tabular-nums">
                  {rm(vip.spend)}
                </Heading>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t('players.nextTier')}
              </Text>
              {/* Native progress semantics without the element: role+aria give
                  a screen reader the same numbers the bar shows sighted eyes. */}
              <div
                className="bg-ui-bg-subtle h-2 w-full overflow-hidden rounded-full"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                aria-label={t('players.nextTier')}
              >
                <div
                  className="bg-ui-fg-interactive h-full rounded-full"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <Text size="small" className="text-ui-fg-subtle">
                {next
                  ? t('players.toNextLevel', {
                      amount: rm(next.remaining),
                      level: next.level,
                    })
                  : t('players.topTier')}
              </Text>
            </div>
          </>
        )}
      </Container>

      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('players.spendReport')}</Heading>
        </div>
        {reportError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !report ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : periods.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">{t('players.spendEmpty')}</Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label="Turnover report table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('players.period')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.spend')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {periods.map((p) => (
                  <Table.Row key={p.period}>
                    <Table.Cell className="tabular-nums">{p.period}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {rm(p.spend)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </Container>
    </>
  );
};

const WalletTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  // Same query key as the header's — React Query serves it from cache, so this
  // is a read of already-fetched data, not a second request.
  const { data: view } = useCustomerGacha(customerId);
  const { data, isError } = useCustomerTransactions(customerId, page);
  const rows = data?.items ?? [];

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Text size="small" className="text-ui-fg-subtle">
          {t('customer360.balance')}
        </Text>
        <Heading level="h1" className="mt-1 tabular-nums">
          {view ? rm(view.balance) : '—'}
        </Heading>
      </div>

      {isError ? (
        <div className="border-t px-6 py-6">
          <Text size="small" className="text-ui-fg-error">
            Failed to load.
          </Text>
        </div>
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <div className="border-t px-6 py-6">
          <Text className="text-ui-fg-subtle">{t('support.empty')}</Text>
        </div>
      ) : (
        <>
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label="Credit ledger table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('support.when')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('support.reason')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('support.amount')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('support.note')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((tx) => (
                  <Table.Row key={tx.id}>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {orderDateTime(tx.created_at)}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="2xsmall">{tx.reason}</Badge>
                    </Table.Cell>
                    {/* Debits red, credits left at the base colour — same
                        convention as the support desk's ledger. */}
                    <Table.Cell
                      className={`text-right tabular-nums ${tx.amount < 0 ? 'text-ui-fg-error' : ''}`}
                    >
                      {rm(tx.amount)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle max-w-[24rem] truncate">
                      {tx.reference ?? '—'}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <Pager
            page={page}
            onPage={setPage}
            pageSize={25}
            count={rows.length}
            total={data.total}
          />
        </>
      )}
    </Container>
  );
};

const VaultTab = ({ customerId }: { customerId: string | null }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { data: view } = useCustomerGacha(customerId);
  // status:'vaulted' is applied server-side AND keyed, so this never shows a
  // bought-back card and never collides with the support page's full history.
  const { data, isError } = useCustomerPulls(customerId, page, {
    status: 'vaulted',
  });
  const rows = data?.items ?? [];

  return (
    <Container className="p-0">
      <div className="grid grid-cols-1 gap-px bg-ui-border-base md:grid-cols-3">
        <div className="bg-ui-bg-subtle px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('customer360.vault')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? view.vault.count : '—'}
          </Heading>
        </div>
        <div className="bg-ui-bg-subtle px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('players.vaultFmv')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? rm(view.vault.market_value) : '—'}
          </Heading>
        </div>
        <div className="bg-ui-bg-subtle px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            {t('players.vaultPrice')}
          </Text>
          <Heading level="h1" className="mt-1 tabular-nums">
            {view ? rm(view.vault.display_value) : '—'}
          </Heading>
        </div>
      </div>

      {isError ? (
        <div className="border-t px-6 py-6">
          <Text size="small" className="text-ui-fg-error">
            Failed to load.
          </Text>
        </div>
      ) : !data ? (
        <div className="border-t px-6 py-6">
          <LoadingSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <div className="border-t px-6 py-6">
          <Text className="text-ui-fg-subtle">{t('support.empty')}</Text>
        </div>
      ) : (
        <>
          <div
            className="overflow-x-auto border-t"
            tabIndex={0}
            role="region"
            aria-label="Vaulted cards table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('support.card')}</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('players.qty')}
                  </Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    {t('support.value')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>{t('players.pulledAt')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((p) => (
                  <Table.Row key={p.id}>
                    <Table.Cell>
                      <div className="flex items-center gap-3">
                        {/* `?.image` and not just `p.card`: a card row with an
                            empty image would render <img src=""> — which the
                            browser resolves to the page URL and refetches. */}
                        {p.card?.image && (
                          <img
                            src={resolveImageUrl(p.card.image)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-10 w-8 shrink-0 rounded object-contain"
                          />
                        )}
                        <span className="max-w-[20rem] truncate">
                          {p.card?.name ?? '—'}
                        </span>
                      </div>
                    </Table.Cell>
                    {/* One pack open yields one card. */}
                    <Table.Cell className="text-right tabular-nums">
                      1
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {rm(p.card?.market_value ?? null)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {orderDateTime(p.rolled_at)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <Pager
            page={page}
            onPage={setPage}
            pageSize={25}
            count={rows.length}
            total={data.total}
          />
        </>
      )}
    </Container>
  );
};

// Shipping half of the Orders tab: this player's delivery orders, read-only.
// Managing/bulk-editing a shipment stays on the All Orders page — this is the
// player's record of what was sent, not a second place to change it.
const ShippingOrders = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const { data, isError } = useDeliveryOrders(
    undefined,
    page,
    undefined,
    customerId,
  );
  if (isError) {
    return (
      <div className="border-t px-6 py-6">
        <Text size="small" className="text-ui-fg-error">
          Failed to load.
        </Text>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="border-t px-6 py-6">
        <LoadingSkeleton />
      </div>
    );
  }
  const orders = data.orders;
  if (orders.length === 0) {
    return (
      <div className="border-t px-6 py-6">
        <Text className="text-ui-fg-subtle">{t('players.ordersEmpty')}</Text>
      </div>
    );
  }

  return (
    <>
      <div
        className="overflow-x-auto border-t"
        tabIndex={0}
        role="region"
        aria-label="Shipping orders table"
      >
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('players.order')}</Table.HeaderCell>
              <Table.HeaderCell>{t('players.date')}</Table.HeaderCell>
              <Table.HeaderCell>{t('players.items')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('players.qty')}
              </Table.HeaderCell>
              <Table.HeaderCell>{t('players.status')}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {orders.map((o) => (
              <Table.Row key={o.id}>
                <Table.Cell className="font-mono text-xs">
                  #{o.id.slice(-6)}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-xs">
                  {orderDateTime(o.created_at)}
                </Table.Cell>
                {/* First card + a "+N more" tail, same summary the All Orders
                    table shows. The full manifest lives in its Manage modal. */}
                <Table.Cell>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">
                      {o.items[0]?.card?.name ?? o.items[0]?.pull_id ?? '—'}
                    </span>
                    {o.items.length > 1 && (
                      <span className="text-ui-fg-subtle whitespace-nowrap text-xs">
                        +{o.items.length - 1} more
                      </span>
                    )}
                  </span>
                </Table.Cell>
                <Table.Cell className="text-right tabular-nums">
                  {o.items.length}
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge color={deliveryTone(o.status)}>
                    {deliveryStatusLabel(o.status)}
                  </StatusBadge>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <Pager
        page={page}
        onPage={setPage}
        pageSize={data.limit}
        count={orders.length}
        total={data.total}
      />
    </>
  );
};

// Pack purchases half: source='pack', so reward-economy pulls (which are not
// purchases) stay out — same filter the All Orders page applies.
const PackPurchases = ({ customerId }: { customerId: string }) => {
  const [page, setPage] = useState(0);
  const { data, isError } = usePulls(page, 'pack', customerId);

  if (isError) {
    return (
      <div className="border-t px-6 py-6">
        <Text size="small" className="text-ui-fg-error">
          Failed to load.
        </Text>
      </div>
    );
  }
  return (
    <div className="border-t">
      <PullsTable
        pulls={data?.pulls ?? null}
        page={page}
        onPage={setPage}
        limit={data?.limit ?? 50}
        total={data?.total ?? 0}
        showCustomer={false}
      />
    </div>
  );
};

// customerId is a plain string here, not `string | null` like the other tabs:
// usePulls/useDeliveryOrders have no `enabled` flag, so a null id would fetch
// the SITE-WIDE ledger under this player's header. The parent renders these two
// only once the route param is in hand.
const OrdersTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  // Same two-value toggle as the All Orders page. Each half owns its own page
  // offset, so flipping kinds doesn't carry an offset into the other table.
  const [kind, setKind] = useState<'shipping' | 'purchases'>('shipping');

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Tabs
          value={kind}
          onValueChange={(v) => setKind(v as 'shipping' | 'purchases')}
        >
          <Tabs.List aria-label="Order kind">
            <Tabs.Trigger value="shipping">
              {t('players.ordersShipping')}
            </Tabs.Trigger>
            <Tabs.Trigger value="purchases">
              {t('players.ordersPurchases')}
            </Tabs.Trigger>
          </Tabs.List>
        </Tabs>
      </div>
      {kind === 'shipping' ? (
        <ShippingOrders customerId={customerId} />
      ) : (
        <PackPurchases customerId={customerId} />
      )}
    </Container>
  );
};

// The relocated Pull Ledger (spec D6): every pull this player has made, all
// sources, buyback states included.
const PullsTab = ({ customerId }: { customerId: string }) => {
  const [page, setPage] = useState(0);
  const { data, isError } = usePulls(page, undefined, customerId);

  if (isError) {
    return (
      <Container className="p-0">
        <div className="px-6 py-6">
          <Text size="small" className="text-ui-fg-error">
            Failed to load.
          </Text>
        </div>
      </Container>
    );
  }
  return (
    <PullsTable
      pulls={data?.pulls ?? null}
      page={page}
      onPage={setPage}
      limit={data?.limit ?? 50}
      total={data?.total ?? 0}
      showCustomer={false}
    />
  );
};

const HistoryTab = ({
  auditQ,
  auditPage,
  setAuditPage,
}: {
  auditQ: UseQueryResult<CustomerAudit>;
  auditPage: number;
  setAuditPage: (page: number) => void;
}) => {
  const { t } = useTranslation();

  const { data: auditData, isError: auditError } = auditQ;

  const auditActions = (auditData?.actions ?? [])
    // ponytail: belt-and-suspenders — backend already orders DESC; sort client-side to guarantee newest-first regardless of fetch order
    .slice()
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  const accountState = auditData?.account_state ?? null;

  return (
    <>
      {/* ── Audit timeline ──────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-4">
          <Heading level="h2">{t('customer360.auditTitle')}</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            {t('customer360.auditSubtitle')}
          </Text>
        </div>

        {/* Account state panel */}
        {accountState && (
          <div className="border-t px-6 py-4">
            <Text size="small" className="text-ui-fg-subtle mb-2">
              {t('customer360.accountStateTitle')}
            </Text>
            <div className="flex items-center gap-3">
              {accountState.frozen && (
                <Badge size="small" color="red">
                  {t('customer360.accountStateFrozen')}
                </Badge>
              )}
              {accountState.disabled && (
                <Badge size="small" color="red">
                  {t('players.disabled')}
                </Badge>
              )}
              {!accountState.frozen && !accountState.disabled && (
                <Badge size="small" color="green">
                  {t('customer360.accountStateActive')}
                </Badge>
              )}
              {accountState.freeze_cause && (
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.accountStateCause')}:{' '}
                  {accountState.freeze_cause}
                </Text>
              )}
              {accountState.frozen_at && (
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.accountStateSince', {
                    date: new Date(accountState.frozen_at).toLocaleDateString(
                      'en-US',
                    ),
                  })}
                </Text>
              )}
            </div>
            {accountState.freeze_reason && (
              <Text size="small" className="text-ui-fg-subtle mt-1">
                &ldquo;{accountState.freeze_reason}&rdquo;
              </Text>
            )}
            {accountState.disabled && accountState.disabled_at && (
              <Text size="small" className="text-ui-fg-subtle mt-1">
                {t('customer360.accountStateSince', {
                  date: new Date(accountState.disabled_at).toLocaleDateString(
                    'en-US',
                  ),
                })}
                {accountState.disabled_by &&
                  ` · ${t('customer360.accountStateBy', { admin: accountState.disabled_by })}`}
              </Text>
            )}
            {accountState.disabled && accountState.disabled_reason && (
              <Text size="small" className="text-ui-fg-subtle mt-1">
                &ldquo;{accountState.disabled_reason}&rdquo;
              </Text>
            )}
          </div>
        )}

        {auditError ? (
          <div className="border-t px-6 py-6">
            <Text size="small" className="text-ui-fg-error">
              Failed to load.
            </Text>
          </div>
        ) : !auditData ? (
          <div className="border-t px-6 py-6">
            <LoadingSkeleton />
          </div>
        ) : auditActions.length === 0 ? (
          <div className="border-t px-6 py-6">
            <Text className="text-ui-fg-subtle">
              {t('customer360.auditEmpty')}
            </Text>
          </div>
        ) : (
          <>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t('customer360.auditWhen')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.auditAction')}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t('customer360.auditReason')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {auditActions.map((row) => (
                  <Table.Row key={row.id}>
                    <Table.Cell className="text-ui-fg-subtle tabular-nums whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString('en-US')}
                    </Table.Cell>
                    <Table.Cell>
                      {/* ponytail: t() falls back to raw action key if label missing */}
                      {t(`customer360.action.${row.action}`, row.action)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {row.reason ?? '—'}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
            <Pager
              page={auditPage}
              onPage={setAuditPage}
              pageSize={50}
              count={auditActions.length}
              total={null}
            />
          </>
        )}
      </Container>
    </>
  );
};

const Customer360Page = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const customerId = id || null;

  const [tab, setTab] = useState<TabKey>('profile');

  // Offset page for the audit table (the endpoint serves 50/page).
  const [auditPage, setAuditPage] = useState(0);
  // Reset the offset when the viewed customer changes without a remount, so a
  // stale offset can't leak into the next customer's table. Render-phase reset
  // runs before the fetch — no wasted (newId, stalePage) request — and is a
  // harmless no-op if the route does remount.
  const [prevId, setPrevId] = useState(customerId);
  if (customerId !== prevId) {
    setPrevId(customerId);
    setAuditPage(0);
  }

  const { data: view, isError: viewError } = useCustomerGacha(customerId);
  const auditQ = useCustomerAudit(customerId, auditPage);

  const freeze = useFreezeCustomer();
  const unfreeze = useUnfreezeCustomer();
  const adjustCredits = useAdjustCredits();

  // The header's badge and its Freeze/Unfreeze button read the account state
  // off the audit response — which is why that query stays here and not in the
  // History tab body (see the tab-body note above).
  const isFrozen = auditQ.data?.account_state?.frozen ?? false;
  // frozen (funds) and disabled (login) are orthogonal — badge them separately
  // off the same account_state, or a disabled player reads as a normal one.
  const isDisabled = auditQ.data?.account_state?.disabled ?? false;

  // ── Modal state ─────────────────────────────────────────────────────────────
  const [modal, setModal] = useState<ModalKind | null>(null);
  // shared reason field (freeze / unfreeze)
  const [reason, setReason] = useState('');
  // credits-specific fields
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');

  function openModal(kind: ModalKind) {
    setReason('');
    setCreditAmount('');
    setCreditNote('');
    setModal(kind);
  }
  function closeModal() {
    setModal(null);
  }

  // ── Action handlers (called from Prompt.Action) ──────────────────────────
  function applyFreeze() {
    if (!customerId || !reason.trim()) return;
    closeModal();
    freeze.mutate({ id: customerId, reason });
  }

  function applyUnfreeze() {
    if (!customerId || !reason.trim()) return;
    closeModal();
    unfreeze.mutate({ id: customerId, reason });
  }

  function applyAdjustCredits() {
    if (!customerId) return;
    const amount = Number(creditAmount.trim());
    // Reject NaN and a no-op zero adjustment (matches support/page.tsx). Both
    // signs are intended (negative = debit, positive = credit); only exactly 0
    // is meaningless.
    if (!Number.isFinite(amount) || amount === 0) {
      toast.error(t('support.adjustInvalid'));
      return;
    }
    if (!creditNote.trim()) return;
    closeModal();
    adjustCredits.mutate(
      { id: customerId, amount, note: creditNote },
      { onSuccess: () => toast.success('Credits adjusted') },
    );
  }

  // ── Prompt titles / descriptions per modal kind ──────────────────────────
  const MODAL_TITLE: Record<ModalKind, string> = {
    freeze: t('customer360.modalFreezeTitle'),
    unfreeze: t('customer360.modalUnfreezeTitle'),
    credits: t('customer360.modalCreditsTitle'),
  };

  const MODAL_DESC: Record<ModalKind, string> = {
    freeze: t('customer360.modalFreezeDesc'),
    unfreeze: t('customer360.modalUnfreezeDesc'),
    credits: t('customer360.modalCreditsDesc'),
  };

  function handleConfirm() {
    if (modal === 'freeze') applyFreeze();
    else if (modal === 'unfreeze') applyUnfreeze();
    else if (modal === 'credits') applyAdjustCredits();
  }

  // Mirror applyAdjustCredits' validation: Number('abc') is NaN (and 'Infinity'
  // parses), neither === 0, so without the finite check the confirm button lit
  // up for garbage input only to be rejected after the click.
  const creditNum = Number(creditAmount.trim());
  const confirmDisabled =
    modal === 'credits'
      ? !creditAmount.trim() ||
        !Number.isFinite(creditNum) ||
        creditNum === 0 ||
        !creditNote.trim()
      : !reason.trim();

  return (
    <div className="flex flex-col gap-y-3">
      {/* ── Header ─────────────────────────────────────────────── */}
      <Container className="p-0">
        <div className="flex items-start justify-between gap-4 px-6 py-4">
          <div>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-ui-fg-subtle hover:text-ui-fg-base mb-2 flex items-center gap-1 text-sm"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('customer360.back')}
            </button>
            <div className="flex items-center gap-2">
              <Heading level="h2">{view?.customer.email ?? id}</Heading>
              {view?.vip && (
                <Badge size="small" color="purple">
                  {t('customer360.vipLevel', { level: view.vip.level })}
                </Badge>
              )}
              {isFrozen && (
                <Badge size="small" color="red">
                  {t('customer360.frozen')}
                </Badge>
              )}
              {isDisabled && (
                <Badge size="small" color="red">
                  {t('players.disabled')}
                </Badge>
              )}
            </div>
            {view?.customer.created_at && (
              <Text className="text-ui-fg-subtle mt-1" size="small">
                {t('customer360.memberSince', {
                  date: new Date(view.customer.created_at).toLocaleDateString(
                    'en-US',
                  ),
                })}
              </Text>
            )}
            {viewError && (
              <Text size="small" className="text-ui-fg-error mt-1">
                Failed to load.
              </Text>
            )}
          </div>
          {view && (
            <div className="flex items-center gap-2">
              {isFrozen ? (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => openModal('unfreeze')}
                  isLoading={unfreeze.isPending}
                >
                  {t('customer360.btnUnfreeze')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => openModal('freeze')}
                  isLoading={freeze.isPending}
                >
                  {t('customer360.btnFreeze')}
                </Button>
              )}
              <Button
                variant="secondary"
                size="small"
                onClick={() => openModal('credits')}
                isLoading={adjustCredits.isPending}
              >
                {t('customer360.btnAdjustCredits')}
              </Button>
            </div>
          )}
        </div>

        {view && (
          <div className="grid grid-cols-1 gap-px border-t bg-ui-border-base md:grid-cols-3">
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.balance')}
              </Text>
              <Heading level="h1" className="mt-1 tabular-nums">
                {rm(view.balance)}
              </Heading>
            </div>
            <div className="bg-ui-bg-subtle px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                {t('customer360.vault')}
              </Text>
              <Heading level="h1" className="mt-1 tabular-nums">
                {view.vault.count}
              </Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {rm(view.vault.market_value)} FMV
              </Text>
            </div>
            {view.vip && (
              <div className="bg-ui-bg-subtle px-6 py-4">
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipSpend')}
                </Text>
                <Heading level="h1" className="mt-1 tabular-nums">
                  {rm(view.vip.spend)}
                </Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {t('customer360.vipPeakLevel', {
                    level: view.vip.highest_level_ever,
                  })}
                </Text>
              </div>
            )}
          </div>
        )}
      </Container>

      {/* ── Prompt modal — single instance, content varies by modal kind ─── */}
      <Prompt
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open) closeModal();
        }}
      >
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{modal ? MODAL_TITLE[modal] : ''}</Prompt.Title>
            <Prompt.Description>
              {modal ? MODAL_DESC[modal] : ''}
            </Prompt.Description>
          </Prompt.Header>

          <div className="flex flex-col gap-3 px-6 pb-2">
            {modal === 'credits' ? (
              <>
                <div>
                  <Label htmlFor="c360-amount" size="small">
                    {t('support.adjustAmount')}
                  </Label>
                  <Input
                    id="c360-amount"
                    value={creditAmount}
                    placeholder={t('support.adjustAmount')}
                    onChange={(e) => setCreditAmount(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <Label htmlFor="c360-note" size="small">
                    {t('support.adjustNote')}
                  </Label>
                  <Input
                    id="c360-note"
                    value={creditNote}
                    placeholder={t('support.adjustNote')}
                    onChange={(e) => setCreditNote(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor="c360-reason" size="small">
                  {t('customer360.modalReasonLabel')}
                </Label>
                <Input
                  id="c360-reason"
                  value={reason}
                  placeholder={t('customer360.modalReasonPlaceholder')}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                />
              </div>
            )}
          </div>

          <Prompt.Footer>
            <Prompt.Cancel>{t('support.adjustCancel')}</Prompt.Cancel>
            <Prompt.Action onClick={handleConfirm} disabled={confirmDisabled}>
              {t('support.adjustConfirm')}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>

      {/* ── Tabs ───────────────────────────────────────────────── */}
      <Container className="p-0">
        <div className="px-6 py-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <Tabs.List aria-label="Player detail sections">
              <Tabs.Trigger value="profile">
                {t('players.tabProfile')}
              </Tabs.Trigger>
              <Tabs.Trigger value="lvl">{t('players.tabLvl')}</Tabs.Trigger>
              <Tabs.Trigger value="wallet">
                {t('players.tabWallet')}
              </Tabs.Trigger>
              <Tabs.Trigger value="vault">{t('players.tabVault')}</Tabs.Trigger>
              <Tabs.Trigger value="orders">
                {t('players.tabOrders')}
              </Tabs.Trigger>
              <Tabs.Trigger value="pulls">{t('players.tabPulls')}</Tabs.Trigger>
              <Tabs.Trigger value="history">
                {t('players.tabHistory')}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </div>
      </Container>

      {/* key={id}: the tree's "open subtree" button navigates to another
          /customers/:id WITHOUT remounting this route, so without a key a tab
          body would keep the previous player's table offset and — worse — the
          previous player's bank-form draft. */}
      {tab === 'profile' && <ProfileTab key={id} customerId={customerId} />}
      {tab === 'lvl' && <LvlTab key={id} customerId={customerId} />}
      {tab === 'wallet' && <WalletTab key={id} customerId={customerId} />}
      {tab === 'vault' && <VaultTab key={id} customerId={customerId} />}
      {/* Both take a non-null id — see the OrdersTab note. key={id} is what
          makes their keepPreviousData safe: the body remounts on a customer
          change, so there is no previous player's page to hold over. */}
      {tab === 'orders' && customerId && (
        <OrdersTab key={id} customerId={customerId} />
      )}
      {tab === 'pulls' && customerId && (
        <PullsTab key={id} customerId={customerId} />
      )}
      {tab === 'history' && (
        <HistoryTab
          auditQ={auditQ}
          auditPage={auditPage}
          setAuditPage={setAuditPage}
        />
      )}
    </div>
  );
};

export default Customer360Page;
